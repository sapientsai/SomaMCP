import type { Context, MiddlewareHandler } from "hono"

import { rejectedResponse, runAuthenticate } from "./resolve.js"

/** Callback invoked to authenticate an incoming request, as the web `Request`. */
export type Authenticate = (request: Request) => Promise<unknown>

/**
 * Response builder invoked when auth is missing or fails. Defaults to `401 { error: "Unauthorized" }`.
 * A `Response` that `authenticate` rejects with is served as-is instead, as on the MCP endpoint.
 */
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
    return (await runAuthenticate(() => authenticate(c.req.raw))).fold<Promise<Response | void>>(
      (failure) =>
        Promise.resolve(
          rejectedResponse(failure).fold(
            () => reject(c),
            (response) => response,
          ),
        ),
      () => next(),
    )
  }
}
