// Which scopes the server asks the provider for. Its configured list is the cap: a client can
// narrow the list but never add to it. RFC 6749 §3.3 lets the server "fully or partially ignore"
// the scope a client asks for, and the token response reports what was granted.
import { List, Option } from "functype"

/** Kept whenever the server's list has them, whatever the client asks for: the id token, and refresh. */
const ALWAYS = List(["openid", "offline_access"])

/** A `scope` parameter as a list, without empty parts. */
export const splitScope = (scope: string): ReadonlyArray<string> => scope.split(" ").filter((part) => part !== "")

/**
 * The scopes on `allowed` that the client asked for, plus `openid` and `offline_access` when
 * `allowed` has them, in `allowed`'s order. None when the client asked for nothing on the list.
 */
export const narrowScope = (requested: ReadonlyArray<string>, allowed: ReadonlyArray<string>): Option<string[]> => {
  const asked = List(requested)
  if (!allowed.some((scope) => asked.contains(scope))) return Option.none()
  return Option(allowed.filter((scope) => asked.contains(scope) || ALWAYS.contains(scope)))
}
