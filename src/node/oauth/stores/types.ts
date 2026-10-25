/**
 * Where the OAuth server keeps clients, codes, transactions and tokens.
 *
 * Values are JSON-serializable. `ttl` is in seconds, and leaving it out means the entry
 * never expires. `get` and `take` resolve `undefined` (or `null`) for a key that is
 * missing or expired.
 *
 * `take` removes a key and returns its value. Codes and refresh tokens rely on it to be used
 * once, so a store shared between processes should implement it as one atomic operation. A
 * store without it gets `get` followed by `delete`, which two processes can interleave.
 */
export type TokenStore = {
  cleanup: () => Promise<void>
  /** Stop any timers the store runs. */
  close?: () => void
  delete: (key: string) => Promise<void>
  get: (key: string) => Promise<unknown>
  save: (key: string, value: unknown, ttl?: number) => Promise<void>
  take?: (key: string) => Promise<unknown>
}

/** No expiry, as a timestamp. FastMCP's DiskStore writes the same value, so its files and ours agree. */
export const NO_EXPIRY = Number.MAX_SAFE_INTEGER

export const CLEANUP_INTERVAL_MS = 60_000

export const expiresAtFor = (ttl?: number): number => (ttl ? Date.now() + ttl * 1000 : NO_EXPIRY)

/** A repeating timer that never keeps the process alive by itself. */
export const background = (intervalMs: number, run: () => void): (() => void) => {
  const timer = setInterval(run, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
