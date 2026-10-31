// The token endpoint (RFC 6749 §3.2, §4.1.3, §6), and what the server's tokens stand for.
//
// Clients never see the provider's tokens. The server issues its own JWT pair and keeps the
// provider's tokens in the store: each JWT's `jti` maps to a key under which they live.
// Authorization codes and refresh tokens are single-use, claimed with the store's atomic
// `take`; a refresh that fails puts its token back, so the client can retry it, unless it
// failed because `acceptSignIn` now refuses the account.
//
// With `widenScopesOnRefresh`, a refresh asks the provider for the server's whole list when the grant
// lacks some of it, so scopes added to the list reach people already signed in. Only the server
// widens: a client that names a scope is still held to its grant.
import type { Either } from "functype"
import { Left, Option, Right, Try } from "functype"

import { type ClaimsCopier, idTokenClaims } from "./claims.js"
import type { ClientRegistry } from "./clients.js"
import { OAuthError as Errors, type OAuthError } from "./errors.js"
import { type JwtSigner, type TokenUse, usableAs } from "./jwt.js"
import { verifiesChallenge } from "./pkce.js"
import { type Records, secondsUntil, type TokenGrant, type UpstreamTokens } from "./records.js"
import { isAlwaysKept, narrowScope, splitScope } from "./scopes.js"
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
  /** The reason to refuse a sign-in, given its id token's claims. Checked again on every refresh. */
  acceptSignIn: Option<(claims: Readonly<Record<string, unknown>>) => Option<string>>
  allowPlainPkce: boolean
  /** For upstream tokens that came without an `expires_in`. */
  defaultAccessTokenLifetime: number
  /** For upstream refresh tokens that came without a `refresh_expires_in`. */
  refreshTokenLifetime: number
  /** The server's scopes, for the openid and offline_access a refresh may ask for again. */
  scopes: ReadonlyArray<string>
  /** Ask for all of `scopes` on a refresh whose grant lacks some, and fall back to the grant if refused. */
  widenScopesOnRefresh: boolean
}

export const createGrants = (
  settings: GrantSettings,
  records: Records,
  clients: ClientRegistry,
  upstream: Upstream,
  signer: JwtSigner,
  copyClaims: ClaimsCopier,
  logger: { error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
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
    use: TokenUse,
  ) => {
    const issued = signer.issue({ clientId, extraClaims: extra.orUndefined(), lifetime, scope: tokens.scope, use })
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
    const accessToken = await grantFor(clientId, tokens, key, lifetime, extra, "access")
    const refresh = await refreshLifetime(tokens).fold(
      () => Promise.resolve(Option.none<string>()),
      async (seconds) => Option(await grantFor(clientId, tokens, key, seconds, extra, "refresh")),
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

  /** A completed sign-in or refresh keeps the client longer. Failing to save it never fails either. */
  const keepClient = (clientId: string): Promise<void> =>
    clients.use(clientId).then(
      () => undefined,
      (error: unknown) => logger.error("[somamcp/oauth] could not keep a client after issuing it tokens:", error),
    )

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
    const pair = await issuePair(issued.clientId, issued.upstreamTokens, key)
    await keepClient(issued.clientId)
    return Right(pair)
  }

  /**
   * Why `acceptSignIn` refuses the account behind a refresh, judged on the newest id token. A
   * session signed in without one (no `openid` then) has nothing to judge, and is let through:
   * refusing it would sign out every user of a server that adds `openid` later.
   */
  const refusal = (tokens: UpstreamTokens): Option<string> =>
    settings.acceptSignIn.flatMap((accept) =>
      Option(tokens.idToken).flatMap((idToken) => accept(idTokenClaims(idToken))),
    )

  /** After a failed refresh: save the grant again under its original expiry, so retrying never extends it. */
  const restore = async (grant: TokenGrant): Promise<void> => {
    if (grant.expiresAt.getTime() <= Date.now()) return
    await records.grants.save(grant, secondsUntil(grant.expiresAt))
  }

  /**
   * The provider's refresh, asking for `widened` first when there is one. A provider that refuses
   * it (Microsoft: AADSTS65001, no consent yet) is asked again with `scope`, as without widening.
   */
  const refreshUpstream = async (
    refreshToken: string,
    scope: Option<string>,
    widened: Option<string>,
  ): Promise<Either<OAuthError, UpstreamTokens>> => {
    if (widened.isNone()) return upstream.refresh(refreshToken, scope)
    const wide = await upstream.refresh(refreshToken, widened)
    const declined = wide.fold(
      (error) => Option(error).filter((e) => e._tag === "ProviderRejected"),
      () => Option.none<OAuthError>(),
    )
    if (declined.isNone()) return wide
    logger.warn(
      "[somamcp/oauth] the provider refused the server's scopes on a refresh; asked for the grant's:",
      declined.orUndefined(),
    )
    return upstream.refresh(refreshToken, scope)
  }

  const rotate = async (
    grant: TokenGrant,
    scope: Option<string>,
    widened: Option<string>,
  ): Promise<Either<OAuthError, TokenResponse>> => {
    const stored = await records.upstream.find(grant.upstreamTokenKey)
    if (stored.isNone()) return Left(Errors.invalidGrant("The sign-in behind this refresh token has expired."))
    const current = stored.orThrow()
    const upstreamRefresh = Option(current.refreshToken)
    if (upstreamRefresh.isNone()) return Left(Errors.invalidGrant("The provider issued no refresh token."))
    const refreshed = await refreshUpstream(upstreamRefresh.orElse(""), scope, widened)
    return refreshed.fold(
      (error) => Promise.resolve(Left<OAuthError, TokenResponse>(error)),
      async (fresh) => {
        // A provider that leaves scope or the id token out of a refresh keeps what it granted.
        const tokens = {
          ...fresh,
          idToken: Option(fresh.idToken)
            .filter((idToken) => idToken !== "")
            .or(Option(current.idToken).filter((idToken) => idToken !== ""))
            .orUndefined(),
          scope: fresh.scope.length > 0 ? fresh.scope : current.scope,
        }
        const refused = refusal(tokens)
        if (refused.isSome()) return Left<OAuthError, TokenResponse>(Errors.signInRefused(refused.orElse("")))
        await keepUpstream(grant.upstreamTokenKey, tokens)
        return Right<OAuthError, TokenResponse>(await issuePair(grant.clientId, tokens, grant.upstreamTokenKey))
      },
    )
  }

  /** What a refresh may ask for: the grant's scope, plus openid and offline_access from the server's list. */
  const refreshCap = (granted: ReadonlyArray<string>): ReadonlyArray<string> => [
    ...granted,
    ...settings.scopes.filter((scope) => isAlwaysKept(scope) && !granted.includes(scope)),
  ]

  /**
   * With `widenScopesOnRefresh`, the server's whole list, when the grant lacks any of it other than
   * openid and offline_access (providers often leave those out of what they report granted).
   */
  const widenedScope = (granted: ReadonlyArray<string>): Option<string> =>
    Option(settings.scopes)
      .filter(() => settings.widenScopesOnRefresh)
      .filter((scopes) => scopes.some((scope) => !isAlwaysKept(scope) && !granted.includes(scope)))
      .map((scopes) => scopes.join(" "))

  /** Whether a refresh that failed this way may be tried again with the same token. */
  const retryable = (error: OAuthError): boolean => error._tag !== "SignInRefused"

  const refresh = async (request: TokenRequest): Promise<Either<OAuthError, TokenResponse>> => {
    const claims = signer.verify(request.refreshToken ?? "").filterOrElse(usableAs("refresh"), () => "an access token")
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
    const requested = Option(request.scope)
      .map(splitScope)
      .filter((scope) => scope.length > 0)
    const outcome = await Try.fromPromise(
      rotate(
        grant,
        // RFC 6749 §6: never more than was granted. openid and offline_access may be asked again.
        requested.flatMap((s) => narrowScope(s, refreshCap(grant.scope))).map((scope) => scope.join(" ")),
        // Only a refresh that names no scope is widened: a client never adds to its grant.
        requested.fold(
          () => widenedScope(grant.scope),
          () => Option.none<string>(),
        ),
      ),
    )
    if (outcome.isFailure()) {
      await putBack()
      return outcome.orThrow()
    }
    const result = outcome.orThrow()
    await result.fold(
      (error) => (retryable(error) ? putBack() : Promise.resolve()),
      () => keepClient(grant.clientId),
    )
    return result
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
      .filter(usableAs("access"))
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
