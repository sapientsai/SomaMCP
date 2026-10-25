// The token endpoint (RFC 6749 §3.2, §4.1.3, §6), and what the server's tokens stand for.
//
// Clients never see the provider's tokens. The server issues its own JWT pair and keeps the
// provider's tokens in the store: each JWT's `jti` maps to a key under which they live.
// Authorization codes and refresh tokens are single-use, claimed with the store's atomic
// `take`; a refresh that fails puts its token back, so the client can retry it.
import type { Either } from "functype"
import { Left, Option, Right, Try } from "functype"

import type { ClaimsCopier } from "./claims.js"
import type { ClientRegistry } from "./clients.js"
import { OAuthError as Errors, type OAuthError } from "./errors.js"
import type { JwtSigner } from "./jwt.js"
import { verifiesChallenge } from "./pkce.js"
import { type Records, secondsUntil, type TokenGrant, type UpstreamTokens } from "./records.js"
import { randomToken } from "./secrets.js"
import type { Upstream } from "./upstream.js"

export type TokenRequest = {
  clientId: string
  code?: string
  codeVerifier?: string
  grantType: string
  refreshToken?: string
  scope?: string
}

export type TokenResponse = {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope: string
  token_type: "Bearer"
}

export type GrantSettings = {
  allowPlainPkce: boolean
  /** For upstream tokens that came without an `expires_in`. */
  defaultAccessTokenLifetime: number
  /** For upstream refresh tokens that came without a `refresh_expires_in`. */
  refreshTokenLifetime: number
}

export const createGrants = (
  settings: GrantSettings,
  records: Records,
  clients: ClientRegistry,
  upstream: Upstream,
  signer: JwtSigner,
  copyClaims: ClaimsCopier,
  logger: { error: (...args: unknown[]) => void },
) => {
  const accessLifetime = (tokens: UpstreamTokens): number =>
    tokens.expiresIn > 0 ? tokens.expiresIn : settings.defaultAccessTokenLifetime

  const refreshLifetime = (tokens: UpstreamTokens): Option<number> =>
    Option(tokens.refreshToken).map(() => tokens.refreshExpiresIn ?? settings.refreshTokenLifetime)

  /** Keep the upstream tokens as long as any token standing for them can still be used. */
  const keepUpstream = (key: string, tokens: UpstreamTokens): Promise<void> =>
    records.upstream.save(key, tokens, Math.max(accessLifetime(tokens), refreshLifetime(tokens).orElse(0), 1))

  const grantFor = async (
    clientId: string,
    tokens: UpstreamTokens,
    key: string,
    lifetime: number,
    extra: Option<Record<string, unknown>>,
  ) => {
    const issued = signer.issue({ clientId, extraClaims: extra.orUndefined(), lifetime, scope: tokens.scope })
    const grant: TokenGrant = {
      clientId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + lifetime * 1000),
      jti: issued.jti,
      scope: tokens.scope,
      upstreamTokenKey: key,
    }
    await records.grants.save(grant, lifetime)
    return issued.token
  }

  /** An access token, and a refresh token when the provider gave one, both standing for `key`. */
  const issuePair = async (clientId: string, tokens: UpstreamTokens, key: string): Promise<TokenResponse> => {
    const extra = copyClaims({ accessToken: tokens.accessToken, idToken: tokens.idToken })
    const lifetime = accessLifetime(tokens)
    const accessToken = await grantFor(clientId, tokens, key, lifetime, extra)
    const refresh = await refreshLifetime(tokens).fold(
      () => Promise.resolve(Option.none<string>()),
      async (seconds) => Option(await grantFor(clientId, tokens, key, seconds, extra)),
    )
    return {
      access_token: accessToken,
      expires_in: lifetime,
      ...refresh.fold(
        () => ({}),
        (token) => ({ refresh_token: token }),
      ),
      scope: tokens.scope.join(" "),
      token_type: "Bearer",
    }
  }

  const redeemCode = async (request: TokenRequest): Promise<Either<OAuthError, TokenResponse>> => {
    if (request.clientId === "" || (await clients.find(request.clientId)).isNone())
      return Left(Errors.unknownClient(request.clientId))
    const code = request.code ?? ""
    const redemption = await records.codes.redeem(code)
    if (redemption.isNone()) return Left(Errors.invalidGrant("The authorization code is invalid or has expired."))
    const claimed = redemption.orThrow()
    // Written back whatever happens next, so a second attempt is told the code was used.
    await records.codes.spend(code, claimed._tag === "Active" ? claimed.code.expiresAt : claimed.expiresAt)
    if (claimed._tag === "Spent") return Left(Errors.invalidGrant("The authorization code was already used."))

    const issued = claimed.code
    if (issued.clientId !== request.clientId)
      return Left(Errors.invalidGrant("The authorization code was issued to another client."))
    if (issued.codeChallenge === "") return Left(Errors.invalidGrant("The authorization code was issued without PKCE."))
    const verifier = request.codeVerifier ?? ""
    if (verifier === "") return Left(Errors.invalidRequest("The request needs a code_verifier."))
    if (issued.codeChallengeMethod === "plain" && !settings.allowPlainPkce)
      return Left(Errors.invalidGrant('The code was issued for PKCE "plain", which is no longer allowed.'))
    if (!verifiesChallenge(verifier, issued.codeChallenge, issued.codeChallengeMethod))
      return Left(Errors.invalidGrant("The code_verifier does not match the code_challenge."))

    const key = randomToken()
    await keepUpstream(key, issued.upstreamTokens)
    return Right(await issuePair(issued.clientId, issued.upstreamTokens, key))
  }

  /** After a failed refresh: save the grant again under its original expiry, so retrying never extends it. */
  const restore = async (grant: TokenGrant): Promise<void> => {
    if (grant.expiresAt.getTime() <= Date.now()) return
    await records.grants.save(grant, secondsUntil(grant.expiresAt))
  }

  const rotate = async (grant: TokenGrant, scope: Option<string>): Promise<Either<OAuthError, TokenResponse>> => {
    const stored = await records.upstream.find(grant.upstreamTokenKey)
    if (stored.isNone()) return Left(Errors.invalidGrant("The sign-in behind this refresh token has expired."))
    const current = stored.orThrow()
    const upstreamRefresh = Option(current.refreshToken)
    if (upstreamRefresh.isNone()) return Left(Errors.invalidGrant("The provider issued no refresh token."))
    const refreshed = await upstream.refresh(upstreamRefresh.orElse(""), scope)
    return refreshed.fold(
      (error) => Promise.resolve(Left<OAuthError, TokenResponse>(error)),
      async (fresh) => {
        // A provider that leaves scope out of a refresh keeps the scope it granted.
        const tokens = fresh.scope.length > 0 ? fresh : { ...fresh, scope: current.scope }
        await keepUpstream(grant.upstreamTokenKey, tokens)
        return Right<OAuthError, TokenResponse>(await issuePair(grant.clientId, tokens, grant.upstreamTokenKey))
      },
    )
  }

  const refresh = async (request: TokenRequest): Promise<Either<OAuthError, TokenResponse>> => {
    const claims = signer.verify(request.refreshToken ?? "")
    if (claims.isLeft()) return Left(Errors.invalidGrant("The refresh token is invalid or has expired."))
    const jti = claims.fold(
      () => "",
      (c) => c.jti,
    )
    const claimed = await records.grants.take(jti)
    if (claimed.isNone()) return Left(Errors.invalidGrant("The refresh token was already used or has expired."))
    const grant = claimed.orThrow()
    const putBack = (): Promise<void> =>
      restore(grant).catch((error: unknown) => {
        logger.error("[somamcp/oauth] could not put back a refresh token after a failed refresh:", error)
      })
    if (request.clientId !== "" && request.clientId !== grant.clientId) {
      await putBack()
      return Left(Errors.invalidGrant("The refresh token was issued to another client."))
    }
    const outcome = await Try.fromPromise(
      rotate(
        grant,
        Option(request.scope).filter((s) => s !== ""),
      ),
    )
    if (outcome.isFailure() || outcome.orThrow().isLeft()) await putBack()
    return outcome.orThrow()
  }

  const token = (request: TokenRequest): Promise<Either<OAuthError, TokenResponse>> => {
    if (request.grantType === "authorization_code") return redeemCode(request)
    if (request.grantType === "refresh_token") return refresh(request)
    return Promise.resolve(Left(Errors.unsupportedGrantType(request.grantType)))
  }

  /** The upstream tokens behind one of the server's access tokens, if it is valid and current. */
  const resolve = async (bearer: string): Promise<Option<UpstreamTokens>> => {
    const jti = signer
      .verify(bearer)
      .toOption()
      .map((claims) => claims.jti)
    if (jti.isNone()) return Option.none()
    const grant = await records.grants.find(jti.orElse(""))
    return grant.fold(
      () => Promise.resolve(Option.none<UpstreamTokens>()),
      (g) => records.upstream.find(g.upstreamTokenKey),
    )
  }

  return { resolve, token }
}
