// Token storage for the OAuth proxy: in memory, on disk, and an encrypting wrapper.
// Ported from fastmcp 4.22.10 (MIT, src/auth/utils/tokenStore.ts and diskStore.ts).
// The on-disk and encrypted formats are FastMCP's byte for byte, so a store written by
// FastMCP reads back here: see test/fixtures/fastmcp-4.22.10-oauth.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { List, Map, Option, Ref, Try, Tuple } from "functype"

import type { Logger } from "../../types/server.js"

/**
 * Where the OAuth proxy keeps clients, codes, transactions and tokens. Values are
 * JSON-serializable; `ttl` is in seconds, and no ttl means no expiry. `get` and `take`
 * resolve `null` for a missing or expired key, as FastMCP's `TokenStorage` does, so a
 * storage written for FastMCP fits as-is.
 *
 * `take` reads and deletes in one step. Implement it atomically for storage shared by
 * several processes: it is what makes authorization codes and refresh tokens single-use.
 */
export type TokenStorage = {
  cleanup: () => Promise<void>
  delete: (key: string) => Promise<void>
  destroy?: () => void
  get: (key: string) => Promise<unknown>
  save: (key: string, value: unknown, ttl?: number) => Promise<void>
  take?: (key: string) => Promise<unknown>
}

type Entry = { expiresAt: number; value: unknown }

const NEVER = Number.MAX_SAFE_INTEGER
const CLEANUP_INTERVAL_MS = 60_000

const expiryOf = (ttl?: number): number => (ttl ? Date.now() + ttl * 1000 : NEVER)

/** A timer that does not keep the process alive on its own. */
const every = (ms: number, run: () => void): ReturnType<typeof setInterval> => {
  const timer = setInterval(run, ms)
  timer.unref()
  return timer
}

// ── Memory ────────────────────────────────────────────────────────────

/** Storage in this process's memory, lost on restart. The OAuth proxy's default. */
export const createMemoryTokenStorage = (cleanupIntervalMs = CLEANUP_INTERVAL_MS): TokenStorage => {
  const store = Ref(Map.empty<string, Entry>())
  const live = (key: string): Option<Entry> =>
    store
      .get()
      .get(key)
      .filter((entry) => entry.expiresAt >= Date.now())

  const cleanup = (): Promise<void> => {
    const now = Date.now()
    store.set(Map([...store.get()].filter(([, entry]) => entry.expiresAt >= now)))
    return Promise.resolve()
  }
  const timer = every(cleanupIntervalMs, () => void cleanup())

  return {
    cleanup,
    delete: (key) => {
      store.set(store.get().remove(key))
      return Promise.resolve()
    },
    destroy: () => {
      clearInterval(timer)
      store.set(Map.empty())
    },
    get: (key) =>
      Promise.resolve(
        live(key).fold(
          () => {
            store.set(store.get().remove(key))
            return null
          },
          (entry) => entry.value,
        ),
      ),
    save: (key, value, ttl) => {
      store.set(store.get().add(Tuple<[string, Entry]>([key, { expiresAt: expiryOf(ttl), value }])))
      return Promise.resolve()
    },
    // Atomic by construction: the read and the delete run in one synchronous step.
    take: (key) => {
      const entry = live(key)
      store.set(store.get().remove(key))
      return Promise.resolve(
        entry.fold(
          () => null,
          (e) => e.value,
        ),
      )
    },
  }
}

// ── Disk ──────────────────────────────────────────────────────────────

/** `logger` reports unreadable files, as FastMCP's `console.error` did. Defaults to `console`. */
export type DiskStoreOptions = {
  cleanupIntervalMs?: number
  directory: string
  fileExtension?: string
  logger?: Pick<Logger, "error">
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

const parseEntry = (content: string): Option<Entry> => Try(() => JSON.parse(content) as Entry).toOption()

/**
 * One JSON file per key in `directory`, FastMCP's `DiskStore` format: the file name is the
 * key with every character outside `[a-zA-Z0-9_-]` replaced by `_`, and the file holds
 * `{ expiresAt, value }` (epoch ms; `Number.MAX_SAFE_INTEGER` for no expiry). Writes go
 * through a temp file and a rename; `take` claims the file with a rename, which is atomic
 * on POSIX, so processes sharing the directory cannot both redeem one code.
 */
export const createDiskStore = (options: DiskStoreOptions): TokenStorage => {
  const { directory } = options
  const extension = options.fileExtension ?? ".json"
  const logger = options.logger ?? console
  /** A file that does not parse reads as missing, and says so. */
  const parsed = (key: string, text: string): Option<Entry> => {
    const entry = parseEntry(text)
    if (entry.isNone()) logger.error(`[somamcp] Failed to read key ${key}: not a valid entry`)
    return entry
  }
  const pathOf = (key: string): string => join(directory, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}${extension}`)

  const ensureDirectory = async (): Promise<void> => {
    const found = await Try.fromPromise(stat(directory))
    await found.fold(
      async (error) => {
        if (!isMissing(error)) return Promise.reject(error)
        await mkdir(directory, { mode: 0o700, recursive: true })
      },
      async (stats) => {
        if (!stats.isDirectory()) return Promise.reject(new Error(`Path ${directory} exists but is not a directory`))
      },
    )
  }
  const ready = ensureDirectory().catch(() => {})

  const removeIfExpired = async (file: string): Promise<void> => {
    const path = join(directory, file)
    const content = await Try.fromPromise(readFile(path, "utf-8"))
    const expired = content.toOption().flatMap(parseEntry)
    // An unreadable or unparseable file is deleted, as FastMCP does.
    if (
      expired.fold(
        () => true,
        (entry) => entry.expiresAt < Date.now(),
      )
    )
      await rm(path, { force: true })
  }

  const cleanup = async (): Promise<void> => {
    const listed = await Try.fromPromise(ensureDirectory().then(() => readdir(directory)))
    await listed.fold(
      async () => {},
      async (files) => {
        await List(files.filter((file) => file.endsWith(extension))).foldLeft(Promise.resolve())((done, file) =>
          done.then(() => removeIfExpired(file).catch(() => {})),
        )
      },
    )
  }
  const timer = every(options.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS, () => void cleanup())

  const get = async (key: string): Promise<unknown> => {
    await ready
    const path = pathOf(key)
    const content = await Try.fromPromise(readFile(path, "utf-8"))
    return content.fold(
      (error) => {
        if (!isMissing(error)) logger.error(`[somamcp] Failed to read key ${key}:`, error)
        return null
      },
      async (text) =>
        parsed(key, text).fold(
          () => null,
          async (entry) => {
            if (entry.expiresAt >= Date.now()) return entry.value
            await rm(path, { force: true })
            return null
          },
        ),
    )
  }

  const save = async (key: string, value: unknown, ttl?: number): Promise<void> => {
    await ensureDirectory()
    const path = pathOf(key)
    const temp = `${path}.${randomUUID()}.tmp`
    const entry: Entry = { expiresAt: expiryOf(ttl), value }
    const written = await Try.fromPromise(
      writeFile(temp, JSON.stringify(entry, null, 2), { encoding: "utf-8", mode: 0o600 }).then(() =>
        rename(temp, path),
      ),
    )
    if (written.isFailure()) {
      await rm(temp, { force: true })
      return Promise.reject(
        written.fold(
          (error) => error,
          () => undefined,
        ),
      )
    }
  }

  const take = async (key: string): Promise<unknown> => {
    await ready
    const path = pathOf(key)
    const claim = `${path}.${randomUUID()}.claim${extension}`
    const claimed = await Try.fromPromise(rename(path, claim))
    if (claimed.isFailure()) return null
    const content = await Try.fromPromise(readFile(claim, "utf-8"))
    await rm(claim, { force: true })
    return content
      .toOption()
      .flatMap((text) => parsed(key, text))
      .filter((entry) => entry.expiresAt >= Date.now())
      .fold(
        () => null,
        (entry) => entry.value,
      )
  }

  return {
    cleanup,
    // FastMCP swallows a failed delete; the entry still expires.
    delete: (key) => rm(pathOf(key), { force: true }).catch(() => {}),
    destroy: () => clearInterval(timer),
    get,
    save,
    take,
  }
}

// ── Encryption ────────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm"
/** FastMCP's salt. Changing it would make every stored value unreadable. */
const SALT = "fastmcp-oauth-proxy-salt"
const ENCRYPTED = Symbol.for("somamcp/oauth/encrypted-storage")

/** Whether `storage` already encrypts, so the proxy does not wrap it twice. */
export const isEncryptedTokenStorage = (storage: TokenStorage): boolean =>
  (storage as { [ENCRYPTED]?: true })[ENCRYPTED] === true ||
  // FastMCP's own class, should one be passed in.
  storage.constructor.name === "EncryptedTokenStorage"

const encrypt = (plaintext: string, key: Buffer): string => {
  const iv = randomBytes(16)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: 16 })
  const encrypted = cipher.update(plaintext, "utf8", "hex") + cipher.final("hex")
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted}`
}

const decrypt = (ciphertext: string, key: Buffer): Option<string> => {
  const parts = ciphertext.split(":")
  if (parts.length !== 3) return Option.none()
  const [iv, tag, encrypted] = parts as [string, string, string]
  return Try(() => {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "hex"), { authTagLength: 16 })
    decipher.setAuthTag(Buffer.from(tag, "hex"))
    return decipher.update(encrypted, "hex", "utf8") + decipher.final("utf8")
  }).toOption()
}

/**
 * Wraps `backend` so every value is stored as `"<iv hex>:<auth tag hex>:<ciphertext hex>"`:
 * AES-256-GCM over the value's JSON, with a 16-byte IV and tag, and the key derived as
 * `scrypt(encryptionKey, "fastmcp-oauth-proxy-salt", 32)`. That is FastMCP's
 * `EncryptedTokenStorage` format. A value that does not decrypt reads as missing.
 */
export const createEncryptedTokenStorage = (
  backend: TokenStorage,
  encryptionKey: string,
  logger: Pick<Logger, "error"> = console,
): TokenStorage => {
  const key = scryptSync(encryptionKey, Buffer.from(SALT), 32)
  const parseJson = (json: string): Option<unknown> => Try(() => JSON.parse(json) as unknown).toOption()
  // A value that will not decrypt usually means the encryption key changed: every stored
  // sign-in then reads as missing, so say so rather than fail silently.
  const open = (name: string, stored: unknown): unknown => {
    if (stored === null || stored === undefined) return null
    const value = (typeof stored === "string" ? decrypt(stored, key).flatMap(parseJson) : Option.none()).orElse(null)
    if (value === null)
      logger.error(`[somamcp] Failed to decrypt value for ${name}: wrong encryption key, or corrupt data`)
    return value
  }

  return {
    [ENCRYPTED]: true,
    cleanup: () => backend.cleanup(),
    delete: (k) => backend.delete(k),
    destroy: backend.destroy,
    get: async (k) => open(k, await backend.get(k)),
    save: (k, value, ttl) => backend.save(k, encrypt(JSON.stringify(value), key), ttl),
    take: async (k) => {
      if (backend.take) return open(k, await backend.take(k))
      const value = open(k, await backend.get(k))
      await backend.delete(k)
      return value
    },
  } as TokenStorage
}
