// Which claims of the upstream tokens the server copies into the JWTs it issues, so a
// client can read, say, the user's name without calling the provider.
import { List, Option, Try } from "functype"

import type { Logger } from "../../types/server.js"
import { readClaims } from "./jwt.js"

/**
 * - `allow` — copy only these claims.
 * - `block` — never copy these.
 * - `prefix` — rename each copied claim to `<prefix><name>`.
 * - `maxValueLength` — skip a value longer than this, in characters. Defaults to 2000.
 * - `allowObjects` — copy arrays and objects too, within `maxValueLength` as JSON.
 * - `fromAccessToken`, `fromIdToken` — which tokens to read. Both default to true.
 */
export type ClaimsPolicy = {
  allow?: ReadonlyArray<string>
  allowObjects?: boolean
  block?: ReadonlyArray<string>
  fromAccessToken?: boolean
  fromIdToken?: boolean
  maxValueLength?: number
  prefix?: string
}

/** Claims the server sets itself, or that would change how its token is validated. */
const RESERVED = List(["aud", "client_id", "exp", "iat", "iss", "jti", "nbf", "scope", "token_use"])

export type ClaimsCopier = (tokens: { accessToken: string; idToken?: string }) => Option<Record<string, unknown>>

/** `true` copies every simple claim, `false` none. */
export const createClaimsCopier = (policy: boolean | ClaimsPolicy, logger: Pick<Logger, "warn">): ClaimsCopier => {
  if (policy === false) return () => Option.none()
  const rules: ClaimsPolicy = policy === true ? {} : policy
  const maxLength = rules.maxValueLength ?? 2000
  const blocked = List(rules.block ?? [])
  const allowed = Option(rules.allow).map((names) => List(names))
  const rename = (name: string): string => `${rules.prefix ?? ""}${name}`

  const fits = (value: unknown): boolean => {
    if (typeof value === "string") return value.length <= maxLength
    if (typeof value === "number" || typeof value === "boolean") return true
    if (rules.allowObjects !== true || typeof value !== "object" || value === null) return false
    return jsonLength(value) <= maxLength
  }

  const wanted = ([name, value]: [string, unknown]): boolean => {
    if (RESERVED.contains(name) || blocked.contains(name)) return false
    if (allowed.exists((names) => !names.contains(name))) return false
    if (fits(value)) return true
    logger.warn(`[somamcp/oauth] not copying claim "${name}": its value is too large or not a simple value`)
    return false
  }

  const copy = (token: Option<string>, enabled: boolean): Record<string, unknown> =>
    enabled
      ? token
          .flatMap(readClaims)
          .map((claims) => Object.fromEntries(Object.entries(claims).filter(wanted)))
          .orElse({})
      : {}

  return ({ accessToken, idToken }) => {
    const fromAccess = copy(Option(accessToken), rules.fromAccessToken !== false)
    const fromId = copy(Option(idToken), rules.fromIdToken !== false)
    // The access token's claims come first, and win when both tokens carry one.
    const merged = {
      ...fromAccess,
      ...Object.fromEntries(Object.entries(fromId).filter(([name]) => !(name in fromAccess))),
    }
    const names = Object.keys(merged)
    return names.length === 0
      ? Option.none()
      : Option(Object.fromEntries(names.map((name) => [rename(name), merged[name]])))
  }
}

/**
 * The claims of an id token, or `{}` when it cannot be read. The signature is not checked: the server took the id token straight from the
 * provider's token endpoint over TLS, which OpenID Connect Core 1.0 §3.1.3.7 accepts in its place.
 */
export const idTokenClaims = (idToken: string): Record<string, unknown> => readClaims(idToken).orElse({})

/** The length of a value as JSON, or infinity when it cannot be serialized. */
const jsonLength = (value: object): number =>
  Try(() => JSON.stringify(value)).fold(
    () => Number.POSITIVE_INFINITY,
    (text) => text.length,
  )
