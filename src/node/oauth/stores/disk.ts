import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { List, Option, Try } from "functype"

import type { Logger } from "../../../types/server.js"
import { background, CLEANUP_INTERVAL_MS, expiresAtFor, type TokenStore } from "./types.js"

/** `logger` reports files that cannot be read. Defaults to `console`. */
export type DiskStoreOptions = {
  cleanupIntervalMs?: number
  directory: string
  fileExtension?: string
  logger?: Pick<Logger, "error">
}

/** What each file holds: the value, and when it expires in epoch milliseconds. */
type FileEntry = { expiresAt: number; value: unknown }

const errorCode = (error: unknown): Option<unknown> =>
  typeof error === "object" && error !== null && "code" in error ? Option(error.code) : Option.none()

const isNotFound = (error: unknown): boolean => errorCode(error).exists((code) => code === "ENOENT")

const parseFileEntry = (text: string): Option<FileEntry> =>
  Try(() => JSON.parse(text) as unknown)
    .toOption()
    .filter(
      (entry) =>
        typeof entry === "object" && entry !== null && typeof (entry as { expiresAt?: unknown }).expiresAt === "number",
    )
    .map((entry) => entry as FileEntry)

const isCurrent = (entry: FileEntry): boolean => entry.expiresAt >= Date.now()

/**
 * A store with one JSON file per key in `directory`. The layout is FastMCP's DiskStore's, so
 * a directory either one wrote, the other reads:
 *
 * - The file name is the key with every character outside `[A-Za-z0-9_-]` replaced by `_`,
 *   so a key cannot reach outside the directory.
 * - The file holds `{ "expiresAt": <epoch ms>, "value": <value> }`, with
 *   `Number.MAX_SAFE_INTEGER` for no expiry.
 *
 * Files are created owner-only (0600) in an owner-only directory (0700). A save writes a
 * temporary file and renames it into place, so a reader sees the old value or the new one,
 * never a partial file. `take` first moves the file to a private name; the rename either
 * happens or fails, so of several processes reading the same key, one gets the value.
 */
export const createDiskStore = (options: DiskStoreOptions): TokenStore => {
  const { directory } = options
  const extension = options.fileExtension ?? ".json"
  const logger = options.logger ?? console
  const fileFor = (key: string): string => join(directory, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}${extension}`)

  const ensureDirectory = async (): Promise<void> =>
    (await Try.fromPromise(stat(directory))).fold(
      async (error) => {
        if (!isNotFound(error)) return Promise.reject(error)
        await mkdir(directory, { mode: 0o700, recursive: true })
      },
      (found) =>
        found.isDirectory()
          ? Promise.resolve()
          : Promise.reject(new Error(`${directory} exists and is not a directory`)),
    )
  // Created up front so the first read does not race the first write; a failure resurfaces on save.
  const ready = ensureDirectory().catch(() => {})

  /** A file's entry. A file that exists but does not parse reads as missing, and is reported. */
  const readEntry = async (key: string, file: string): Promise<Option<FileEntry>> => {
    const text = await Try.fromPromise(readFile(file, "utf-8"))
    return text.fold(
      (error) => {
        if (!isNotFound(error)) logger.error(`[somamcp/oauth] could not read ${key}:`, error)
        return Option.none<FileEntry>()
      },
      (content) => {
        const entry = parseFileEntry(content)
        if (entry.isNone()) logger.error(`[somamcp/oauth] ${key} is not a valid store entry`)
        return entry
      },
    )
  }

  const get = async (key: string): Promise<unknown> => {
    await ready
    const file = fileFor(key)
    const entry = await readEntry(key, file)
    if (entry.exists((e) => !isCurrent(e))) await rm(file, { force: true })
    return entry
      .filter(isCurrent)
      .map((e) => e.value)
      .orUndefined()
  }

  const save = async (key: string, value: unknown, ttl?: number): Promise<void> => {
    await ensureDirectory()
    const file = fileFor(key)
    const staging = `${file}.${randomUUID()}.tmp`
    const entry: FileEntry = { expiresAt: expiresAtFor(ttl), value }
    const written = await Try.fromPromise(
      writeFile(staging, JSON.stringify(entry, null, 2), { encoding: "utf-8", mode: 0o600 }).then(() =>
        rename(staging, file),
      ),
    )
    await written.fold(
      async (error) => {
        await rm(staging, { force: true })
        return Promise.reject(error)
      },
      () => Promise.resolve(),
    )
  }

  const take = async (key: string): Promise<unknown> => {
    await ready
    const file = fileFor(key)
    const claim = `${file}.${randomUUID()}.claim${extension}`
    // Whoever renames the file first owns it; everyone else finds it gone.
    const claimed = await Try.fromPromise(rename(file, claim))
    if (claimed.isFailure()) return undefined
    const entry = await readEntry(key, claim)
    await rm(claim, { force: true })
    return entry
      .filter(isCurrent)
      .map((e) => e.value)
      .orUndefined()
  }

  /** Remove a file whose entry has expired, or that is not a valid entry at all. */
  const sweep = async (name: string): Promise<void> => {
    const file = join(directory, name)
    const text = await Try.fromPromise(readFile(file, "utf-8"))
    if (text.isFailure()) return
    const stale = text
      .toOption()
      .flatMap(parseFileEntry)
      .fold(
        () => true,
        (entry) => !isCurrent(entry),
      )
    if (stale) await rm(file, { force: true })
  }

  const cleanup = async (): Promise<void> => {
    const names = await Try.fromPromise(ensureDirectory().then(() => readdir(directory)))
    await names.fold(
      (error) => {
        logger.error("[somamcp/oauth] store cleanup failed:", error)
        return Promise.resolve()
      },
      (all) =>
        List(all.filter((name) => name.endsWith(extension))).foldLeft(Promise.resolve())((previous, name) =>
          previous.then(() => sweep(name).catch(() => {})),
        ),
    )
  }
  const stop = background(options.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS, () => void cleanup())

  return {
    cleanup,
    close: stop,
    // A failed delete only leaves an entry behind until it expires.
    delete: (key) => rm(fileFor(key), { force: true }).catch(() => {}),
    get,
    save,
    take,
  }
}
