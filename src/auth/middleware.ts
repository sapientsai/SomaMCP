import { Option, Try } from "functype"
import type { Context, MiddlewareHandler } from "hono"

/**
 * Callback invoked to authenticate an incoming request. Receives either a Hono
 * `Request` (custom routes / protected artifacts) or an `http.IncomingMessage`
 * (MCP transport). Use `getRequestHeader` to hide the shape difference.
 */
export type Authenticate = (request: unknown) => Promise<unknown>

/** Response builder invoked when auth is missing or fails. Defaults to `401 { error: "Unauthorized" }`. */
export type OnUnauthorized = (c: Context) => Response | Promise<Response>

export type AuthMiddlewareConfig = {
  authenticate?: Authenticate
  onUnauthorized?: OnUnauthorized
}

const defaultUnauthorized = (c: Context): Response => c.json({ error: "Unauthorized" }, 401)

export const createAuthMiddleware = ({ authenticate, onUnauthorized }: AuthMiddlewareConfig): MiddlewareHandler => {
  const reject = onUnauthorized ?? defaultUnauthorized

  return async (c, next) => {
    if (!authenticate) {
      return reject(c)
    }
    const req = Option(c.env as { incoming?: unknown } | null)
      .flatMap((e) => Option(e.incoming))
      .orElse(c.req.raw)
    const result = await Try.fromPromise(authenticate(req))
    if (result.isFailure()) {
      return reject(c)
    }
    await next()
  }
}
