import { randomBytes, timingSafeEqual } from "node:crypto"

/** `bytes` random bytes as base64url: for codes, transaction ids, and keys. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url")

/** `bytes` random bytes as hex: for client ids and generated secrets. */
export const randomHex = (bytes = 32): string => randomBytes(bytes).toString("hex")

/**
 * Compare two secrets without leaking, through timing, how much of them matched. Strings
 * of different byte lengths are unequal at once; only their length can leak, never content.
 */
export const sameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  return left.length === right.length && timingSafeEqual(left, right)
}
