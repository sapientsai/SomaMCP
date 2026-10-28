// Checks for a tool's `canAccess`, under the names FastMCP gave them, so a server moving off
// it keeps its call sites.
import { Option } from "functype"

import type { SessionAuth } from "../types/core.js"

/** The session's `scopes`, from an array or a Set, else none. */
const scopesOf = (auth: SessionAuth): ReadonlySet<unknown> =>
  Option(auth)
    .map((session) => session.scopes)
    .fold(
      () => new Set<unknown>(),
      (scopes) =>
        Array.isArray(scopes) ? new Set<unknown>(scopes) : scopes instanceof Set ? scopes : new Set<unknown>(),
    )

/** Any signed-in session: `canAccess: requireAuth`. */
export const requireAuth = <T extends SessionAuth>(auth: T): boolean => Option(auth).isSome()

/**
 * A session holding every one of `required` in its `scopes`: `canAccess: requireScopes("Mail.Send")`.
 * With the OAuth providers in `somamcp/node`, `scopes` are what the upstream provider granted.
 */
export const requireScopes =
  <T extends SessionAuth>(...required: ReadonlyArray<string>) =>
  (auth: T): boolean => {
    const held = scopesOf(auth)
    return Option(auth).isSome() && required.every((scope) => held.has(scope))
  }
