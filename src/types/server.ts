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
  /**
   * Periodic writes onto an in-flight tool call's own response stream, so a proxy or load
   * balancer does not close the connection as idle while a long-running tool produces no
   * output — a large document read, say.
   *
   * This is the only keepalive that survives `httpStream.stateless`. A transport-level ping
   * needs the standing server-to-client stream, and stateless has none; these travel on the
   * request's own stream instead. If you set `stateless` and have anything with an idle
   * timeout in front of you, you want this too.
   *
   * Set at construction rather than on `httpStream`, because the backend builds its server
   * before `start()` ever sees the transport config.
   *
   * Honoured by the fastmcp backend. The edge backend ignores it — Workers and Deno Deploy
   * terminate the connection themselves, so there is nothing for somamcp to keep alive.
   */
  streamKeepalive?: {
    /** Whether to write keepalives. Opt-in. */
    enabled?: boolean
    /**
     * Gap between keepalives. Keep it comfortably under the shortest idle timeout on the
     * path — an AWS ALB defaults to 60s. Defaults to 20s in the fastmcp backend.
     */
    intervalMs?: number
  }
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
