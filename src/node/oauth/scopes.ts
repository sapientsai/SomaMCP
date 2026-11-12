// Which scopes the server asks the provider for. At sign-in its configured list is the cap, and on
// a refresh the grant is (grants.ts): a client can narrow but never add. Only the server widens
// a grant, with `widenScopesOnRefresh`. RFC 6749 §3.3 lets the
// server "fully or partially ignore" the scope a client asks for, and the token response reports
// what was granted.
import { List, Option } from "functype"

/** Kept whenever the server's list has them, whatever the client asks for: the id token, and refresh. */
const ALWAYS = List(["openid", "offline_access"])

/** Whether `scope` is one the server keeps whatever a client asks for. */
export const isAlwaysKept = (scope: string): boolean => ALWAYS.contains(scope)

/** A `scope` parameter as a list, without empty parts. */
export const splitScope = (scope: string): ReadonlyArray<string> => scope.split(" ").filter((part) => part !== "")

/** How two spellings of one scope compare: by default, only as the same string. */
export type ScopeKey = (scope: string) => string

const exactly: ScopeKey = (scope) => scope

/**
 * The scopes on `allowed` that the client asked for, plus `openid` and `offline_access` when
 * `allowed` has them, in `allowed`'s order and spelling. `key` decides when a requested scope is
 * one on `allowed`, so the result never holds anything `allowed` doesn't. None when the client
 * asked for nothing on the list.
 */
export const narrowScope = (
  requested: ReadonlyArray<string>,
  allowed: ReadonlyArray<string>,
  key: ScopeKey = exactly,
): Option<string[]> => {
  const asked = List(requested.map(key))
  const wanted = (scope: string): boolean => asked.contains(key(scope))
  if (!allowed.some(wanted)) return Option.none()
  return Option(allowed.filter((scope) => wanted(scope) || ALWAYS.contains(scope)))
}

/** Whether `scopes` holds `scope`, compared by `key`. */
export const holdsScope = (scopes: ReadonlyArray<string>, scope: string, key: ScopeKey = exactly): boolean =>
  scopes.some((held) => key(held) === key(scope))
