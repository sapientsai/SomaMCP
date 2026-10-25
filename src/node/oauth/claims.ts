// Copies claims from the upstream tokens into the proxy's JWTs.
// Ported from fastmcp 4.22.10 (MIT, src/auth/utils/claimsExtractor.ts).
import { List, Option } from "functype"

import type { Logger } from "../../types/server.js"
import { decodeJwtPayload } from "./crypto.js"

/**
 * Which upstream claims the proxy copies into the JWTs it issues. `true` (the default)
 * copies every simple claim; `false` copies none.
 */
export type CustomClaimsPassthroughConfig = {
  allowComplexClaims?: boolean
  allowedClaims?: ReadonlyArray<string>
  blockedClaims?: ReadonlyArray<string>
  claimPrefix?: string | false
  fromAccessToken?: boolean
  fromIdToken?: boolean
  maxClaimValueSize?: number
}

/** Claims that would let upstream overwrite the proxy's own JWT fields, `scope` included. */
const PROTECTED_CLAIMS = List(["aud", "client_id", "exp", "iat", "iss", "jti", "nbf", "scope"])

export type ClaimsExtractor = (token: string, tokenType: "access" | "id") => Option<Record<string, unknown>>

export const createClaimsExtractor = (
  option: boolean | CustomClaimsPassthroughConfig,
  logger: Pick<Logger, "warn">,
): ClaimsExtractor => {
  const config: CustomClaimsPassthroughConfig =
    typeof option === "boolean" ? (option ? {} : { fromAccessToken: false, fromIdToken: false }) : option
  const maxSize = config.maxClaimValueSize ?? 2000
  const blocked = List(config.blockedClaims ?? [])
  const allowed = Option(config.allowedClaims).map((claims) => List(claims))
  const prefix = Option(config.claimPrefix).filter((p): p is string => typeof p === "string" && p !== "")

  const isValidValue = (value: unknown): boolean => {
    if (value === null || value === undefined) return false
    if (typeof value === "string") return value.length <= maxSize
    if (typeof value === "number" || typeof value === "boolean") return true
    if (typeof value !== "object" || config.allowComplexClaims !== true) return false
    return Option(JSON.stringify(value)).exists((json) => json.length <= maxSize)
  }

  const keep = ([name, value]: [string, unknown]): boolean => {
    if (PROTECTED_CLAIMS.contains(name) || blocked.contains(name)) return false
    if (allowed.exists((claims) => !claims.contains(name))) return false
    if (isValidValue(value)) return true
    logger.warn(`Skipping claim '${name}' due to invalid value`)
    return false
  }

  return (token, tokenType) => {
    if (tokenType === "access" && config.fromAccessToken === false) return Option.none()
    if (tokenType === "id" && config.fromIdToken === false) return Option.none()
    return decodeJwtPayload(token).map((payload) =>
      Object.fromEntries(
        Object.entries(payload)
          .filter(keep)
          .map(([name, value]) => [
            prefix.fold(
              () => name,
              (p) => `${p}${name}`,
            ),
            value,
          ]),
      ),
    )
  }
}
