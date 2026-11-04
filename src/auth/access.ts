// Checks for a tool's `canAccess`: FastMCP's requireAuth and requireScopes, under its names and
// with its behaviour. Its requireAll, requireAny and requireRole are not here.
import { Option } from "functype"

import type { SessionAuth } from "../types/core.js"

/**
 * The session's `scopes`: none without a session or a `scopes` field, else its array or Set,
 * and an empty set for any other value. FastMCP read them the same way.
 */
const scopesOf = (auth: SessionAuth): Option<ReadonlySet<unknown>> =>
  Option(auth)
    .flatMap((session) => Option(session.scopes))
    .filter(Boolean)
    .map((scopes) =>
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
  (auth: T): boolean =>
    scopesOf(auth).exists((held) => required.every((scope) => held.has(scope)))

/** The scopes a session holds, as strings. */
export const heldScopes = (auth: SessionAuth): ReadonlyArray<string> =>
  scopesOf(auth).fold(
    () => [],
    (held) => [...held].filter((scope): scope is string => typeof scope === "string"),
  )

/** The scopes on `required` that a session doesn't hold. */
export const missingScopes = (required: ReadonlyArray<string>, auth: SessionAuth): ReadonlyArray<string> => {
  const held = heldScopes(auth)
  return required.filter((scope) => !held.includes(scope))
}
