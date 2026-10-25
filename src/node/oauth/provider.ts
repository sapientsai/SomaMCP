// Auth providers built on the OAuth proxy, and the HTTP surface FastMCP served for them:
// the two well-known metadata documents, the five /oauth/* endpoints, and the 401
// challenge. Ported from fastmcp 4.22.10 (MIT, src/auth/providers/*, and the route glue
// in src/FastMCP.ts), with the 401 matching mcp-proxy 6.7.19's.
import { Either, Option, Try } from "functype"
import type { Context } from "hono"

import { getRequestHeader } from "../../auth/request.js"
import type { AuthChallenge, AuthProvider, AuthRoute } from "../../types/auth.js"
import type { Logger } from "../../types/server.js"
import { readBoundedText } from "../../utils/body.js"
import {
  createOAuthProxy,
  oauthErrorBody,
  type OAuthProxy,
  type OAuthProxyConfig,
  type OAuthProxyError,
  type TokenRequest,
  type UpstreamTokenSet,
} from "./proxy.js"
import type { TokenStorage } from "./storage.js"

/** What tools see as `context.session`: the upstream provider's tokens, not the proxy's JWT. */
export type OAuthSession = {
  accessToken: string
  expiresAt?: number
  idToken?: string
  refreshToken?: string
  scopes: ReadonlyArray<string>
}

export type OAuthAuthProvider = AuthProvider<OAuthSession> & {
  /** Stop the proxy's timers and its own storage. */
  destroy: () => void
  getProxy: () => OAuthProxy
}

/** FastMCP's `AzureProviderConfig`. `tenantId` defaults to `"common"`. */
export type AzureProviderConfig = {
  allowedRedirectUriPatterns?: ReadonlyArray<string>
  allowPlainPkce?: boolean
  authorizationResponseIss?: boolean
  baseUrl: string
  clientId: string
  clientSecret: string
  consentRequired?: boolean
  encryptionKey?: string | false
  /** For the upstream token endpoint. Defaults to the global `fetch`. */
  fetch?: OAuthProxyConfig["fetch"]
  jwtSigningKey?: string
  logger?: Pick<Logger, "error" | "warn">
  scopes?: ReadonlyArray<string>
  tenantId?: string
  tokenStorage?: TokenStorage
}

const MAX_BODY_SIZE = 1024 * 1024
// mcp-proxy added the charset to every JSON response FastMCP sent.
const JSON_UTF8 = "application/json; charset=utf-8"
const CREDENTIAL_HEADERS = { "Cache-Control": "no-store", "Content-Type": JSON_UTF8, Pragma: "no-cache" }
const WELL_KNOWN_RESOURCE = "/.well-known/oauth-protected-resource"

const camelToSnake = (key: string): string => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
const toSnakeCase = (value: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).map(([key, v]) => [camelToSnake(key), v]))

const json = (body: unknown, status: number, headers: Record<string, string> = { "Content-Type": JSON_UTF8 }) =>
  new Response(JSON.stringify(body), { headers, status })

/** RFC 9728: the metadata for `https://host/mcp` lives at `https://host/.well-known/oauth-protected-resource/mcp`. */
const protectedResourceMetadataUrl = (resource: string): string =>
  Try(() => new URL(resource))
    .toOption()
    .fold(
      () => `${resource}${WELL_KNOWN_RESOURCE}`,
      (url) => {
        url.pathname = `${WELL_KNOWN_RESOURCE}${url.pathname === "/" ? "" : url.pathname}`
        return url.toString()
      },
    )

const tooLarge = (): Response =>
  json({ error: "invalid_request", error_description: "Request body exceeds 1 MiB" }, 400, {
    Connection: "close",
    "Content-Type": JSON_UTF8,
  })

const BASIC = /^Basic\s+(.+)$/
const CREDENTIALS = /^([^:]+):(.*)$/

/** `Basic base64(id:secret)`, decoded as-is (FastMCP does not URL-decode the parts). */
const decodeBasic = (header: Option<string>): Option<string> =>
  header
    .flatMap((value) => Option(BASIC.exec(value)))
    .map((match) => Buffer.from(String(match[1]), "base64").toString("utf-8"))

const parseBasicAuth = (header: Option<string>): Option<{ clientId: string; clientSecret: string }> =>
  decodeBasic(header)
    .flatMap((decoded) => Option(CREDENTIALS.exec(decoded)))
    .map((match) => ({ clientId: String(match[1]), clientSecret: String(match[2]) }))

/** A redirect keeps only its Location; any other response is passed on with `contentType`. */
const relay = (response: Response, contentType?: string): Promise<Response> =>
  Option(response.headers.get("Location")).fold(
    async () =>
      new Response(await response.text(), {
        headers: contentType ? { "Content-Type": contentType } : {},
        status: response.status,
      }),
    (location) => Promise.resolve(new Response(null, { headers: { Location: location }, status: response.status })),
  )

/**
 * Runs an endpoint: an OAuth error becomes its JSON body at `status(error)`, and anything
 * unexpected becomes `fallback` at 400, as in FastMCP.
 */
const answer = async <A>(
  run: () => Promise<Either<OAuthProxyError, A>>,
  ok: (value: A) => Response | Promise<Response>,
  fallback: { error: string },
  errorStatus: (error: OAuthProxyError) => number,
  headers: Record<string, string>,
): Promise<Response> => {
  const result = await Try.fromPromise(Promise.resolve().then(run))
  return result.fold(
    () => json(fallback, 400, headers),
    (outcome) =>
      outcome.fold(
        (error) => json(oauthErrorBody(error), errorStatus(error), headers),
        (value) => ok(value),
      ),
  )
}

const withBody = async (c: Context, handle: (body: string) => Promise<Response>): Promise<Response> =>
  (await readBoundedText(c.req.raw, MAX_BODY_SIZE)).fold(
    () => Promise.resolve(tooLarge()),
    (body) => handle(body),
  )

const createSession = (tokens: UpstreamTokenSet): OAuthSession => ({
  accessToken: tokens.accessToken,
  expiresAt: tokens.expiresIn ? Math.floor(Date.now() / 1000) + tokens.expiresIn : undefined,
  idToken: tokens.idToken,
  refreshToken: tokens.refreshToken,
  scopes: tokens.scope,
})

/**
 * The 401 mcp-proxy 6.7.19 sends in front of FastMCP: header parameters in its order, and
 * a JSON-RPC error body echoing the request's id.
 */
const challengeResponse =
  (baseUrl: string) =>
  ({ endpoint, error, requestId }: AuthChallenge): Response => {
    const message =
      error === undefined
        ? "Unauthorized: Authentication failed"
        : error instanceof Error
          ? error.message
          : "Unauthorized: Authentication error"
    const resource = `${baseUrl.replace(/\/+$/, "")}${endpoint}`
    const header = [
      `resource_metadata="${protectedResourceMetadataUrl(resource)}"`,
      'error="invalid_token"',
      `error_description="${message.replace(/"/g, '\\"')}"`,
    ].join(", ")
    return json({ error: { code: -32000, message }, id: requestId, jsonrpc: "2.0" }, 401, {
      "Content-Type": JSON_UTF8,
      "WWW-Authenticate": `Bearer ${header}`,
    })
  }

const oauthRoutes = (
  proxy: OAuthProxy,
  baseUrl: string,
  scopes: ReadonlyArray<string>,
  endpoint: () => string,
): ReadonlyArray<AuthRoute> => {
  const protectedResource = (c: Context): Response => {
    if (c.req.path !== WELL_KNOWN_RESOURCE && c.req.path !== `${WELL_KNOWN_RESOURCE}${endpoint()}`)
      return new Response(null, { status: 404 })
    return json(
      toSnakeCase({
        authorizationServers: [baseUrl],
        resource: `${baseUrl.replace(/\/+$/, "")}${endpoint()}`,
        scopesSupported: scopes,
      }),
      200,
    )
  }

  const token = (body: string, authorization: Option<string>): Promise<Response> => {
    const params = new URLSearchParams(body)
    const basic = parseBasicAuth(authorization)
    const request: Omit<TokenRequest, "grant_type"> = {
      client_id: basic
        .map((b) => b.clientId)
        .filter(Boolean)
        .orElse(params.get("client_id") ?? ""),
      client_secret: basic.fold(
        () => params.get("client_secret") ?? undefined,
        (b) => b.clientSecret,
      ),
    }
    const grantType = params.get("grant_type")
    return answer(
      () => {
        if (grantType === "authorization_code")
          return proxy.exchangeAuthorizationCode({
            ...request,
            code: params.get("code") ?? "",
            code_verifier: params.get("code_verifier") ?? undefined,
            grant_type: "authorization_code",
            redirect_uri: params.get("redirect_uri") ?? "",
          })
        if (grantType === "refresh_token")
          return proxy.exchangeRefreshToken({
            ...request,
            grant_type: "refresh_token",
            refresh_token: params.get("refresh_token") ?? "",
            scope: params.get("scope") ?? undefined,
          })
        return Promise.resolve(Either.left({ code: "unsupported_grant_type", statusCode: 400 }))
      },
      (response) => json(response, 200, CREDENTIAL_HEADERS),
      { error: "invalid_request" },
      (error) => error.statusCode,
      CREDENTIAL_HEADERS,
    )
  }

  const plainJson = { "Content-Type": JSON_UTF8 }

  return [
    {
      handler: () => json(toSnakeCase(proxy.getAuthorizationServerMetadata()), 200),
      method: "GET",
      path: "/.well-known/oauth-authorization-server",
    },
    { handler: protectedResource, method: "GET", path: WELL_KNOWN_RESOURCE },
    { handler: protectedResource, method: "GET", path: `${WELL_KNOWN_RESOURCE}/*` },
    {
      handler: (c) =>
        withBody(c, (body) =>
          answer(
            async () => proxy.registerClient(JSON.parse(body) as Parameters<OAuthProxy["registerClient"]>[0]),
            (response) => json(response, 201, CREDENTIAL_HEADERS),
            { error: "invalid_request" },
            (error) => error.statusCode,
            CREDENTIAL_HEADERS,
          ),
        ),
      method: "POST",
      path: "/oauth/register",
    },
    {
      handler: (c) =>
        answer(
          () => proxy.authorize(Object.fromEntries(new URL(c.req.url).searchParams.entries())),
          (response) => relay(response, "text/html"),
          { error: "invalid_request" },
          () => 400,
          plainJson,
        ),
      method: "GET",
      path: "/oauth/authorize",
    },
    {
      handler: (c) =>
        answer(
          () => proxy.handleCallback(new Request(c.req.url)),
          (response) => relay(response),
          { error: "server_error" },
          () => 400,
          plainJson,
        ),
      method: "GET",
      path: "/oauth/callback",
    },
    {
      handler: (c) =>
        withBody(c, (body) =>
          answer(
            () => proxy.handleConsent(new URLSearchParams(body)),
            (response) => relay(response),
            { error: "server_error" },
            () => 400,
            plainJson,
          ),
        ),
      method: "POST",
      path: "/oauth/consent",
    },
    {
      handler: (c) => withBody(c, (body) => token(body, Option(c.req.header("authorization")))),
      method: "POST",
      path: "/oauth/token",
    },
  ]
}

/**
 * An auth provider for any upstream OAuth server the proxy fronts: it authenticates the
 * proxy's JWTs to the upstream tokens behind them, serves the OAuth routes, and answers
 * unauthenticated MCP requests with the RFC 9728 challenge.
 */
export const createOAuthProxyProvider = (
  config: OAuthProxyConfig & { scopes: ReadonlyArray<string> },
): OAuthAuthProvider => {
  const proxy = createOAuthProxy(config)
  return {
    authenticate: async (request) => {
      const bearer = Option(getRequestHeader(request, "authorization")).filter((header) => header.startsWith("Bearer "))
      if (bearer.isNone()) return undefined
      const tokens = await proxy.loadUpstreamTokens(bearer.orElse("").slice(7))
      return tokens.map(createSession).orUndefined()
    },
    challenge: challengeResponse(config.baseUrl),
    destroy: () => proxy.destroy(),
    getProxy: () => proxy,
    routes: (endpoint) => oauthRoutes(proxy, config.baseUrl, config.scopes, endpoint),
  }
}

/**
 * Microsoft Entra ID (Azure AD) behind the OAuth proxy, configured as FastMCP's
 * `AzureProvider`: `login.microsoftonline.com/{tenantId}/oauth2/v2.0`, default scopes
 * `openid profile email`, and consent required unless `consentRequired: false`.
 */
export const createAzureProvider = (config: AzureProviderConfig): OAuthAuthProvider => {
  const tenant = config.tenantId ?? "common"
  const authority = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`
  return createOAuthProxyProvider({
    allowedRedirectUriPatterns: config.allowedRedirectUriPatterns,
    ...(config.allowPlainPkce === undefined ? {} : { allowPlainPkce: config.allowPlainPkce }),
    ...(config.authorizationResponseIss === undefined
      ? {}
      : { authorizationResponseIss: config.authorizationResponseIss }),
    baseUrl: config.baseUrl,
    consentRequired: config.consentRequired ?? true,
    encryptionKey: config.encryptionKey,
    fetch: config.fetch,
    jwtSigningKey: config.jwtSigningKey,
    logger: config.logger,
    scopes: config.scopes ?? ["openid", "profile", "email"],
    tokenStorage: config.tokenStorage,
    upstreamAuthorizationEndpoint: `${authority}/authorize`,
    upstreamClientId: config.clientId,
    upstreamClientSecret: config.clientSecret,
    upstreamTokenEndpoint: `${authority}/token`,
  })
}
