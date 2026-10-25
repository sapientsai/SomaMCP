// The OAuth proxy against a store, tokens and HTTP responses written by fastmcp 4.22.10,
// configured as microsoft365 configures it. If these fail, existing sign-ins would not
// survive a move off FastMCP. See test/fixtures/fastmcp-4.22.10-oauth/README.md.
import { cp, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import {
  createAzureProvider,
  createDiskStore,
  createEncryptedTokenStorage,
  createServer,
} from "../../src/node/index.js"
import type { OAuthAuthProvider, OAuthSession } from "../../src/node/oauth/provider.js"
import fixture from "../fixtures/fastmcp-4.22.10-oauth/fixture.json" with { type: "json" }

const FIXTURE_STORE = join(import.meta.dirname, "../fixtures/fastmcp-4.22.10-oauth/store")
const { config, flow1, flow2, flow3, registration } = fixture
const BASE = "https://ms365.fixture.invalid"

type UpstreamCall = { body: string; url: string }

const upstreamStub = (calls: UpstreamCall[], response: Record<string, unknown>) =>
  vi.fn((url: string, init: RequestInit) => {
    calls.push({ body: String(init.body), url })
    return Promise.resolve(new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } }))
  })

const payloadOf = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf-8")) as Record<string, unknown>

describe("OAuth proxy compatibility with fastmcp 4.22.10", () => {
  const providers: OAuthAuthProvider[] = []
  const state = { calls: [] as UpstreamCall[], directory: "" }

  const provider = (overrides: Partial<Parameters<typeof createAzureProvider>[0]> = {}): OAuthAuthProvider => {
    const created = createAzureProvider({
      allowedRedirectUriPatterns: config.allowedRedirectUriPatterns,
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      encryptionKey: config.encryptionKey,
      fetch: upstreamStub(state.calls, fixture.upstreamTokenResponses[1] as Record<string, unknown>),
      jwtSigningKey: config.jwtSigningKey,
      scopes: config.scopes,
      tenantId: config.tenantId,
      tokenStorage: createDiskStore({ directory: state.directory }),
      ...overrides,
    })
    providers.push(created)
    return created
  }

  beforeEach(async () => {
    vi.useFakeTimers({ now: fixture.generatedAtMs, toFake: ["Date"] })
    state.directory = await mkdtemp(join(tmpdir(), "somamcp-oauth-compat-"))
    state.calls.length = 0
    await cp(FIXTURE_STORE, state.directory, { recursive: true })
  })

  afterEach(async () => {
    providers.splice(0).forEach((p) => p.destroy())
    vi.useRealTimers()
    await rm(state.directory, { force: true, recursive: true })
  })

  describe("the store", () => {
    it("decrypts every entry fastmcp wrote", async () => {
      const storage = createEncryptedTokenStorage(createDiskStore({ directory: state.directory }), config.encryptionKey)
      const client = (await storage.get(`client:${registration.client_id}`)) as { clientSecret: string }
      expect(client).toMatchObject({ clientId: registration.client_id, redirectUris: registration.redirect_uris })
      expect(client.clientSecret).toBe(registration.client_secret)
      expect(await storage.get(`transaction:${flow3.transactionId}`)).toMatchObject({ id: flow3.transactionId })
      storage.destroy?.()
    })

    it("names the files it writes as fastmcp does", async () => {
      const storage = createDiskStore({ directory: state.directory })
      await storage.save("mapping:a.b/c+d", { x: 1 }, 60)
      expect(await readdir(state.directory)).toContain("mapping_a_b_c_d.json")
      storage.destroy?.()
    })
  })

  describe("tokens fastmcp issued", () => {
    it("resolve the access JWT to the upstream tokens", async () => {
      const tokens = await provider().getProxy().loadUpstreamTokens(flow1.tokenResponse.access_token)
      expect(tokens.orUndefined()).toEqual(flow1.upstreamFromAccess)
    })

    it("authenticate a request to the session fastmcp's AzureProvider returned", async () => {
      const session = await provider().authenticate(
        new Request(`${BASE}/mcp`, { headers: { authorization: `Bearer ${flow1.tokenResponse.access_token}` } }),
      )
      const { expiresAt, ...rest } = flow1.sessionFromAuthenticate
      expect(session).toMatchObject(rest)
      // Computed from the clock at authenticate time, as fastmcp does.
      expect(Math.abs((session?.expiresAt ?? 0) - expiresAt)).toBeLessThanOrEqual(1)
    })

    it("give a tool the upstream access token as context.session.accessToken", async () => {
      const server = createServer<OAuthSession>({
        auth: provider(),
        enableDashboard: false,
        name: "ms365",
        version: "1.0.0",
      })
      server.addTool({
        execute: (_args, context) => Promise.resolve(context.session?.accessToken ?? "none"),
        name: "token",
        parameters: z.object({}),
      })
      const res = await server.fetch(
        new Request(`${BASE}/mcp`, {
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "tools/call",
            params: { arguments: {}, name: "token" },
          }),
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${flow1.tokenResponse.access_token}`,
            "content-type": "application/json",
          },
          method: "POST",
        }),
      )
      expect(await res.text()).toContain(flow1.upstreamFromAccess.accessToken)
    })

    it("refresh with fastmcp's refresh JWT, once", async () => {
      const proxy = provider().getProxy()
      const refresh = { client_id: registration.client_id, grant_type: "refresh_token" }
      const first = await proxy.exchangeRefreshToken({ ...refresh, refresh_token: flow1.tokenResponse.refresh_token })
      const tokens = first.orThrow()
      expect(tokens.refresh_token).toBeDefined()
      expect(state.calls).toHaveLength(1)
      expect(Object.fromEntries(new URLSearchParams(state.calls[0]?.body))).toEqual({
        grant_type: "refresh_token",
        refresh_token: flow1.upstreamFromAccess.refreshToken,
      })
      const upstream = await proxy.loadUpstreamTokens(tokens.access_token)
      expect(upstream.orUndefined()?.accessToken).toBe(fixture.upstreamTokenResponses[1]?.access_token)
      const reused = await proxy.exchangeRefreshToken({ ...refresh, refresh_token: flow1.tokenResponse.refresh_token })
      expect(
        reused.fold(
          (e) => e.description,
          () => "ok",
        ),
      ).toBe("Refresh token already used or expired")
    })

    it("reject an access JWT signed with another key", async () => {
      const tokens = await provider({ jwtSigningKey: "another-key" })
        .getProxy()
        .loadUpstreamTokens(flow1.tokenResponse.access_token)
      expect(tokens.isNone()).toBe(true)
    })
  })

  describe("codes and transactions fastmcp stored", () => {
    it("redeem the live code with its PKCE verifier, issuing JWTs shaped like fastmcp's", async () => {
      const code = new URL(flow2.clientCallbackUrl).searchParams.get("code") ?? ""
      const exchanged = await provider().getProxy().exchangeAuthorizationCode({
        client_id: registration.client_id,
        code,
        code_verifier: flow2.codeVerifier,
        grant_type: "authorization_code",
      })
      const tokens = exchanged.orThrow()
      expect(Object.keys(tokens)).toEqual(Object.keys(flow1.tokenResponse))
      // Same claims, in the same order, as the JWT fastmcp issued for the same upstream user.
      expect(Object.keys(payloadOf(tokens.access_token))).toEqual(
        Object.keys(payloadOf(flow1.tokenResponse.access_token)),
      )
    })

    it("report the spent code as already used", async () => {
      const code = new URL(flow1.clientCallbackUrl).searchParams.get("code") ?? ""
      const exchanged = await provider().getProxy().exchangeAuthorizationCode({
        client_id: registration.client_id,
        code,
        code_verifier: flow1.codeVerifier,
        grant_type: "authorization_code",
      })
      expect(
        exchanged.fold(
          (e) => e.description,
          () => "ok",
        ),
      ).toBe("Authorization code already used")
    })

    it("approve the pending transaction and redirect upstream with its state", async () => {
      const approved = await provider()
        .getProxy()
        .handleConsent(new URLSearchParams({ action: "approve", transaction_id: flow3.transactionId }))
      const location = new URL(approved.orThrow().headers.get("Location") ?? "")
      expect(`${location.origin}${location.pathname}`).toBe(
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      )
      expect(location.searchParams.get("state")).toBe(flow3.transactionId)
      expect(location.searchParams.get("redirect_uri")).toBe(`${BASE}/oauth/callback`)
    })
  })

  describe("HTTP responses, byte for byte", () => {
    const captured = fixture.http
    const capturedBase = "http://127.0.0.1:39417"

    const serve = () =>
      createServer({
        auth: provider({ baseUrl: capturedBase }),
        enableDashboard: false,
        enableHealthEndpoint: false,
        enableInfoEndpoint: false,
        name: "ms365",
        version: "1.0.0",
      })

    it.each([
      ["authorization server metadata", captured.authorizationServerMetadata],
      ["protected resource metadata", captured.protectedResourceBare],
      ["protected resource metadata at the MCP path", captured.protectedResourceMcp],
    ])("serves the %s", async (_name, capture) => {
      const res = await serve().fetch(new Request(`${capturedBase}${capture.request.path}`))
      expect(res.status).toBe(capture.status)
      expect(res.headers.get("content-type")).toBe(capture.headers["content-type"])
      expect(await res.text()).toBe(capture.body)
    })

    it.each([
      ["a missing bearer", captured.mcpUnauthenticated, {}],
      ["a bad bearer", captured.mcpBadBearer, { authorization: "Bearer not-a-token" }],
    ])("answers %s with the same 401", async (_name, capture, headers) => {
      const res = await serve().fetch(
        new Request(`${capturedBase}${capture.request.path}`, {
          body: capture.request.body,
          headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
          method: capture.request.method,
        }),
      )
      expect(res.status).toBe(401)
      expect(res.headers.get("content-type")).toBe(capture.headers["content-type"])
      expect(res.headers.get("www-authenticate")).toBe(capture.headers["www-authenticate"])
      expect(await res.text()).toBe(capture.body)
    })
  })
})
