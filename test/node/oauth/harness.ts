// Shared pieces for the OAuth server's tests: a stand-in upstream provider, a server with
// test defaults, and helpers that walk a sign-in through the server's own API.
import { createHash, randomBytes } from "node:crypto"

import type { Either } from "functype"
import { expect, vi } from "vitest"

import type { BrowserStep, ConsentScreen } from "../../../src/node/oauth/authorization.js"
import type { OAuthError } from "../../../src/node/oauth/errors.js"
import { toWireError } from "../../../src/node/oauth/errors.js"
import { createAuthorizationServer, type OAuthProxyConfig } from "../../../src/node/oauth/server.js"
import { createMemoryStore } from "../../../src/node/oauth/stores/memory.js"
import type { TokenStore } from "../../../src/node/oauth/stores/types.js"

export const BASE = "https://mcp.test"
export const CALLBACK = "https://claude.ai/api/mcp/auth_callback"
export const AUTHORIZE = "https://login.example/authorize"
export const TOKEN = "https://login.example/token"
export const quiet = { error: () => {}, warn: () => {} }

export type UpstreamRequest = { body: URLSearchParams; headers: Headers; init: RequestInit; url: string }

/** The token response the stand-in provider gives on its `n`th successful call. */
export const upstreamTokens = (n: number) => ({
  access_token: `access-${n}`,
  expires_in: 3599,
  refresh_token: `refresh-${n}`,
  scope: "User.Read Mail.Read",
  token_type: "Bearer",
})

export const json = (body: unknown, status = 200, contentType = "application/json"): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": contentType }, status })

/**
 * A stand-in for the provider's token endpoint. It answers with `upstreamTokens(n)` unless
 * a response (or an error to throw) has been queued.
 */
export const createFakeProvider = () => {
  const requests: UpstreamRequest[] = []
  const queued: Array<Error | Response | (() => Promise<Response>)> = []
  const successes = { count: 0 }
  const fetch = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    requests.push({ body: new URLSearchParams(String(init.body)), headers: new Headers(init.headers), init, url })
    const next = queued.shift()
    if (next instanceof Error) throw next
    if (typeof next === "function") return next()
    if (next) return next
    successes.count += 1
    return json(upstreamTokens(successes.count))
  })
  return {
    fetch,
    /** Answer the next call with this, or throw it. */
    queue: (next: Error | Response | (() => Promise<Response>)) => {
      queued.push(next)
    },
    requests,
  }
}

export type FakeProvider = ReturnType<typeof createFakeProvider>

export const createTestServer = (
  provider: FakeProvider,
  overrides: Partial<OAuthProxyConfig> = {},
): ReturnType<typeof createAuthorizationServer> =>
  createAuthorizationServer({
    allowedRedirectUriPatterns: ["https://claude.ai/*", "http://localhost:*"],
    baseUrl: BASE,
    encryptionKey: "test-encryption-key",
    fetch: provider.fetch,
    jwtSigningKey: "test-signing-key",
    logger: quiet,
    scopes: ["openid", "User.Read"],
    // Made only when the test does not bring its own, so no stray timer is left running.
    store: "store" in overrides ? overrides.store : createMemoryStore(),
    upstream: {
      authorizationEndpoint: AUTHORIZE,
      clientId: "upstream-client",
      clientSecret: "upstream-secret",
      name: "Example",
      tokenEndpoint: TOKEN,
    },
    ...overrides,
  })

export type TestServer = ReturnType<typeof createTestServer>

export const pkcePair = () => {
  const verifier = randomBytes(32).toString("base64url")
  return { challenge: createHash("sha256").update(verifier).digest("base64url"), verifier }
}

export const right = <A>(result: Either<OAuthError, A>): A =>
  result.fold(
    (error) => {
      throw new Error(`expected success, got ${error._tag}: ${JSON.stringify(error)}`)
    },
    (value) => value,
  )

export const left = <A>(result: Either<OAuthError, A>): OAuthError =>
  result.fold(
    (error) => error,
    () => {
      throw new Error("expected an error, got success")
    },
  )

/** The wire code and description an error would go out with. */
export const wire = <A>(result: Either<OAuthError, A>) => {
  const error = toWireError(left(result))
  return { code: error.code, description: error.description.orUndefined(), status: error.status }
}

export const redirectOf = (step: BrowserStep): URL => {
  expect(step._tag).toBe("Redirect")
  return new URL(step._tag === "Redirect" ? step.location : "about:blank")
}

export const consentOf = (step: BrowserStep): ConsentScreen => {
  expect(step._tag).toBe("Consent")
  if (step._tag !== "Consent") throw new Error("expected the consent page")
  return step.screen
}

export const register = async (server: TestServer, redirectUris: ReadonlyArray<string> = [CALLBACK]) =>
  right(await server.register({ client_name: "Claude", redirect_uris: redirectUris }))

/** /oauth/authorize with sensible defaults; `params` overrides or removes (`undefined`) any of them. */
export const authorize = (
  server: TestServer,
  clientId: string,
  challenge: string,
  params: Record<string, string | undefined> = {},
) =>
  server.authorize(
    Object.fromEntries(
      Object.entries({
        client_id: clientId,
        code_challenge: challenge,
        code_challenge_method: "S256",
        redirect_uri: CALLBACK,
        response_type: "code",
        state: "client-state",
        ...params,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  )

/** The provider's redirect back to the server for a sign-in it sent there. */
export const providerCallback = (upstreamUrl: URL, params: Record<string, string> = { code: "upstream-code" }): URL =>
  new URL(
    `${BASE}/oauth/callback?${new URLSearchParams({ state: upstreamUrl.searchParams.get("state") ?? "", ...params })}`,
  )

/** Authorize, approve, and come back from the provider: the code the client receives, with its verifier. */
export const signIn = async (server: TestServer, clientId: string) => {
  const pkce = pkcePair()
  const screen = consentOf(right(await authorize(server, clientId, pkce.challenge)))
  const upstreamUrl = redirectOf(
    right(await server.decide(new URLSearchParams({ action: "approve", transaction_id: screen.transactionId }))),
  )
  const back = redirectOf(right(await server.callback(providerCallback(upstreamUrl))))
  return { back, code: back.searchParams.get("code") ?? "", upstreamUrl, verifier: pkce.verifier }
}

/** Sign in and redeem the code: the token pair a client holds afterwards. */
export const issueTokens = async (server: TestServer, clientId: string) => {
  const { code, verifier } = await signIn(server, clientId)
  return right(await server.token({ clientId, code, codeVerifier: verifier, grantType: "authorization_code" }))
}

/** A store that records every call, around a memory store. */
export const spyStore = (inner: TokenStore = createMemoryStore()) => {
  const saves: Array<{ key: string; ttl?: number; value: unknown }> = []
  const store: TokenStore = {
    ...inner,
    save: (key, value, ttl) => {
      saves.push({ key, ttl, value })
      return inner.save(key, value, ttl)
    },
  }
  return { saves, store }
}
