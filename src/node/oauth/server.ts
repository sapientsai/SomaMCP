// The OAuth 2.1 authorization server, put together: it registers clients, runs the
// browser flow, issues and refreshes tokens, and resolves its tokens to the upstream ones.
import { Option } from "functype"

import type { Logger } from "../../types/server.js"
import { createAuthorization } from "./authorization.js"
import { type ClaimsPolicy, createClaimsCopier } from "./claims.js"
import { createClientRegistry } from "./clients.js"
import { createGrants } from "./grants.js"
import { createJwtSigner } from "./jwt.js"
import { createRecords } from "./records.js"
import { randomHex } from "./secrets.js"
import { createEncryptedStore, isEncryptedStore } from "./stores/encrypted.js"
import { createMemoryStore } from "./stores/memory.js"
import { background, type TokenStore } from "./stores/types.js"
import { createUpstream, type UpstreamConfig } from "./upstream.js"

/** Lifetimes in seconds. One left unset, or set to zero or less, takes its default. */
export type Lifetimes = {
  /** For upstream access tokens that came without an `expires_in`. Defaults to an hour. */
  accessToken?: number
  /** Defaults to 5 minutes. */
  authorizationCode?: number
  /**
   * How long a registered client is kept after its last sign-in or refresh. Defaults to 90
   * days. Keep it longer than `refreshToken`, or a client can lapse while its refresh tokens
   * still work, and its next sign-in fails with `invalid_client`.
   */
  client?: number
  /** For upstream refresh tokens that came without a lifetime. Defaults to 30 days. */
  refreshToken?: number
  /** How long a sign-in may take, from /oauth/authorize to the callback. Defaults to 10 minutes. */
  transaction?: number
}

/**
 * - `acceptSignIn` — given the id token's claims, the reason to refuse a sign-in, or
 *   `undefined` to accept it. When `scopes` include `openid`, every request asks for it, and a
 *   sign-in that still comes back without an id token is refused. It runs again on every
 *   refresh, so a rule tightened later ends sessions it now refuses. A session signed in
 *   without an id token (before `openid` was added) has nothing to check, and keeps refreshing.
 * - `allowedRedirectUriPatterns` — glob patterns (`*`, `?`) a registered redirect URI must
 *   match. Unset allows loopback URIs only; `[]` allows none.
 * - `allowPlainPkce` — accept PKCE `plain` as well as `S256`. Defaults to true.
 * - `authorizationResponseIss` — send `iss` on redirects back to the client (RFC 9207). Defaults to true.
 * - `baseUrl` — the server's public URL. It is the issuer and audience of its tokens, so it
 *   must not change while tokens are in use.
 * - `claims` — which upstream claims to copy into issued tokens. Off by default: tools get the
 *   user from the session, and clients treat the token as opaque.
 * - `consentRequired` — show the consent page before the provider's sign-in. Defaults to true.
 * - `encryptionKey` — encrypts the store's contents. Unset generates one per process, so
 *   stored tokens do not survive a restart; `false` stores them unencrypted.
 * - `jwtSigningKey` — signs issued tokens. Unset generates one per process, so tokens stop
 *   working on restart.
 * - `scopes` — the most the server asks the provider for. A client's `scope` narrows the list
 *   and never adds to it; `openid` and `offline_access` stay whenever the list has them.
 * - `store` — where clients, codes and tokens live. Defaults to memory.
 */
export type OAuthProxyConfig = {
  // eslint-disable-next-line functype/prefer-option -- consumer-facing callback; see the note in types/core.ts on why public types stay plain
  acceptSignIn?: (claims: Readonly<Record<string, unknown>>) => string | undefined
  allowedRedirectUriPatterns?: ReadonlyArray<string>
  allowPlainPkce?: boolean
  authorizationResponseIss?: boolean
  baseUrl: string
  claims?: boolean | ClaimsPolicy
  consentRequired?: boolean
  encryptionKey?: string | false
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  jwtSigningKey?: string
  lifetimes?: Lifetimes
  logger?: Pick<Logger, "error" | "warn">
  scopes: ReadonlyArray<string>
  store?: TokenStore
  upstream: UpstreamConfig
}

const DEFAULTS = {
  accessToken: 3600,
  authorizationCode: 300,
  client: 7_776_000,
  refreshToken: 2_592_000,
  transaction: 600,
} as const

export const createAuthorizationServer = (config: OAuthProxyConfig) => {
  const logger = config.logger ?? console
  // An unset, zero or negative lifetime takes the default: to a store, a ttl of 0 means "never expires".
  const lifetime = (name: keyof typeof DEFAULTS): number =>
    Option(config.lifetimes?.[name])
      .filter((seconds) => seconds > 0)
      .orElse(DEFAULTS[name])
  const lifetimes = {
    accessToken: lifetime("accessToken"),
    authorizationCode: lifetime("authorizationCode"),
    client: lifetime("client"),
    refreshToken: lifetime("refreshToken"),
    transaction: lifetime("transaction"),
  }
  const allowPlainPkce = config.allowPlainPkce ?? true
  const sendIssuer = config.authorizationResponseIss ?? true

  // A store the server makes for itself is its own to close; a store passed in is the caller's.
  const ownStore = Option(config.store).fold(
    () => Option(createMemoryStore()),
    () => Option.none<TokenStore>(),
  )
  const plainStore = ownStore.orElse(config.store as TokenStore)
  if (config.store !== undefined && config.encryptionKey === undefined && !isEncryptedStore(plainStore))
    logger.warn("[somamcp/oauth] no encryptionKey: stored tokens will not survive a restart.")
  if (lifetimes.client < lifetimes.refreshToken)
    logger.warn(
      "[somamcp/oauth] lifetimes.client is shorter than lifetimes.refreshToken: clients can lapse while signed in.",
    )
  if (config.jwtSigningKey === undefined)
    logger.warn("[somamcp/oauth] no jwtSigningKey: issued tokens will stop working on restart.")
  const store =
    config.encryptionKey === false || isEncryptedStore(plainStore)
      ? plainStore
      : createEncryptedStore(plainStore, config.encryptionKey ?? randomHex(), logger)

  const records = createRecords(store)
  const clients = createClientRegistry(records, Option(config.allowedRedirectUriPatterns), lifetimes.client)
  const acceptSignIn = Option(config.acceptSignIn).map(
    (accept) => (claims: Readonly<Record<string, unknown>>) => Option(accept(claims)),
  )
  const upstream = createUpstream(config.upstream, {
    defaultAccessTokenLifetime: lifetimes.accessToken,
    fetch: config.fetch ?? ((url, init) => fetch(url, init)),
    logger,
  })
  const signer = createJwtSigner(config.baseUrl, config.jwtSigningKey ?? randomHex())
  const authorization = createAuthorization(
    {
      acceptSignIn,
      allowPlainPkce,
      authorizationCodeLifetime: lifetimes.authorizationCode,
      callbackUrl: `${config.baseUrl}/oauth/callback`,
      consentRequired: config.consentRequired ?? true,
      issuer: config.baseUrl,
      providerName: config.upstream.name,
      scopes: config.scopes,
      sendIssuer,
      transactionLifetime: lifetimes.transaction,
    },
    records,
    clients,
    upstream,
  )
  const grants = createGrants(
    {
      acceptSignIn,
      allowPlainPkce,
      defaultAccessTokenLifetime: lifetimes.accessToken,
      refreshTokenLifetime: lifetimes.refreshToken,
      scopes: config.scopes,
    },
    records,
    clients,
    upstream,
    signer,
    createClaimsCopier(config.claims ?? false, logger),
    logger,
  )

  const stopCleanup = background(60_000, () => {
    store.cleanup().catch((error: unknown) => logger.error("[somamcp/oauth] store cleanup failed:", error))
  })

  /** Authorization server metadata (RFC 8414), with keys in the order FastMCP served them. */
  const metadata = () => ({
    authorization_endpoint: `${config.baseUrl}/oauth/authorize`,
    ...(sendIssuer ? { authorization_response_iss_parameter_supported: true } : {}),
    code_challenge_methods_supported: allowPlainPkce ? ["S256", "plain"] : ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    issuer: config.baseUrl,
    registration_endpoint: `${config.baseUrl}/oauth/register`,
    response_types_supported: ["code"],
    scopes_supported: config.scopes,
    token_endpoint: `${config.baseUrl}/oauth/token`,
    // Public clients authenticate with PKCE alone; confidential ones may send their secret.
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
  })

  return {
    authorize: authorization.authorize,
    callback: authorization.callback,
    close: (): void => {
      stopCleanup()
      ownStore.forEach((s) => s.close?.())
    },
    decide: authorization.decide,
    issuer: config.baseUrl,
    metadata,
    providerName: config.upstream.name,
    register: clients.register,
    resolve: grants.resolve,
    scopes: config.scopes,
    token: grants.token,
  }
}

export type AuthorizationServer = ReturnType<typeof createAuthorizationServer>
