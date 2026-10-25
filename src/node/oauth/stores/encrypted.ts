import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto"

import { Option, Try } from "functype"

import type { Logger } from "../../../types/server.js"
import type { TokenStore } from "./types.js"

/**
 * The scrypt salt for the encryption key. It is FastMCP's: change it and nothing either
 * server stored can be read again.
 */
const KEY_SALT = "fastmcp-oauth-proxy-salt"
const CIPHER = "aes-256-gcm"
const IV_BYTES = 16
const TAG_BYTES = 16

const MARK = Symbol.for("somamcp/oauth/encrypted-store")

/**
 * Whether `store` already encrypts, so the server does not wrap it a second time. That
 * includes FastMCP's own `EncryptedTokenStorage`, should one be passed in.
 */
export const isEncryptedStore = (store: TokenStore): boolean =>
  (store as { [MARK]?: true })[MARK] === true ||
  Object.getPrototypeOf(store)?.constructor?.name === "EncryptedTokenStorage"

/** `"<iv>:<auth tag>:<ciphertext>"`, all hex. */
const seal = (plaintext: string, key: Buffer): string => {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES })
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("hex")).join(":")
}

const open = (sealed: string, key: Buffer): Option<string> => {
  const parts = sealed.split(":")
  if (parts.length !== 3) return Option.none()
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "hex")) as [Buffer, Buffer, Buffer]
  return Try(() => {
    const decipher = createDecipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES })
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
  }).toOption()
}

/**
 * Wraps `inner` so it only ever sees ciphertext. Each value is serialized to JSON and
 * sealed with AES-256-GCM (16-byte IV, 16-byte tag) under `scrypt(secret, salt, 32)`. This
 * is the format FastMCP's `EncryptedTokenStorage` uses, so either reads what the other wrote.
 *
 * A value that does not open reads as missing and is logged. That almost always means the
 * secret changed, which would otherwise sign every user out with nothing in the logs.
 */
export const createEncryptedStore = (
  inner: TokenStore,
  secret: string,
  logger: Pick<Logger, "error"> = console,
): TokenStore => {
  const key = scryptSync(secret, Buffer.from(KEY_SALT), 32)

  const parseJson = (json: string): Option<unknown> => Try(() => JSON.parse(json) as unknown).toOption()
  const unseal = (sealed: unknown): Option<unknown> =>
    typeof sealed === "string" ? open(sealed, key).flatMap(parseJson) : Option.none()

  const reveal = (name: string, stored: unknown): unknown => {
    if (stored === null || stored === undefined) return undefined
    const value = unseal(stored)
    if (value.isNone())
      logger.error(`[somamcp/oauth] could not decrypt ${name}: the encryption key changed, or the data is corrupt`)
    return value.orUndefined()
  }

  const store: TokenStore & { [MARK]: true } = {
    [MARK]: true,
    cleanup: () => inner.cleanup(),
    close: () => inner.close?.(),
    delete: (name) => inner.delete(name),
    get: async (name) => reveal(name, await inner.get(name)),
    save: (name, value, ttl) => inner.save(name, seal(JSON.stringify(value), key), ttl),
    take: async (name) => {
      if (inner.take) return reveal(name, await inner.take(name))
      const value = reveal(name, await inner.get(name))
      await inner.delete(name)
      return value
    },
  }
  return store
}
