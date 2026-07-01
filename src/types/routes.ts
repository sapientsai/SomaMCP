import type { Context as HonoContext } from "hono"

import type { OnUnauthorized } from "../auth/index.js"

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

/**
 * Config for a custom HTTP route registered on the server's Hono app via
 * `SomaServerInstance.addRoute`.
 *
 * When `protected: true`, the server's `authenticate` callback runs first — a
 * throw or rejection short-circuits to `onUnauthorized` (default `401`).
 *
 * ### Route ordering
 *
 * Hono dispatches by registration order. `addRoute` registers immediately, so
 * routes added **before** `start()` land alongside artifacts and introspection
 * routes in call order. For concrete non-overlapping paths this doesn't matter;
 * for wildcards or overlapping prefixes, register earlier to take precedence.
 */
export type RouteConfig = {
  method: RouteMethod | ReadonlyArray<RouteMethod>
  path: `/${string}`
  protected?: boolean
  handler: (c: HonoContext) => Response | Promise<Response>
  onUnauthorized?: OnUnauthorized
}
