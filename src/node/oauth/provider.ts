// Auth providers for createServer({ auth }): the server becomes its own OAuth authorization
// server in front of an upstream provider, and tools see the upstream provider's tokens.
import { Option } from "functype"

import { getRequestHeader } from "../../auth/request.js"
import type { AuthProvider } from "../../types/auth.js"
import type { Logger } from "../../types/server.js"
import { createOAuthRoutes, mcpChallenge } from "./http.js"
import type { UpstreamTokens } from "./records.js"
import { createAuthorizationServer, type OAuthProxyConfig } from "./server.js"
import type { TokenStore } from "./stores/types.js"

/** What tools see as `context.session`: the upstream provider's tokens. */
export type OAuthSession = {
  accessToken: string
  /** Epoch seconds. */
  expiresAt?: number
  idToken?: string
  refreshToken?: string
  scopes: ReadonlyArray<string>
}

export type OAuthAuthProvider = AuthProvider<OAuthSession> & {
  /** Stop the server's timers, and close the store if the server made it. */
  close: () => void
  /**
   * The upstream tokens behind a bearer token this server issued, or `undefined` when it is
   * not valid. For routes that check tokens themselves.
   */
  // eslint-disable-next-line functype/prefer-option -- consumer-facing method; see the note in types/core.ts on why public types stay plain
  upstreamTokens: (bearer: string) => Promise<UpstreamTokens | undefined>
}

const toSession = (tokens: UpstreamTokens): OAuthSession => ({
  accessToken: tokens.accessToken,
  expiresAt: Math.floor(tokens.issuedAt.getTime() / 1000) + tokens.expiresIn,
  idToken: tokens.idToken,
  refreshToken: tokens.refreshToken,
  scopes: tokens.scope,
})

const bearerOf = (request: Option<Request>): Option<string> =>
  Option(getRequestHeader(request.orUndefined(), "authorization"))
    .filter((header) => /^Bearer\s+/i.test(header))
    .map((header) => header.replace(/^Bearer\s+/i, ""))
    .filter((token) => token !== "")

/** An OAuth server in front of any upstream OAuth 2.0 provider. */
export const createOAuthProxyProvider = (config: OAuthProxyConfig): OAuthAuthProvider => {
  const server = createAuthorizationServer(config)
  const resolve = async (bearer: string): Promise<Option<UpstreamTokens>> => server.resolve(bearer)
  return {
    authenticate: async (request) =>
      bearerOf(Option(request)).fold(
        () => Promise.resolve(undefined),
        async (bearer) => (await resolve(bearer)).map(toSession).orUndefined(),
      ),
    challenge: mcpChallenge(server.issuer),
    close: server.close,
    routes: createOAuthRoutes(server, config.logger ?? console),
    upstreamTokens: async (bearer) => (await resolve(bearer)).orUndefined(),
  }
}

/**
 * FastMCP's `AzureProviderConfig`, so a server moving off FastMCP passes the same object.
 * `tenantId` defaults to `"common"`, and `scopes` to `openid profile email`.
 */
export type AzureProviderConfig = {
  allowedRedirectUriPatterns?: ReadonlyArray<string>
  allowPlainPkce?: boolean
  authorizationResponseIss?: boolean
  baseUrl: string
  clientId: string
  clientSecret: string
  consentRequired?: boolean
  encryptionKey?: string | false
  /** For calls to Microsoft's token endpoint. Defaults to the global `fetch`. */
  fetch?: OAuthProxyConfig["fetch"]
  jwtSigningKey?: string
  logger?: Pick<Logger, "error" | "warn">
  scopes?: ReadonlyArray<string>
  tenantId?: string
  tokenStorage?: TokenStore
}

/** Sign-in with Microsoft Entra ID (`login.microsoftonline.com/{tenant}/oauth2/v2.0`). */
export const createAzureProvider = (config: AzureProviderConfig): OAuthAuthProvider => {
  const authority = `https://login.microsoftonline.com/${config.tenantId ?? "common"}/oauth2/v2.0`
  return createOAuthProxyProvider({
    allowedRedirectUriPatterns: config.allowedRedirectUriPatterns,
    allowPlainPkce: config.allowPlainPkce,
    authorizationResponseIss: config.authorizationResponseIss,
    baseUrl: config.baseUrl,
    consentRequired: config.consentRequired,
    encryptionKey: config.encryptionKey,
    fetch: config.fetch,
    jwtSigningKey: config.jwtSigningKey,
    logger: config.logger,
    scopes: config.scopes ?? ["openid", "profile", "email"],
    store: config.tokenStorage,
    upstream: {
      authorizationEndpoint: `${authority}/authorize`,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      name: "Microsoft",
      tokenEndpoint: `${authority}/token`,
    },
  })
}
