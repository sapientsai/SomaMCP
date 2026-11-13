import type { AuthProvider } from "./auth.js"
import type { SessionAuth } from "./core.js"
import type { ToolTracer } from "./tracing.js"

// ── Logger ────────────────────────────────────────────────────────────

export type Logger = {
  debug: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  log: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

// ── Server Config ─────────────────────────────────────────────────────

/**
 * `instructions` as a function of the caller's session. Declared as a method, so its parameter
 * is checked bivariantly and `ServerConfig<T>` stays assignable as `T` widens, as it was when
 * `instructions` could only be a string.
 */
export type SessionInstructions<T extends SessionAuth = SessionAuth> = {
  bivariant(session: T | undefined): string | Promise<string>
}["bivariant"]

export type ServerConfig<T extends SessionAuth = SessionAuth> = {
  /**
   * Authenticate a request; resolve to the session that tools see as `context.session`.
   * Rejecting, throwing, or resolving to `undefined`/`null` fails it with a 401. On the
   * MCP endpoint, reject with a `Response` to send that instead; protected artifacts and
   * routes answer with their `onUnauthorized`, or 401.
   *
   * Receives the web `Request` for MCP calls and for protected artifacts and routes, on
   * every runtime. On stdio there is no request: it is called once with `undefined`, and
   * a failure serves without a session. Read headers with `getRequestHeader`.
   */
  authenticate?: (request: Request | undefined) => Promise<T>
  /**
   * Authentication that brings its own routes and 401 challenge, such as an OAuth server.
   * See `AuthProvider`.
   */
  auth?: AuthProvider<T>
  /**
   * What the server tells a client about itself when it connects: in the `initialize` result
   * (2025 clients) and the `server/discover` result (2026-07-28 clients).
   *
   * A function gets the caller's session, so each one can get its own, such as its owner's
   * conventions. With no `authenticate`, and on stdio without one, it gets `undefined`. On
   * stdio it runs once per connection. Over HTTP it runs per request: on 2026-07-28 clients
   * only for `server/discover`, and on 2025 clients for every request, because their method
   * is only in the body. Cache in it if the lookup is costly. An empty string means none.
   *
   * If it throws or rejects, that request fails (HTTP 500 for `server/discover`, a JSON-RPC
   * internal error for a 2025 client), so a client never connects with instructions missing.
   */
  instructions?: string | SessionInstructions<T>
  logger?: Logger
  /**
   * Largest MCP request body, in bytes, the server reads. A larger one is answered `413`
   * before it is parsed. Raise it for tools that take large inline arguments, such as a
   * base64-encoded file. Must be positive. Defaults to the SDK's 4 MiB.
   *
   * Set at construction for the same reason as `streamKeepalive`.
   */
  maxRequestBodySize?: number
  name: string
  /**
   * Opens a span around each tool call, such as `createOtelTracer()` from `somamcp/otel`.
   * A call the server refuses with a 401 or 403 before it reaches the tool handler gets none.
   */
  tracer?: ToolTracer
  /**
   * Periodic writes onto an in-flight tool call's own response stream, so a proxy or load
   * balancer does not close the connection as idle while a long-running tool produces no
   * output — a large document read, say.
   *
   * They are SSE comment frames on the request's own stream, so they work although the
   * server keeps no sessions. With this on, every response streams as SSE, because a JSON
   * response cannot carry them.
   *
   * Set at construction rather than on `httpStream`, because the backend builds its handler
   * before `start()` ever sees the transport config.
   */
  streamKeepalive?: {
    /** Whether to write keepalives. Opt-in. */
    enabled?: boolean
    /**
     * Gap between keepalives. Keep it comfortably under the shortest idle timeout on the
     * path — an AWS ALB defaults to 60s. Defaults to 20s.
     */
    intervalMs?: number
  }
  version: `${number}.${number}.${number}`
}

// ── Transport Config ──────────────────────────────────────────────────

/**
 * Options for listening on a port, which needs `somamcp/node`. `port` is the only
 * required field.
 *
 * - `cors` — `true` for permissive defaults, or options for Hono's `cors()`. Only
 *   relevant for browser-facing servers.
 * - `enableJsonResponse` — answer `2026-07-28` requests with JSON instead of SSE.
 *   It turns `streamKeepalive` off, since JSON cannot carry keepalive frames.
 * - `endpoint` — the MCP path. Defaults to `/mcp`.
 * - `host` — the address to bind. Defaults to `localhost`; set `0.0.0.0` in a container.
 * - `stateless` — serving is always stateless; `false` logs a warning and is ignored.
 * - `sslCert` / `sslKey` / `sslCa` — inline PEM strings enabling TLS termination
 *   at the server. Omit for plain HTTP behind a proxy.
 */
export type HttpStreamConfig = {
  cors?: boolean | Record<string, unknown>
  enableJsonResponse?: boolean
  endpoint?: `/${string}`
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
