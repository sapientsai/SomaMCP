import type { SessionAuth } from "./core.js"
import type { RouteConfig } from "./routes.js"

/**
 * The rejected MCP request a provider builds its 401 for.
 *
 * - `endpoint` — the MCP path, e.g. `/mcp`. It moves with `start({ httpStream: { endpoint } })`.
 * - `error` — what `authenticate` threw or rejected with. Absent when it resolved to no session.
 * - `requestId` — the JSON-RPC `id` of the request, or `null` when it carried none (a `GET`,
 *   a batch, or a body that could not be read).
 */
export type AuthChallenge = {
  endpoint: string
  error?: unknown
  requestId: string | number | null
}

/**
 * Authentication with its own HTTP surface, such as an OAuth server: `createServer({ auth })`.
 *
 * - `authenticate` — resolve the session tools see as `context.session`, or `undefined` when
 *   the request carries no valid credentials. An explicit `authenticate` option takes
 *   precedence, as in FastMCP.
 * - `challenge` — the response to an MCP request that failed authentication, such as a 401
 *   with a `WWW-Authenticate` header. Only the MCP endpoint uses it; protected artifacts and
 *   routes still answer with their `onUnauthorized`, or 401. Without it, the endpoint answers
 *   a plain 401.
 * - `routes` — unprotected HTTP routes the provider serves, such as OAuth metadata and
 *   endpoints. `endpoint` reads the current MCP path.
 */
export type AuthProvider<T extends SessionAuth = SessionAuth> = {
  // eslint-disable-next-line functype/prefer-option -- consumer-facing callback; see the note in types/core.ts on why public types stay plain
  authenticate: (request: Request | undefined) => Promise<T | undefined>
  challenge?: (challenge: AuthChallenge) => Response | Promise<Response>
  routes?: (endpoint: () => string) => ReadonlyArray<RouteConfig>
}
