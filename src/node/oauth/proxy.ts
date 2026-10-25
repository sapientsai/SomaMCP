// An OAuth 2.1 authorization server that fronts an upstream provider: dynamic client
// registration, PKCE, a consent screen, and token swap (clients get the proxy's own JWTs;
// the upstream tokens stay in encrypted storage).
// Ported from fastmcp 4.22.10 (MIT, src/auth/OAuthProxy.ts), token-swap mode only.
import type { Either } from "functype"
import { Left, List, Option, Right, Try } from "functype"
import { z } from "zod"

import type { Logger } from "../../types/server.js"
import { type ClaimsExtractor, createClaimsExtractor, type CustomClaimsPassthroughConfig } from "./claims.js"
import { consentHtml } from "./consent.js"
import {
  createJwtIssuer,
  DEFAULT_ACCESS_TOKEN_TTL,
  DEFAULT_ACCESS_TOKEN_TTL_NO_REFRESH,
  DEFAULT_REFRESH_TOKEN_TTL,
  generatePkcePair,
  randomHex,
  randomId,
  validatePkce,
} from "./crypto.js"
import { createStateStore, type OAuthTransaction, type RegisteredClient, type UpstreamTokenSet } from "./state.js"
import {
  createEncryptedTokenStorage,
  createMemoryTokenStorage,
  isEncryptedTokenStorage,
  type TokenStorage,
} from "./storage.js"

export const DEFAULT_AUTHORIZATION_CODE_TTL = 300
export const DEFAULT_TRANSACTION_TTL = 600
export const DEFAULT_UPSTREAM_REQUEST_TIMEOUT_MS = 10_000

/**
 * FastMCP's `OAuthProxyConfig`, less what is not ported: CIMD (`enableCimd`), passthrough
 * mode (`enableTokenSwap: false`). Defaults are FastMCP's.
 *
 * - `allowedRedirectUriPatterns` — glob patterns (`*`, `?`) a client's redirect URI must
 *   match. Unset allows `http://localhost:*` and `http://127.0.0.1:*` only; `[]` allows none.
 * - `consentSigningKey` — accepted for FastMCP compatibility. FastMCP 4.22.10 never uses it
 *   on this path, and neither does this port.
 * - `encryptionKey` — encrypts stored tokens. Unset generates one per process, so stored
 *   tokens do not survive a restart; `false` stores them in the clear.
 * - `fetch` — for the upstream token endpoint. Defaults to the global `fetch`.
 * - `jwtSigningKey` — signs the JWTs clients receive. Unset generates one per process.
 */
export type OAuthProxyConfig = {
  accessTokenTtl?: number
  allowedRedirectUriPatterns?: ReadonlyArray<string>
  allowPlainPkce?: boolean
  authorizationCodeTtl?: number
  authorizationResponseIss?: boolean
  baseUrl: string
  consentRequired?: boolean
  consentSigningKey?: string
  customClaimsPassthrough?: boolean | CustomClaimsPassthroughConfig
  encryptionKey?: string | false
  extraAuthorizationParams?: Record<string, string>
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  forwardPkce?: boolean
  jwtSigningKey?: string
  logger?: Pick<Logger, "error" | "warn">
  redirectPath?: string
  refreshTokenTtl?: number
  scopes?: ReadonlyArray<string>
  tokenStorage?: TokenStorage
  transactionTtl?: number
  upstreamAuthorizationEndpoint: string
  upstreamClientId: string
  upstreamClientSecret: string
  upstreamRequestTimeoutMs?: number
  upstreamTokenEndpoint: string
  upstreamTokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post"
}

/** An OAuth error, answered as `{ error, error_description }` with `statusCode`. */
export type OAuthProxyError = { code: string; description?: string; statusCode: number }

export const oauthError = (code: string, description?: string, statusCode = 400): OAuthProxyError => ({
  code,
  description,
  statusCode,
})

export const oauthErrorBody = (error: OAuthProxyError): { error: string; error_description?: string } => ({
  error: error.code,
  error_description: error.description,
})

/** Resolves an OAuth error as Left; anything unexpected (storage, network) rejects. */
export type OAuthResult<A> = Promise<Either<OAuthProxyError, A>>

export type AuthorizationRequest = Partial<Record<string, string>>

export type TokenRequest = {
  client_id: string
  client_secret?: string
  code?: string
  code_verifier?: string
  grant_type: string
  redirect_uri?: string
  refresh_token?: string
  scope?: string
}

export type TokenResponse = {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope: string
  token_type: "Bearer"
}

export type ClientRegistrationRequest = {
  client_name?: string
  client_uri?: string
  contacts?: ReadonlyArray<string>
  grant_types?: ReadonlyArray<string>
  jwks?: Record<string, unknown>
  jwks_uri?: string
  logo_uri?: string
  policy_uri?: string
  redirect_uris?: ReadonlyArray<string>
  response_types?: ReadonlyArray<string>
  scope?: string
  software_id?: string
  software_version?: string
  token_endpoint_auth_method?: string
  tos_uri?: string
}

export type AuthorizationServerMetadata = {
  authorizationEndpoint: string
  authorizationResponseIssParameterSupported?: true
  codeChallengeMethodsSupported: ReadonlyArray<string>
  grantTypesSupported: ReadonlyArray<string>
  issuer: string
  registrationEndpoint: string
  responseTypesSupported: ReadonlyArray<string>
  scopesSupported: ReadonlyArray<string>
  tokenEndpoint: string
  tokenEndpointAuthMethodsSupported: ReadonlyArray<string>
}

export type { UpstreamTokenSet } from "./state.js"

export type OAuthProxy = {
  authorize: (params: AuthorizationRequest) => OAuthResult<Response>
  destroy: () => void
  exchangeAuthorizationCode: (request: TokenRequest) => OAuthResult<TokenResponse>
  exchangeRefreshToken: (request: TokenRequest) => OAuthResult<TokenResponse>
  getAuthorizationServerMetadata: () => AuthorizationServerMetadata
  /** The upstream provider's host, shown on the consent screen. */
  getProviderName: () => string
  handleCallback: (request: Request) => OAuthResult<Response>
  handleConsent: (form: URLSearchParams) => OAuthResult<Response>
  /** The upstream tokens behind one of the proxy's access tokens, or none. */
  loadUpstreamTokens: (token: string) => Promise<Option<UpstreamTokenSet>>
  registerClient: (request: ClientRegistrationRequest) => OAuthResult<Record<string, unknown>>
}

type TokenMapping = {
  clientId: string
  createdAt: Date | string
  expiresAt: Date | string
  jti: string
  scope: ReadonlyArray<string>
  upstreamTokenKey: string
}

const RESERVED_AUTHORIZATION_PARAMS = List([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
])

const upstreamTokenResponseSchema = z.object({
  access_token: z.string().min(1, "access_token cannot be empty"),
  expires_in: z.coerce.number().int().positive().optional(),
  id_token: z.string().optional(),
  refresh_expires_in: z.coerce.number().int().positive().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
})
type UpstreamTokenResponse = z.infer<typeof upstreamTokenResponseSchema>

const fail = <A>(code: string, description?: string): Either<OAuthProxyError, A> => Left(oauthError(code, description))

const redirect = (location: string): Response => new Response(null, { headers: { Location: location }, status: 302 })

const optionalNumber = (params: URLSearchParams, name: string): Option<number> =>
  Option(params.get(name)).map((v) => Number.parseInt(v, 10))

/** Glob match: `*` is any run of characters, `?` is one. */
const matchesPattern = (uri: string, pattern: string): boolean =>
  new RegExp(
    `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === "*" ? ".*" : char === "?" ? "." : `\\${char}`))}$`,
  ).test(uri)

export const createOAuthProxy = (input: OAuthProxyConfig): OAuthProxy => {
  const config = {
    allowPlainPkce: true,
    authorizationCodeTtl: DEFAULT_AUTHORIZATION_CODE_TTL,
    authorizationResponseIss: true,
    consentRequired: true,
    redirectPath: "/oauth/callback",
    transactionTtl: DEFAULT_TRANSACTION_TTL,
    upstreamRequestTimeoutMs: DEFAULT_UPSTREAM_REQUEST_TIMEOUT_MS,
    upstreamTokenEndpointAuthMethod: "client_secret_basic" as const,
    ...input,
  }
  const logger = config.logger ?? console
  const fetchUpstream = config.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const callbackUrl = `${config.baseUrl}${config.redirectPath}`

  // A storage the proxy creates for itself is its to destroy; a caller's is the caller's.
  const owned = Option(config.tokenStorage).fold(
    () => Option(createMemoryTokenStorage()),
    () => Option.none<TokenStorage>(),
  )
  const base = owned.fold(
    () => config.tokenStorage as TokenStorage,
    (storage) => storage,
  )
  const storage =
    isEncryptedTokenStorage(base) || config.encryptionKey === false
      ? base
      : createEncryptedTokenStorage(base, config.encryptionKey ?? randomHex())
  const state = createStateStore(storage)
  // Mappings and upstream token sets are stored by the proxy itself, so they are read as-is.
  const read = async <A>(key: string): Promise<Option<A>> => Option((await storage.get(key)) as A)
  const jwt = createJwtIssuer({
    audience: config.baseUrl,
    issuer: config.baseUrl,
    signingKey: config.jwtSigningKey ?? randomHex(),
  })
  const claimsPassthrough = config.customClaimsPassthrough ?? true
  const extractClaims: Option<ClaimsExtractor> =
    claimsPassthrough === false ? Option.none() : Option(createClaimsExtractor(claimsPassthrough, logger))

  const cleanupTimer = setInterval(() => {
    storage.cleanup().catch((error: unknown) => {
      logger.error(
        "[somamcp] OAuth proxy token storage cleanup failed:",
        error instanceof Error ? error.message : String(error),
      )
    })
  }, 60_000)
  cleanupTimer.unref()

  const getProviderName = (): string => new URL(config.upstreamAuthorizationEndpoint).hostname

  /**
   * A redirect URI must parse, carry no credentials, and match an allowed pattern.
   * Unset patterns allow loopback only; `[]` allows nothing.
   */
  const validateRedirectUri = (uri: string): boolean => {
    const parsed = Try(() => new URL(uri)).toOption()
    if (
      parsed.fold(
        () => true,
        (url) => url.username !== "" || url.password !== "",
      )
    )
      return false
    const patterns = config.allowedRedirectUriPatterns ?? ["http://localhost:*", "http://127.0.0.1:*"]
    return patterns.some((pattern) => matchesPattern(uri, pattern))
  }

  /** Defence in depth: the transaction's callback must still be registered for its client. */
  const isCallbackRegistered = async (transaction: OAuthTransaction): Promise<boolean> =>
    (await state.getClient(transaction.clientId)).exists((client) =>
      client.redirectUris.includes(transaction.clientCallbackUrl),
    )

  const basicAuthHeader = (): string =>
    `Basic ${Buffer.from(
      `${encodeURIComponent(config.upstreamClientId)}:${encodeURIComponent(config.upstreamClientSecret)}`,
    ).toString("base64")}`

  /** POST to the upstream token endpoint with the configured client authentication and timeout. */
  const postUpstream = async (params: Record<string, string>): OAuthResult<Response> => {
    const basic = config.upstreamTokenEndpointAuthMethod === "client_secret_basic"
    const body = basic
      ? params
      : { ...params, client_id: config.upstreamClientId, client_secret: config.upstreamClientSecret }
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(basic ? { Authorization: basicAuthHeader() } : {}),
    }
    const sent = await Try.fromPromise(
      fetchUpstream(config.upstreamTokenEndpoint, {
        body: new URLSearchParams(body),
        headers,
        method: "POST",
        signal: AbortSignal.timeout(config.upstreamRequestTimeoutMs),
      }),
    )
    return sent.fold(
      (error) =>
        error.name === "AbortError" || error.name === "TimeoutError"
          ? Promise.resolve(fail<Response>("server_error", "Upstream request timed out"))
          : Promise.reject(error),
      (response) => Promise.resolve(Right<OAuthProxyError, Response>(response)),
    )
  }

  /** An upstream error response as an OAuth error, keeping upstream's code and description. */
  const upstreamFailure = async (
    response: Response,
    defaultCode: string,
    defaultDescription?: string,
  ): Promise<OAuthProxyError> => {
    const body = await Try.fromPromise(response.json() as Promise<{ error?: string; error_description?: string }>)
    return body.fold(
      () => oauthError(defaultCode, `Upstream returned HTTP ${response.status} ${response.statusText}`),
      (error) => oauthError(error.error ?? defaultCode, error.error_description ?? defaultDescription),
    )
  }

  /** Upstream token responses are JSON, or form-encoded (GitHub). An invalid one rejects. */
  const parseTokenResponse = async (response: Response): Promise<UpstreamTokenResponse> => {
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
    if (!contentType.includes("application/x-www-form-urlencoded"))
      return upstreamTokenResponseSchema.parse(await response.json())
    const params = new URLSearchParams(await response.text())
    return upstreamTokenResponseSchema.parse({
      access_token: params.get("access_token") ?? "",
      expires_in: optionalNumber(params, "expires_in").orUndefined(),
      id_token: params.get("id_token") ?? undefined,
      refresh_expires_in: optionalNumber(params, "refresh_expires_in").orUndefined(),
      refresh_token: params.get("refresh_token") ?? undefined,
      scope: params.get("scope") ?? undefined,
      token_type: params.get("token_type") ?? undefined,
    })
  }

  const toTokenSet = (
    tokens: UpstreamTokenResponse,
    scope: ReadonlyArray<string>,
    refreshToken?: string,
  ): UpstreamTokenSet => ({
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in ?? 3600,
    idToken: tokens.id_token,
    issuedAt: new Date(),
    refreshExpiresIn: tokens.refresh_expires_in,
    refreshToken: tokens.refresh_token ?? refreshToken,
    scope: tokens.scope ? tokens.scope.split(" ") : [...scope],
    tokenType: tokens.token_type ?? "Bearer",
  })

  const exchangeUpstreamCode = async (code: string, transaction: OAuthTransaction): OAuthResult<UpstreamTokenSet> => {
    const sent = await postUpstream({
      code,
      code_verifier: transaction.proxyCodeVerifier,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl,
    })
    if (sent.isLeft()) return sent as unknown as Either<OAuthProxyError, UpstreamTokenSet>
    const response = sent.orThrow()
    if (!response.ok) return Left(await upstreamFailure(response, "server_error"))
    return Right(toTokenSet(await parseTokenResponse(response), transaction.scope))
  }

  const refreshUpstream = async (refreshToken: string, scope?: string): OAuthResult<UpstreamTokenSet> => {
    const sent = await postUpstream({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      ...(scope ? { scope } : {}),
    })
    if (sent.isLeft()) return sent as unknown as Either<OAuthProxyError, UpstreamTokenSet>
    const response = sent.orThrow()
    if (!response.ok) return Left(await upstreamFailure(response, "invalid_grant", "Upstream refresh failed"))
    // An upstream that does not rotate refresh tokens keeps the one it had.
    return Right(toTokenSet(await parseTokenResponse(response), [], refreshToken))
  }

  const upstreamClaims = (tokens: UpstreamTokenSet): Option<Record<string, unknown>> =>
    extractClaims.flatMap((extract) => {
      const access = extract(tokens.accessToken, "access").orElse({})
      // Access-token claims first; ID-token claims only where the access token has none.
      const id = Option(tokens.idToken)
        .flatMap((token) => extract(token, "id"))
        .orElse({})
      const merged = { ...access, ...Object.fromEntries(Object.entries(id).filter(([name]) => !(name in access))) }
      return Object.keys(merged).length > 0 ? Option(merged) : Option.none()
    })

  const accessTokenTtlFor = (tokens: UpstreamTokenSet): number => {
    if (tokens.expiresIn > 0) return tokens.expiresIn
    if (config.accessTokenTtl) return config.accessTokenTtl
    return tokens.refreshToken ? DEFAULT_ACCESS_TOKEN_TTL : DEFAULT_ACCESS_TOKEN_TTL_NO_REFRESH
  }

  const refreshTokenTtlFor = (tokens: UpstreamTokenSet): number =>
    tokens.refreshToken ? (tokens.refreshExpiresIn ?? config.refreshTokenTtl ?? DEFAULT_REFRESH_TOKEN_TTL) : 0

  /** Issue the proxy's JWT pair for `upstreamTokenKey`, mapping each JWT's jti to it. */
  const issueTokens = async (
    clientId: string,
    tokens: UpstreamTokenSet,
    upstreamTokenKey: string,
  ): Promise<TokenResponse> => {
    const claims = upstreamClaims(tokens).orUndefined()
    const accessTtl = accessTokenTtlFor(tokens)
    const saveMapping = async (token: string, ttl: number): Promise<void> => {
      const jti = jwt.verify(token).fold(
        () => "",
        (verified) => verified.jti,
      )
      const mapping: TokenMapping = {
        clientId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + ttl * 1000),
        jti,
        scope: tokens.scope,
        upstreamTokenKey,
      }
      await storage.save(`mapping:${jti}`, mapping, ttl)
    }

    const accessToken = jwt.issueAccessToken(clientId, tokens.scope, claims, accessTtl)
    await saveMapping(accessToken, accessTtl)
    const response: TokenResponse = {
      access_token: accessToken,
      expires_in: accessTtl,
      scope: tokens.scope.join(" "),
      token_type: "Bearer",
    }
    if (!tokens.refreshToken) return response
    const refreshTtl = refreshTokenTtlFor(tokens)
    const refreshToken = jwt.issueRefreshToken(clientId, tokens.scope, claims, refreshTtl)
    await saveMapping(refreshToken, refreshTtl)
    return { ...response, refresh_token: refreshToken }
  }

  /** Atomically claim a token mapping, so a refresh token is redeemed at most once. */
  const takeMapping = async (jti: string): Promise<Option<TokenMapping>> => {
    const key = `mapping:${jti}`
    if (storage.take) return Option((await storage.take(key)) as TokenMapping)
    const stored = await read<TokenMapping>(key)
    if (stored.isSome()) await storage.delete(key)
    return stored
  }

  /** Put a claimed mapping back after a failed refresh, with the lifetime it had left. */
  const restoreMapping = async (jti: string, mapping: TokenMapping): Promise<void> => {
    const expiresAt = new Date(mapping.expiresAt).getTime()
    if (Number.isNaN(expiresAt)) return
    const ttl = Math.ceil((expiresAt - Date.now()) / 1000)
    if (ttl > 0) await storage.save(`mapping:${jti}`, mapping, ttl)
  }

  const redirectToUpstream = (transaction: OAuthTransaction): Response => {
    const url = new URL(config.upstreamAuthorizationEndpoint)
    Object.entries(config.extraAuthorizationParams ?? {})
      .filter(([key]) => !RESERVED_AUTHORIZATION_PARAMS.contains(key))
      .forEach(([key, value]) => url.searchParams.set(key, value))
    url.searchParams.set("client_id", config.upstreamClientId)
    url.searchParams.set("redirect_uri", callbackUrl)
    url.searchParams.set("response_type", "code")
    url.searchParams.set("state", transaction.id)
    if (transaction.scope.length > 0) url.searchParams.set("scope", transaction.scope.join(" "))
    if (config.forwardPkce !== true) {
      url.searchParams.set("code_challenge", transaction.proxyCodeChallenge)
      url.searchParams.set("code_challenge_method", "S256")
    }
    return redirect(url.toString())
  }

  /** Back to the client's callback with `params`, its `state`, and `iss` when enabled. */
  const redirectToClient = (transaction: OAuthTransaction, params: Record<string, string>): Response => {
    const url = new URL(transaction.clientCallbackUrl)
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value))
    url.searchParams.set("state", transaction.state)
    if (config.authorizationResponseIss) url.searchParams.set("iss", config.baseUrl)
    return redirect(url.toString())
  }

  const createTransaction = async (params: AuthorizationRequest, clientId: string, redirectUri: string) => {
    const pkce = generatePkcePair()
    const transaction: OAuthTransaction = {
      clientCallbackUrl: redirectUri,
      clientCodeChallenge: params.code_challenge ?? "",
      clientCodeChallengeMethod: Option(params.code_challenge_method).filter(Boolean).orElse("plain"),
      clientId,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + config.transactionTtl * 1000),
      id: randomId(),
      proxyCodeChallenge: pkce.challenge,
      proxyCodeVerifier: pkce.verifier,
      scope: params.scope ? params.scope.split(" ") : [...(config.scopes ?? [])],
      state: Option(params.state).filter(Boolean).orElse(randomId()),
    }
    await state.saveTransaction(transaction)
    return transaction
  }

  const authorize = async (params: AuthorizationRequest): OAuthResult<Response> => {
    const { client_id: clientId, redirect_uri: redirectUri, response_type: responseType } = params
    if (!clientId || !redirectUri || !responseType) return fail("invalid_request", "Missing required parameters")
    if (responseType !== "code") return fail("unsupported_response_type", "Only 'code' response type is supported")
    const client = await state.getClient(clientId)
    if (client.isNone()) return fail("invalid_client", "Unknown client_id")
    if (!client.exists((c) => c.redirectUris.includes(redirectUri)))
      return fail("invalid_request", "redirect_uri is not registered for this client")
    if (params.code_challenge && !params.code_challenge_method)
      return fail("invalid_request", "code_challenge_method required when code_challenge is present")
    if (params.code_challenge_method === "plain" && !config.allowPlainPkce)
      return fail("invalid_request", "code_challenge_method 'plain' is not supported; use S256")
    const transaction = await createTransaction(params, clientId, redirectUri)
    if (!config.consentRequired || transaction.consentGiven === true) return Right(redirectToUpstream(transaction))
    const html = consentHtml({
      clientName: "MCP Client",
      provider: getProviderName(),
      scope: transaction.scope,
      transactionId: transaction.id,
    })
    return Right(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 200 }))
  }

  const handleCallback = async (request: Request): OAuthResult<Response> => {
    const url = new URL(request.url)
    const get = (name: string): Option<string> => Option(url.searchParams.get(name))
    const upstreamError = get("error")
    if (upstreamError.isSome())
      return fail(upstreamError.orElse(""), get("error_description").filter(Boolean).orUndefined())
    const code = get("code").filter(Boolean)
    const stateParam = get("state").filter(Boolean)
    if (code.isNone() || stateParam.isNone()) return fail("invalid_request", "Missing code or state parameter")
    const transaction = await state.consumeTransaction(stateParam.orElse(""))
    if (transaction.isNone()) return fail("invalid_request", "Invalid or expired state")
    const consumed = transaction.orThrow()
    if (!(await isCallbackRegistered(consumed)))
      return fail("invalid_request", "Transaction callback URL is not registered")
    const upstream = await exchangeUpstreamCode(code.orElse(""), consumed)
    if (upstream.isLeft()) return upstream as unknown as Either<OAuthProxyError, Response>
    const clientCode = randomId()
    await state.saveCode({
      clientId: consumed.clientId,
      code: clientCode,
      codeChallenge: consumed.clientCodeChallenge,
      codeChallengeMethod: consumed.clientCodeChallengeMethod,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + config.authorizationCodeTtl * 1000),
      transactionId: consumed.id,
      upstreamTokens: upstream.orThrow(),
    })
    return Right(redirectToClient(consumed, { code: clientCode }))
  }

  const handleConsent = async (form: URLSearchParams): OAuthResult<Response> => {
    const transactionId = form.get("transaction_id")
    const action = form.get("action")
    if (!transactionId) return fail("invalid_request", "Missing transaction_id")
    if (action !== "approve" && action !== "deny") return fail("invalid_request", "action must be 'approve' or 'deny'")
    const found = await state.getTransaction(transactionId)
    if (found.isNone()) return fail("invalid_request", "Invalid or expired transaction")
    const transaction = found.orThrow()
    if (action === "approve") {
      const approved = { ...transaction, consentGiven: true }
      await state.saveTransaction(approved)
      return Right(redirectToUpstream(approved))
    }
    await state.deleteTransaction(transactionId)
    if (!(await isCallbackRegistered(transaction)))
      return fail("invalid_request", "Transaction callback URL is not registered")
    return Right(
      redirectToClient(transaction, { error: "access_denied", error_description: "User denied authorization" }),
    )
  }

  // Note: as in FastMCP, the client secret is not checked here; PKCE binds the code.
  const exchangeAuthorizationCode = async (request: TokenRequest): OAuthResult<TokenResponse> => {
    if (request.grant_type !== "authorization_code")
      return fail("unsupported_grant_type", "Only authorization_code grant type is supported")
    if ((await state.getClient(request.client_id)).isNone()) return fail("invalid_client", "Unknown client_id")
    const code = request.code ?? ""
    const consumed = await state.consumeCode(code)
    if (consumed.isNone()) return fail("invalid_grant", "Invalid or expired authorization code")
    const redeemed = consumed.orThrow()
    await state.markCodeSpent(code, redeemed.expiresAt)
    if (redeemed.status === "spent") return fail("invalid_grant", "Authorization code already used")
    const { clientCode } = redeemed
    if (clientCode.clientId !== request.client_id) return fail("invalid_client", "Client ID mismatch")
    if (clientCode.codeChallenge) {
      if (!request.code_verifier) return fail("invalid_request", "code_verifier required for PKCE")
      if (clientCode.codeChallengeMethod === "plain" && !config.allowPlainPkce)
        return fail("invalid_grant", "code_challenge_method 'plain' is not supported; use S256")
      if (!validatePkce(request.code_verifier, clientCode.codeChallenge, clientCode.codeChallengeMethod))
        return fail("invalid_grant", "Invalid PKCE verifier")
    }
    const upstreamTokenKey = randomId()
    const tokens = clientCode.upstreamTokens
    await storage.save(
      `upstream:${upstreamTokenKey}`,
      tokens,
      Math.max(accessTokenTtlFor(tokens), refreshTokenTtlFor(tokens), 1),
    )
    return Right(await issueTokens(clientCode.clientId, tokens, upstreamTokenKey))
  }

  const refreshWithMapping = async (mapping: TokenMapping, scope?: string): OAuthResult<TokenResponse> => {
    const stored = await read<UpstreamTokenSet>(`upstream:${mapping.upstreamTokenKey}`)
    if (stored.isNone()) return fail("invalid_grant", "Upstream tokens not found or expired")
    const upstream = stored.orThrow()
    if (!upstream.refreshToken) return fail("invalid_grant", "No upstream refresh token available")
    const refreshed = await refreshUpstream(upstream.refreshToken, scope)
    if (refreshed.isLeft()) return refreshed as unknown as Either<OAuthProxyError, TokenResponse>
    const fresh = refreshed.orThrow()
    const tokens = fresh.scope.length === 0 ? { ...fresh, scope: upstream.scope } : fresh
    const refreshTtl = tokens.refreshExpiresIn ?? config.refreshTokenTtl ?? DEFAULT_REFRESH_TOKEN_TTL
    await storage.save(
      `upstream:${mapping.upstreamTokenKey}`,
      tokens,
      Math.max(accessTokenTtlFor(tokens), refreshTtl, 1),
    )
    return Right(await issueTokens(mapping.clientId, tokens, mapping.upstreamTokenKey))
  }

  const exchangeRefreshToken = async (request: TokenRequest): OAuthResult<TokenResponse> => {
    if (request.grant_type !== "refresh_token")
      return fail("unsupported_grant_type", "Only refresh_token grant type is supported")
    const verified = jwt.verify(request.refresh_token ?? "")
    if (verified.isLeft()) return fail("invalid_grant", "Invalid or expired refresh token")
    const jti = verified.fold(
      () => "",
      (claims) => claims.jti,
    )
    if (!jti) return fail("invalid_grant", "Refresh token missing JTI")
    const claimed = await takeMapping(jti)
    if (claimed.isNone()) return fail("invalid_grant", "Refresh token already used or expired")
    const mapping = claimed.orThrow()
    // Any failure puts the mapping back, so the client can retry with the same refresh token.
    const restore = (): Promise<void> =>
      restoreMapping(jti, mapping).catch((error: unknown) => {
        logger.error(`Failed to restore refresh token mapping ${jti}:`, error)
      })
    const result = await Try.fromPromise(refreshWithMapping(mapping, request.scope))
    return result.fold(
      async (error) => {
        await restore()
        return Promise.reject(error)
      },
      async (outcome) => {
        if (outcome.isLeft()) await restore()
        return outcome
      },
    )
  }

  const loadUpstreamTokens = async (token: string): Promise<Option<UpstreamTokenSet>> => {
    const jti = jwt
      .verify(token)
      .toOption()
      .map((claims) => claims.jti)
      .filter(Boolean)
    if (jti.isNone()) return Option.none()
    const mapping = await read<TokenMapping>(`mapping:${jti.orElse("")}`)
    if (mapping.isNone()) return Option.none()
    const key = mapping.fold(
      () => "",
      (m) => m.upstreamTokenKey,
    )
    return read<UpstreamTokenSet>(`upstream:${key}`)
  }

  const registerClient = async (request: ClientRegistrationRequest): OAuthResult<Record<string, unknown>> => {
    const redirectUris = [...(request.redirect_uris ?? [])]
    if (redirectUris.length === 0) return fail("invalid_client_metadata", "redirect_uris is required")
    const invalid = Option(redirectUris.find((uri) => !validateRedirectUri(uri)))
    if (invalid.isSome()) return fail("invalid_redirect_uri", `Invalid redirect URI: ${invalid.orElse("")}`)
    const clientId = randomHex(16)
    const clientSecret = randomId(32)
    const client: RegisteredClient = {
      callbackUrl: redirectUris[0] ?? "",
      clientId,
      clientSecret,
      metadata: {
        client_name: request.client_name,
        client_uri: request.client_uri,
        contacts: request.contacts ? [...request.contacts] : undefined,
        jwks: request.jwks,
        jwks_uri: request.jwks_uri,
        logo_uri: request.logo_uri,
        policy_uri: request.policy_uri,
        scope: request.scope,
        software_id: request.software_id,
        software_version: request.software_version,
        tos_uri: request.tos_uri,
      },
      redirectUris,
      registeredAt: new Date(),
    }
    await state.saveClient(client)
    state.cacheClient(client)
    return Right({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: request.client_name,
      client_secret: clientSecret,
      client_secret_expires_at: 0,
      client_uri: request.client_uri,
      contacts: request.contacts,
      grant_types: request.grant_types ?? ["authorization_code", "refresh_token"],
      jwks: request.jwks,
      jwks_uri: request.jwks_uri,
      logo_uri: request.logo_uri,
      policy_uri: request.policy_uri,
      redirect_uris: redirectUris,
      response_types: request.response_types ?? ["code"],
      scope: request.scope,
      software_id: request.software_id,
      software_version: request.software_version,
      token_endpoint_auth_method: request.token_endpoint_auth_method ?? "client_secret_basic",
      tos_uri: request.tos_uri,
    })
  }

  const getAuthorizationServerMetadata = (): AuthorizationServerMetadata => ({
    authorizationEndpoint: `${config.baseUrl}/oauth/authorize`,
    ...(config.authorizationResponseIss ? { authorizationResponseIssParameterSupported: true as const } : {}),
    codeChallengeMethodsSupported: config.allowPlainPkce ? ["S256", "plain"] : ["S256"],
    grantTypesSupported: ["authorization_code", "refresh_token"],
    issuer: config.baseUrl,
    registrationEndpoint: `${config.baseUrl}/oauth/register`,
    responseTypesSupported: ["code"],
    scopesSupported: config.scopes ?? [],
    tokenEndpoint: `${config.baseUrl}/oauth/token`,
    tokenEndpointAuthMethodsSupported: ["none", "client_secret_basic", "client_secret_post"],
  })

  return {
    authorize,
    destroy: () => {
      clearInterval(cleanupTimer)
      owned.forEach((s) => s.destroy?.())
      state.clear()
    },
    exchangeAuthorizationCode,
    exchangeRefreshToken,
    getAuthorizationServerMetadata,
    getProviderName,
    handleCallback,
    handleConsent,
    loadUpstreamTokens,
    registerClient,
  }
}
