// Auth providers for createServer({ auth }): the server becomes its own OAuth authorization
// server in front of an upstream provider, and tools see the upstream provider's tokens.
import { Option } from "functype"

import { getRequestHeader } from "../../auth/request.js"
import type { AuthProvider } from "../../types/auth.js"
import type { Logger } from "../../types/server.js"
import { idTokenClaims } from "./claims.js"
import { createOAuthRoutes, mcpChallenge } from "./http.js"
import type { UpstreamTokens } from "./records.js"
import { createAuthorizationServer, type OAuthProxyConfig } from "./server.js"
import type { TokenStore } from "./stores/types.js"

/** What tools see as `context.session`: the upstream provider's tokens, and who signed in. */
export type OAuthSession = {
  accessToken: string
  /** The id token's claims, or `{}` when the provider sent none (no `openid` scope). */
  claims: Readonly<Record<string, unknown>>
  /** Epoch seconds. */
  expiresAt?: number
  idToken?: string
  refreshToken?: string
  scopes: ReadonlyArray<string>
}

/**
 * The Azure provider's session. `oid` is the user's object id, `tid` their tenant, and `upn`
 * their sign-in name (`preferred_username`). All three come from the id token, so they are
 * unset without the `openid` scope. FastMCP declared `upn` here but never set it.
 */
export type AzureSession = OAuthSession & { oid?: string; tid?: string; upn?: string }

export type OAuthAuthProvider<S extends OAuthSession = OAuthSession> = AuthProvider<S> & {
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
  claims: Option(tokens.idToken).map(idTokenClaims).orElse({}),
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
export const createOAuthProxyProvider = (config: OAuthProxyConfig): OAuthAuthProvider =>
  buildProvider(config, toSession)

const buildProvider = <S extends OAuthSession>(
  config: OAuthProxyConfig,
  sessionOf: (tokens: UpstreamTokens) => S,
): OAuthAuthProvider<S> => {
  const server = createAuthorizationServer(config)
  const resolve = async (bearer: string): Promise<Option<UpstreamTokens>> => server.resolve(bearer)
  return {
    authenticate: async (request) =>
      bearerOf(Option(request)).fold(
        () => Promise.resolve(undefined),
        async (bearer) => (await resolve(bearer)).map(sessionOf).orUndefined(),
      ),
    challenge: mcpChallenge(server.issuer),
    close: server.close,
    routes: createOAuthRoutes(server, config.logger ?? console),
    upstreamTokens: async (bearer) => (await resolve(bearer)).orUndefined(),
  }
}

/**
 * FastMCP's `AzureProviderConfig`, so a server moving off FastMCP passes the same object.
 * `tenantId` defaults to `"common"`, and `scopes` to `openid profile email`. When `tenantId` is
 * a tenant's id (a GUID), a sign-in whose id token names another tenant is refused.
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

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const text = (claims: Readonly<Record<string, unknown>>, name: string): Option<string> => {
  const value = claims[name]
  return typeof value === "string" && value !== "" ? Option(value) : Option.none()
}

const azureSession = (tokens: UpstreamTokens): AzureSession => {
  const session = toSession(tokens)
  return {
    ...session,
    oid: text(session.claims, "oid").orUndefined(),
    tid: text(session.claims, "tid").orUndefined(),
    upn: text(session.claims, "preferred_username").or(text(session.claims, "upn")).orUndefined(),
  }
}

/**
 * Refuses an id token from any tenant but `tenantId`. Microsoft names the tenant twice, in `tid`
 * and in the issuer `https://login.microsoftonline.com/{tid}/v2.0`, and both must match.
 */
const sameTenant =
  (tenantId: string) =>
  (claims: Readonly<Record<string, unknown>>): Option<string> => {
    const tid = text(claims, "tid").map((value) => value.toLowerCase())
    const issuer = text(claims, "iss")
    const matches =
      tid.contains(tenantId.toLowerCase()) &&
      issuer.contains(`https://login.microsoftonline.com/${tid.orElse("")}/v2.0`)
    return matches ? Option.none() : Option("This account belongs to another organization.")
  }

/** Sign-in with Microsoft Entra ID (`login.microsoftonline.com/{tenant}/oauth2/v2.0`). */
export const createAzureProvider = (config: AzureProviderConfig): OAuthAuthProvider<AzureSession> => {
  const tenantId = config.tenantId ?? "common"
  const authority = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0`
  const scopes = config.scopes ?? ["openid", "profile", "email"]
  const logger = config.logger ?? console
  const checked = TENANT_ID.test(tenantId) ? Option(sameTenant(tenantId)) : Option.none<ReturnType<typeof sameTenant>>()
  if (!scopes.includes("openid")) {
    const unchecked = checked.fold(
      () => "",
      () => ", and the tenant is not checked",
    )
    logger.warn(
      `[somamcp/oauth] scopes leave out openid, so Microsoft sends no id token: sessions have no oid, tid or upn${unchecked}.`,
    )
  }
  return buildProvider(
    {
      acceptSignIn: checked
        .map((check) => (claims: Readonly<Record<string, unknown>>) => check(claims).orUndefined())
        .orUndefined(),
      allowedRedirectUriPatterns: config.allowedRedirectUriPatterns,
      allowPlainPkce: config.allowPlainPkce,
      authorizationResponseIss: config.authorizationResponseIss,
      baseUrl: config.baseUrl,
      consentRequired: config.consentRequired,
      encryptionKey: config.encryptionKey,
      fetch: config.fetch,
      jwtSigningKey: config.jwtSigningKey,
      logger: config.logger,
      scopes,
      store: config.tokenStorage,
      upstream: {
        authorizationEndpoint: `${authority}/authorize`,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        name: "Microsoft",
        tokenEndpoint: `${authority}/token`,
      },
    },
    azureSession,
  )
}
