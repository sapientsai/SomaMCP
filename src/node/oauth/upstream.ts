// The upstream provider (Microsoft Entra ID, or any OAuth 2.0 server): where the user signs
// in, and the token endpoint the server calls on their behalf.
import type { Either } from "functype"
import { Left, List, Option, Right, Try } from "functype"
import { z } from "zod"

import type { Logger } from "../../types/server.js"
import { OAuthError } from "./errors.js"
import type { UpstreamTokens } from "./records.js"

export type UpstreamConfig = {
  /** Where the user signs in. */
  authorizationEndpoint: string
  /** How the server authenticates to the token endpoint. Defaults to HTTP Basic. */
  clientAuthentication?: "client_secret_basic" | "client_secret_post"
  clientId: string
  clientSecret: string
  /** Extra query parameters for the sign-in URL, such as `prompt`. They cannot replace the OAuth ones. */
  extraAuthorizationParams?: Record<string, string>
  /** Shown to the user, as in "You'll sign in with Microsoft next". */
  name: string
  /** How long to wait for the token endpoint. Defaults to 10 seconds. */
  timeoutMs?: number
  tokenEndpoint: string
}

export type Upstream = {
  /** The sign-in URL for one pending authorization. */
  authorizationUrl: (request: {
    challenge: string
    redirectUri: string
    scope: ReadonlyArray<string>
    state: string
  }) => string
  exchangeCode: (request: {
    code: string
    redirectUri: string
    scope: ReadonlyArray<string>
    verifier: string
  }) => Promise<Either<OAuthError, UpstreamTokens>>
  /** New upstream tokens for a refresh token. Keeps the old refresh token when the provider does not rotate it. */
  refresh: (refreshToken: string, scope: Option<string>) => Promise<Either<OAuthError, UpstreamTokens>>
}

const DEFAULT_TIMEOUT_MS = 10_000

/** Parameters the server sets on the sign-in URL itself; `extraAuthorizationParams` cannot touch them. */
const OWN_PARAMETERS = List([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
])

const positiveInteger = z.coerce.number().int().positive()

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: positiveInteger.optional(),
  id_token: z.string().optional(),
  refresh_expires_in: positiveInteger.optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
})
type TokenResponse = z.infer<typeof tokenResponseSchema>

const errorResponseSchema = z.object({ error: z.string().min(1), error_description: z.string().optional() })

/** A form-encoded body as an object, without empty values (GitHub answers with these). */
const formFields = (text: string): Record<string, string> =>
  Object.fromEntries([...new URLSearchParams(text)].filter(([, value]) => value !== ""))

/** A token response, JSON or form-encoded, or none when it is not a valid one. */
export const parseTokenResponse = async (response: Response): Promise<Option<TokenResponse>> => {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
  const form = contentType.includes("application/x-www-form-urlencoded")
  const decodeBody = (text: string): Option<unknown> =>
    form ? Option<unknown>(formFields(text)) : Try(() => JSON.parse(text) as unknown).toOption()
  const fields = (await Try.fromPromise(response.text())).toOption().flatMap(decodeBody)
  return fields.flatMap((value) => {
    const parsed = tokenResponseSchema.safeParse(value)
    return parsed.success ? Option(parsed.data) : Option.none<TokenResponse>()
  })
}

/** The provider's OAuth error, relayed, or a plain failure when its error body is not one. */
const failureFrom = async (response: Response): Promise<OAuthError> => {
  const body = await Try.fromPromise(response.json() as Promise<unknown>)
  const parsed = body.toOption().flatMap((value) => {
    const error = errorResponseSchema.safeParse(value)
    return error.success ? Option(error.data) : Option.none<z.infer<typeof errorResponseSchema>>()
  })
  return parsed.fold(
    () => OAuthError.providerUnavailable(`The provider answered HTTP ${response.status}.`),
    (error) => OAuthError.providerRejected(error.error, Option(error.error_description)),
  )
}

const isTimeout = (error: Error): boolean => error.name === "TimeoutError" || error.name === "AbortError"

export const createUpstream = (
  config: UpstreamConfig,
  options: {
    defaultAccessTokenLifetime: number
    fetch: (url: string, init: RequestInit) => Promise<Response>
    logger: Pick<Logger, "error">
  },
): Upstream => {
  const basic = (config.clientAuthentication ?? "client_secret_basic") === "client_secret_basic"
  // RFC 6749 §2.3.1: each part is form-encoded before the pair is base64-encoded.
  const basicCredentials = Buffer.from(
    `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`,
  ).toString("base64")

  const toTokens = (
    body: TokenResponse,
    scope: ReadonlyArray<string>,
    previousRefresh: Option<string>,
  ): UpstreamTokens => ({
    accessToken: body.access_token,
    expiresIn: body.expires_in ?? options.defaultAccessTokenLifetime,
    idToken: body.id_token,
    issuedAt: new Date(),
    refreshExpiresIn: body.refresh_expires_in,
    refreshToken: Option(body.refresh_token).or(previousRefresh).orUndefined(),
    scope: Option(body.scope)
      .filter((s) => s !== "")
      .map((s) => s.split(" "))
      .orElse([...scope]),
    tokenType: body.token_type ?? "Bearer",
  })

  const requestTokens = async (
    fields: Record<string, string>,
    scope: ReadonlyArray<string>,
    previousRefresh: Option<string>,
  ): Promise<Either<OAuthError, UpstreamTokens>> => {
    const body = new URLSearchParams(
      basic ? fields : { ...fields, client_id: config.clientId, client_secret: config.clientSecret },
    )
    const sent = await Try.fromPromise(
      options.fetch(config.tokenEndpoint, {
        body,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          ...(basic ? { Authorization: `Basic ${basicCredentials}` } : {}),
        },
        method: "POST",
        signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      }),
    )
    if (sent.isFailure()) {
      const error = sent.fold(
        (e) => e,
        () => new Error("unreachable"),
      )
      if (isTimeout(error)) return Left(OAuthError.providerUnavailable("The provider did not answer in time."))
      options.logger.error("[somamcp/oauth] could not reach the token endpoint:", error)
      return Left(OAuthError.providerUnavailable("The provider could not be reached."))
    }
    const response = sent.orThrow()
    if (!response.ok) return Left(await failureFrom(response))
    return (await parseTokenResponse(response)).fold(
      () => Left(OAuthError.providerUnavailable("The provider sent a token response that could not be read.")),
      (tokens) => Right(toTokens(tokens, scope, previousRefresh)),
    )
  }

  return {
    authorizationUrl: ({ challenge, redirectUri, scope, state }) => {
      const url = new URL(config.authorizationEndpoint)
      Object.entries(config.extraAuthorizationParams ?? {})
        .filter(([name]) => !OWN_PARAMETERS.contains(name))
        .forEach(([name, value]) => url.searchParams.set(name, value))
      url.searchParams.set("client_id", config.clientId)
      url.searchParams.set("redirect_uri", redirectUri)
      url.searchParams.set("response_type", "code")
      url.searchParams.set("state", state)
      if (scope.length > 0) url.searchParams.set("scope", scope.join(" "))
      url.searchParams.set("code_challenge", challenge)
      url.searchParams.set("code_challenge_method", "S256")
      return url.toString()
    },

    exchangeCode: ({ code, redirectUri, scope, verifier }) =>
      requestTokens(
        { code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri },
        scope,
        Option.none(),
      ),

    refresh: (refreshToken, scope) =>
      requestTokens(
        {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          ...scope.fold(
            () => ({}),
            (s) => ({ scope: s }),
          ),
        },
        [],
        Option(refreshToken),
      ),
  }
}
