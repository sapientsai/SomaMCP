// JWTs, PKCE and constant-time comparison for the OAuth proxy.
// Ported from fastmcp 4.22.10 (MIT, src/auth/utils/jwtIssuer.ts, pkce.ts, constantTime.ts).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import type { Either } from "functype"
import { Left, Option, Right, Try } from "functype"

export const DEFAULT_ACCESS_TOKEN_TTL = 3600
export const DEFAULT_ACCESS_TOKEN_TTL_NO_REFRESH = 31_536_000
export const DEFAULT_REFRESH_TOKEN_TTL = 2_592_000

export const equalsConstantTime = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  return left.length === right.length && timingSafeEqual(left, right)
}

export const randomId = (bytes = 32): string => randomBytes(bytes).toString("base64url")
export const randomHex = (bytes = 32): string => randomBytes(bytes).toString("hex")

// ── JWT ───────────────────────────────────────────────────────────────

export type JwtClaims = {
  [claim: string]: unknown
  aud: string
  client_id: string
  exp: number
  iat: number
  iss: string
  jti: string
  scope: ReadonlyArray<string>
}

export type JwtIssuerConfig = {
  accessTokenTtl?: number
  audience: string
  issuer: string
  refreshTokenTtl?: number
  /** Used as raw UTF-8 bytes for HMAC-SHA256, as FastMCP does. */
  signingKey: string
}

export type JwtIssuer = {
  issueAccessToken: (
    clientId: string,
    scope: ReadonlyArray<string>,
    additionalClaims?: Record<string, unknown>,
    expiresIn?: number,
  ) => string
  issueRefreshToken: (
    clientId: string,
    scope: ReadonlyArray<string>,
    additionalClaims?: Record<string, unknown>,
    expiresIn?: number,
  ) => string
  /** The token's claims, or why it is invalid: format, signature, expiry, issuer or audience. */
  verify: (token: string) => Either<string, JwtClaims>
}

const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")

/**
 * HS256 JWTs in FastMCP's `JWTIssuer` format: the header `{"alg":"HS256","typ":"JWT"}`, the
 * claims `aud, client_id, exp, iat, iss, jti, scope` followed by any additional claims, and a
 * base64url HMAC-SHA256 over the raw signing key. Tokens FastMCP issued verify here.
 */
export const createJwtIssuer = (config: JwtIssuerConfig): JwtIssuer => {
  const key = Buffer.from(config.signingKey)
  const accessTtl = config.accessTokenTtl ?? DEFAULT_ACCESS_TOKEN_TTL
  const refreshTtl = config.refreshTokenTtl ?? DEFAULT_REFRESH_TOKEN_TTL
  const sign = (data: string): string => createHmac("sha256", key).update(data).digest("base64url")

  const issue =
    (defaultTtl: number) =>
    (
      clientId: string,
      scope: ReadonlyArray<string>,
      additionalClaims?: Record<string, unknown>,
      expiresIn?: number,
    ): string => {
      const now = Math.floor(Date.now() / 1000)
      const claims = {
        aud: config.audience,
        client_id: clientId,
        exp: now + (expiresIn ?? defaultTtl),
        iat: now,
        iss: config.issuer,
        jti: randomBytes(16).toString("base64url"),
        scope,
        ...additionalClaims,
      }
      const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
      return `${HEADER}.${payload}.${sign(`${HEADER}.${payload}`)}`
    }

  const verify = (token: string): Either<string, JwtClaims> => {
    const parts = token.split(".")
    if (parts.length !== 3) return Left("Invalid token format")
    const [header, payload, signature] = parts as [string, string, string]
    if (!signature || !equalsConstantTime(signature, sign(`${header}.${payload}`))) return Left("Invalid signature")
    return Try(() => JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as JwtClaims)
      .toEither((error) => error.message)
      .flatMap((claims) => {
        if (claims.exp <= Math.floor(Date.now() / 1000)) return Left<string, JwtClaims>("Token expired")
        if (claims.iss !== config.issuer) return Left<string, JwtClaims>("Invalid issuer")
        if (claims.aud !== config.audience) return Left<string, JwtClaims>("Invalid audience")
        return Right<string, JwtClaims>(claims)
      })
  }

  return { issueAccessToken: issue(accessTtl), issueRefreshToken: issue(refreshTtl), verify }
}

/** A JWT's payload, decoded without verifying its signature. */
export const decodeJwtPayload = (token: string): Option<Record<string, unknown>> => {
  const parts = token.split(".")
  return parts.length === 3
    ? Try(() => JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf-8")) as unknown)
        .toOption()
        .filter((payload) => typeof payload === "object" && payload !== null)
        .map((payload) => payload as Record<string, unknown>)
    : Option.none()
}

// ── PKCE ──────────────────────────────────────────────────────────────

export type PkcePair = { challenge: string; verifier: string }

export const pkceChallenge = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url")

/** A 128-character verifier and its S256 challenge. */
export const generatePkcePair = (): PkcePair => {
  const verifier = randomBytes(96).toString("base64url").slice(0, 128)
  return { challenge: pkceChallenge(verifier), verifier }
}

export const validatePkce = (verifier: string, challenge: string, method: string): boolean => {
  if (!verifier || !challenge) return false
  if (method === "plain") return equalsConstantTime(verifier, challenge)
  if (method === "S256") return equalsConstantTime(pkceChallenge(verifier), challenge)
  return false
}
