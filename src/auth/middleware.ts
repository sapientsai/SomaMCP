import { Option, Try } from "functype"
import type { Context, MiddlewareHandler } from "hono"

/** Callback invoked to authenticate an incoming request, as the web `Request`. */
export type Authenticate = (request: Request) => Promise<unknown>

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
    // Sync throws and nullish results fail too, matching the MCP endpoint.
    const result = await Try.fromPromise(
      Promise.resolve()
        .then(() => authenticate(c.req.raw))
        .then((auth) => Option(auth).orThrow(new Error("Authentication required"))),
    )
    if (result.isFailure()) {
      return reject(c)
    }
    await next()
  }
}
