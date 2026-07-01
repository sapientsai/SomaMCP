import type { SessionAuth } from "./core.js"

// ── Logger ────────────────────────────────────────────────────────────

export type Logger = {
  debug: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  log: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

// ── Server Config ─────────────────────────────────────────────────────

export type ServerConfig<T extends SessionAuth = SessionAuth> = {
  authenticate?: (request: unknown) => Promise<T>
  instructions?: string
  logger?: Logger
  name: string
  version: `${number}.${number}.${number}`
}

// ── Transport Config ──────────────────────────────────────────────────

/**
 * httpStream transport options. All fields are passed through to the underlying
 * MCP backend unchanged; `port` is the only one required.
 *
 * - `cors` — `true` for permissive defaults, or a config object forwarded to the
 *   backend's CORS implementation. Only relevant for browser-facing servers.
 * - `stateless` — treat each request independently (no session state). Useful
 *   for horizontally-scaled or Lambda-style deployments.
 * - `eventStore` — pluggable store enabling resumable event streams; the
 *   backend's `EventStore` interface, opaque to somamcp.
 * - `sslCert` / `sslKey` / `sslCa` — inline PEM strings enabling TLS termination
 *   at the server. Omit for plain HTTP behind a proxy.
 */
export type HttpStreamConfig = {
  cors?: boolean | Record<string, unknown>
  enableJsonResponse?: boolean
  endpoint?: `/${string}`
  eventStore?: unknown
  host?: string
  port: number
  sslCa?: string
  sslCert?: string
  sslKey?: string
  stateless?: boolean
}

export type TransportConfig =
  | { transportType: "stdio" }
  | {
      httpStream: HttpStreamConfig
      transportType: "httpStream"
    }
