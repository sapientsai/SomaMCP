// The browser half of the flow (RFC 6749 §4.1): the client sends the user to
// /oauth/authorize, the user approves on the consent page, signs in with the provider, and
// comes back through /oauth/callback with a code for the client.
//
// Errors follow one rule. Until the client and its redirect URI are verified, an error is
// shown to the user, because redirecting to an unverified URI is an open redirect. Once they
// are, the error goes back to the client on its redirect URI (RFC 6749 §4.1.2.1), so the
// app can tell the user what happened.
import type { Either } from "functype"
import { Left, Option, Right } from "functype"

import { idTokenClaims } from "./claims.js"
import type { ClientRegistry } from "./clients.js"
import { OAuthError as Errors, type OAuthError, toWireError } from "./errors.js"
import { createPkcePair, isPkceMethod } from "./pkce.js"
import type { PendingAuthorization, Records, UpstreamTokens } from "./records.js"
import { randomToken } from "./secrets.js"
import type { Upstream } from "./upstream.js"

/** What the consent page shows. Everything except `transactionId` is for the user's eyes. */
export type ConsentScreen = {
  /** Where the form posts. */
  action: string
  /** The name the client registered with. Anyone can register any name, so it is shown as a claim. */
  clientName: Option<string>
  /** The provider the user signs in with next. */
  provider: string
  /** The host the user returns to, which is the part of the client's identity that is verified. */
  returnsTo: string
  scope: ReadonlyArray<string>
  transactionId: string
}

export type BrowserStep =
  | { readonly _tag: "Redirect"; readonly location: string }
  | { readonly _tag: "Consent"; readonly screen: ConsentScreen }

export type AuthorizationSettings = {
  /** The reason to refuse a sign-in, given its id token's claims. */
  acceptSignIn: (claims: Readonly<Record<string, unknown>>) => Option<string>
  allowPlainPkce: boolean
  authorizationCodeLifetime: number
  /** `<baseUrl>/oauth/callback`: the redirect URI registered with the provider. */
  callbackUrl: string
  consentRequired: boolean
  /** The server's base URL, sent back as `iss` (RFC 9207) when `sendIssuer` is on. */
  issuer: string
  providerName: string
  scopes: ReadonlyArray<string>
  sendIssuer: boolean
  transactionLifetime: number
}

const redirect = (location: string): BrowserStep => ({ _tag: "Redirect", location })

const hostOf = (uri: string): string => new URL(uri).host

export const createAuthorization = (
  settings: AuthorizationSettings,
  records: Records,
  clients: ClientRegistry,
  upstream: Upstream,
) => {
  const secondsFromNow = (seconds: number): Date => new Date(Date.now() + seconds * 1000)

  /** Back to the client's redirect URI with `params`, its `state`, and `iss` when enabled. */
  const toClient = (redirectUri: string, state: string, params: Record<string, string>): BrowserStep => {
    const url = new URL(redirectUri)
    Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, value))
    if (state !== "") url.searchParams.set("state", state)
    if (settings.sendIssuer) url.searchParams.set("iss", settings.issuer)
    return redirect(url.toString())
  }

  const errorToClient = (redirectUri: string, state: string, error: OAuthError): BrowserStep => {
    const wire = toWireError(error)
    return toClient(redirectUri, state, {
      error: wire.code,
      ...wire.description.fold(
        () => ({}),
        (description) => ({ error_description: description }),
      ),
    })
  }

  const toProvider = (request: PendingAuthorization): BrowserStep =>
    redirect(
      upstream.authorizationUrl({
        challenge: request.proxyCodeChallenge,
        redirectUri: settings.callbackUrl,
        scope: request.scope,
        state: request.id,
      }),
    )

  /** The client still lists the redirect URI the request will return to. */
  const stillRegistered = async (request: PendingAuthorization): Promise<boolean> =>
    (await clients.find(request.clientId)).exists((client) => client.redirectUris.includes(request.clientCallbackUrl))

  /** Why a verified request cannot proceed, if it cannot. */
  const pkceProblem = (challenge: Option<string>, method: string): Option<OAuthError> => {
    if (challenge.isNone()) return Option(Errors.invalidRequest("PKCE is required: send a code_challenge."))
    if (!isPkceMethod(method))
      return Option(Errors.invalidRequest(`The code_challenge_method "${method}" is not supported.`))
    if (method === "plain" && !settings.allowPlainPkce)
      return Option(Errors.invalidRequest('The code_challenge_method "plain" is not allowed; use "S256".'))
    return Option.none()
  }

  const authorize = async (params: Partial<Record<string, string>>): Promise<Either<OAuthError, BrowserStep>> => {
    const clientId = params.client_id ?? ""
    const redirectUri = params.redirect_uri ?? ""
    if (clientId === "" || redirectUri === "")
      return Left(Errors.invalidRequest("The request needs a client_id and a redirect_uri."))
    const client = await clients.find(clientId)
    if (client.isNone()) return Left(Errors.unknownClient(clientId))
    if (!client.exists((c) => c.redirectUris.includes(redirectUri)))
      return Left(Errors.invalidRequest("That redirect_uri is not registered for this client."))

    // Verified from here on: errors go back to the client.
    const state = params.state ?? ""
    const responseType = params.response_type ?? ""
    if (responseType !== "code")
      return Right(errorToClient(redirectUri, state, Errors.unsupportedResponseType(responseType)))
    const challenge = Option(params.code_challenge).filter((c) => c !== "")
    // RFC 7636 §4.3: a challenge without a method is "plain".
    const method = params.code_challenge_method ?? "plain"
    const problem = pkceProblem(challenge, method)
    if (problem.isSome()) return Right(errorToClient(redirectUri, state, problem.orThrow()))

    const ownPkce = createPkcePair()
    const request: PendingAuthorization = {
      clientCallbackUrl: redirectUri,
      clientCodeChallenge: challenge.orElse(""),
      clientCodeChallengeMethod: method,
      clientId,
      createdAt: new Date(),
      expiresAt: secondsFromNow(settings.transactionLifetime),
      id: randomToken(),
      proxyCodeChallenge: ownPkce.challenge,
      proxyCodeVerifier: ownPkce.verifier,
      scope: Option(params.scope)
        .map((s) => s.split(" ").filter((part) => part !== ""))
        .filter((parts) => parts.length > 0)
        .orElse([...settings.scopes]),
      state,
    }
    await records.pending.save(request)
    if (!settings.consentRequired) return Right(toProvider(request))
    return Right({
      _tag: "Consent",
      screen: {
        action: `${settings.issuer}/oauth/consent`,
        clientName: client
          .flatMap((c) => Option(c.metadata?.client_name))
          .map((name) => name.trim())
          .filter((name) => name !== ""),
        provider: settings.providerName,
        returnsTo: hostOf(redirectUri),
        scope: request.scope,
        transactionId: request.id,
      },
    })
  }

  /** The user's answer on the consent page. */
  const decide = async (form: URLSearchParams): Promise<Either<OAuthError, BrowserStep>> => {
    const action = form.get("action")
    if (action !== "approve" && action !== "deny")
      return Left(Errors.invalidRequest('The consent form must answer "approve" or "deny".'))
    const transactionId = form.get("transaction_id") ?? ""
    if (transactionId === "") return Left(Errors.invalidRequest("The consent form has no transaction_id."))
    const found = await records.pending.find(transactionId)
    if (found.isNone())
      return Left(Errors.invalidRequest("This sign-in request has expired. Start again from your app."))
    const request = found.orThrow()
    if (action === "approve") {
      const approved = { ...request, consentGiven: true }
      await records.pending.save(approved)
      return Right(toProvider(approved))
    }
    await records.pending.delete(transactionId)
    if (!(await stillRegistered(request)))
      return Left(Errors.invalidRequest("The client no longer lists this redirect URI."))
    return Right(
      toClient(request.clientCallbackUrl, request.state, {
        error: "access_denied",
        error_description: "The user declined to authorize the app.",
      }),
    )
  }

  const issueCode = async (request: PendingAuthorization, tokens: UpstreamTokens): Promise<BrowserStep> => {
    const code = randomToken()
    await records.codes.save({
      clientId: request.clientId,
      code,
      codeChallenge: request.clientCodeChallenge,
      codeChallengeMethod: request.clientCodeChallengeMethod,
      createdAt: new Date(),
      expiresAt: secondsFromNow(settings.authorizationCodeLifetime),
      transactionId: request.id,
      upstreamTokens: tokens,
    })
    return toClient(request.clientCallbackUrl, request.state, { code })
  }

  /** Issue the client its code, unless `acceptSignIn` refuses who signed in. */
  const finish = (
    request: PendingAuthorization,
    tokens: UpstreamTokens,
    back: (error: OAuthError) => BrowserStep,
  ): Promise<BrowserStep> =>
    Option(tokens.idToken)
      .flatMap((idToken) => settings.acceptSignIn(idTokenClaims(idToken)))
      .fold(
        () => issueCode(request, tokens),
        (reason) => Promise.resolve(back(Errors.providerRejected("access_denied", Option(reason)))),
      )

  /** The provider sends the user back here, with a code or with an error. */
  const callback = async (url: URL): Promise<Either<OAuthError, BrowserStep>> => {
    const state = url.searchParams.get("state") ?? ""
    if (state === "") return Left(Errors.invalidRequest("The provider's response has no state."))
    // Consumed whatever the outcome, so one sign-in cannot be completed twice.
    const found = await records.pending.take(state)
    if (found.isNone()) return Left(Errors.invalidRequest("This sign-in request has expired or was already completed."))
    const request = found.orThrow()
    if (!(await stillRegistered(request)))
      return Left(Errors.invalidRequest("The client no longer lists this redirect URI."))
    // Without consent on record, the user was sent to the provider some other way than the consent page.
    if (settings.consentRequired && request.consentGiven !== true)
      return Left(Errors.invalidRequest("This sign-in request was not approved on the consent page."))

    const back = (error: OAuthError): BrowserStep => errorToClient(request.clientCallbackUrl, request.state, error)
    const providerError = Option(url.searchParams.get("error")).filter((e) => e !== "")
    if (providerError.isSome())
      return Right(
        back(
          Errors.providerRejected(
            providerError.orElse(""),
            Option(url.searchParams.get("error_description")).filter((d) => d !== ""),
          ),
        ),
      )
    const code = Option(url.searchParams.get("code")).filter((c) => c !== "")
    if (code.isNone())
      return Right(back(Errors.providerUnavailable("The provider returned neither a code nor an error.")))

    const exchanged = await upstream.exchangeCode({
      code: code.orElse(""),
      redirectUri: settings.callbackUrl,
      scope: request.scope,
      verifier: request.proxyCodeVerifier,
    })
    return exchanged.fold(
      (error) => Promise.resolve(Right<OAuthError, BrowserStep>(back(error))),
      async (tokens) => Right<OAuthError, BrowserStep>(await finish(request, tokens, back)),
    )
  }

  return { authorize, callback, decide }
}
