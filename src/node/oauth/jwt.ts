// The server's own access and refresh tokens: HS256 JWTs (RFC 7519).
//
// The format is fixed by the tokens already in clients' hands. FastMCP signed them, so a
// token verifies here when it has the header {"alg":"HS256","typ":"JWT"}, carries `jti`,
// `exp`, `iss` and `aud`, and is signed with HMAC-SHA256 over the signing secret's raw UTF-8
// bytes. Tokens issued here add `token_use`, so an access token can't stand in for a refresh
// token or the other way round (RFC 8725 §3.12). FastMCP's tokens have none, so they are
// accepted in either role until the first refresh replaces them.
import { createHmac, randomBytes } from "node:crypto"

import type { Either } from "functype"
import { Left, Option, Right, Try } from "functype"

import { sameSecret } from "./secrets.js"

export type TokenUse = "access" | "refresh"

export type TokenClaims = {
  readonly [claim: string]: unknown
  readonly aud: string
  readonly client_id: string
  readonly exp: number
  readonly iat: number
  readonly iss: string
  readonly jti: string
  readonly scope: ReadonlyArray<string>
  readonly token_use?: unknown
}

export type TokenToIssue = {
  clientId: string
  /** Claims copied from the upstream tokens. They never replace the claims above. */
  extraClaims?: Record<string, unknown>
  lifetime: number
  scope: ReadonlyArray<string>
  use: TokenUse
}

export type JwtSigner = {
  issue: (token: TokenToIssue) => { jti: string; token: string }
  /** The claims of a token this server issued and that has not expired, or why not. */
  verify: (token: string) => Either<string, TokenClaims>
}

const HEADER = { alg: "HS256", typ: "JWT" } as const
const encodedHeader = Buffer.from(JSON.stringify(HEADER)).toString("base64url")

const decodeSegment = (segment: string): Option<Record<string, unknown>> =>
  Try(() => JSON.parse(Buffer.from(segment, "base64url").toString("utf-8")) as unknown)
    .toOption()
    .filter((value) => typeof value === "object" && value !== null && !Array.isArray(value))
    .map((value) => value as Record<string, unknown>)

/** A JWT's claims, read without checking its signature. Only for tokens from a trusted party. */
export const readClaims = (token: string): Option<Record<string, unknown>> => {
  const segments = token.split(".")
  return segments.length === 3 ? decodeSegment(segments[1] ?? "") : Option.none()
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

const checkClaims =
  (issuer: string) =>
  (claims: Record<string, unknown>): Either<string, TokenClaims> => {
    if (typeof claims.exp !== "number" || claims.exp <= nowSeconds()) return Left("expired")
    if (claims.iss !== issuer) return Left("wrong issuer")
    if (claims.aud !== issuer) return Left("wrong audience")
    if (typeof claims.jti !== "string" || claims.jti === "") return Left("no token id")
    return Right(claims as TokenClaims)
  }

/** Whether a token may be used as `use`: it says so, or it predates `token_use` (FastMCP's). */
export const usableAs =
  (use: TokenUse) =>
  (claims: TokenClaims): boolean =>
    claims.token_use === undefined || claims.token_use === use

/** Signs and verifies tokens whose issuer and audience are both `issuer`, the server's base URL. */
export const createJwtSigner = (issuer: string, secret: string): JwtSigner => {
  const key = Buffer.from(secret, "utf8")
  const signature = (input: string): string => createHmac("sha256", key).update(input).digest("base64url")

  const issue = ({ clientId, extraClaims, lifetime, scope, use }: TokenToIssue) => {
    const iat = nowSeconds()
    const jti = randomBytes(16).toString("base64url")
    const claims = {
      aud: issuer,
      client_id: clientId,
      exp: iat + lifetime,
      iat,
      iss: issuer,
      jti,
      scope,
      ...extraClaims,
      token_use: use,
    }
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
    return { jti, token: `${encodedHeader}.${payload}.${signature(`${encodedHeader}.${payload}`)}` }
  }

  const verify = (token: string): Either<string, TokenClaims> => {
    const segments = token.split(".")
    if (segments.length !== 3) return Left("not a JWT")
    const [header, payload, sig] = segments as [string, string, string]
    if (!sameSecret(sig, signature(`${header}.${payload}`))) return Left("bad signature")
    const algorithm = decodeSegment(header).map((h) => h.alg)
    if (!algorithm.exists((alg) => alg === HEADER.alg)) return Left("unsupported algorithm")
    return decodeSegment(payload).fold(() => Left<string, TokenClaims>("unreadable claims"), checkClaims(issuer))
  }

  return { issue, verify }
}
