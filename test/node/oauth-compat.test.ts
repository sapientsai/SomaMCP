// The OAuth server against a store, tokens and HTTP responses that fastmcp 4.22.10 wrote,
// configured as microsoft365 configures it. If these fail, existing sign-ins would not
// survive the move off FastMCP. See test/fixtures/fastmcp-4.22.10-oauth/README.md.
import { cp, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { createAzureProvider, createDiskStore, createEncryptedStore, createServer } from "../../src/node/index.js"
import type { OAuthAuthProvider, OAuthSession } from "../../src/node/oauth/provider.js"
import fixture from "../fixtures/fastmcp-4.22.10-oauth/fixture.json" with { type: "json" }

const FIXTURE_STORE = join(import.meta.dirname, "../fixtures/fastmcp-4.22.10-oauth/store")
const { config, flow1, flow2, flow3, registration } = fixture
const BASE = "https://ms365.fixture.invalid"

type UpstreamCall = { body: string; url: string }

const claimsOf = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf-8")) as Record<string, unknown>

const form = (fields: Record<string, string>): RequestInit => ({
  body: new URLSearchParams(fields),
  headers: { "content-type": "application/x-www-form-urlencoded" },
  method: "POST",
})

describe("compatibility with what fastmcp 4.22.10 stored and issued", () => {
  const providers: OAuthAuthProvider[] = []
  const state = { calls: [] as UpstreamCall[], directory: "" }

  const provider = (overrides: Partial<Parameters<typeof createAzureProvider>[0]> = {}): OAuthAuthProvider => {
    const created = createAzureProvider({
      allowedRedirectUriPatterns: config.allowedRedirectUriPatterns,
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      encryptionKey: config.encryptionKey,
      fetch: (url, init) => {
        state.calls.push({ body: String(init.body), url })
        return Promise.resolve(
          new Response(JSON.stringify(fixture.upstreamTokenResponses[1]), {
            headers: { "content-type": "application/json" },
          }),
        )
      },
      jwtSigningKey: config.jwtSigningKey,
      logger: { error: () => {}, warn: () => {} },
      scopes: config.scopes,
      tenantId: config.tenantId,
      tokenStorage: createDiskStore({ directory: state.directory }),
      ...overrides,
    })
    providers.push(created)
    return created
  }

  const serve = (auth: OAuthAuthProvider = provider()) =>
    createServer<OAuthSession>({
      auth,
      enableDashboard: false,
      enableHealthEndpoint: false,
      enableInfoEndpoint: false,
      name: "ms365",
      version: "1.0.0",
    })

  const token = (fields: Record<string, string>) =>
    serve().fetch(new Request(`${BASE}/oauth/token`, form({ client_id: registration.client_id, ...fields })))

  beforeEach(async () => {
    // fastmcp's tokens and entries carry absolute expiry times, so the clock is pinned to when it wrote them.
    vi.useFakeTimers({ now: fixture.generatedAtMs, toFake: ["Date"] })
    state.directory = await mkdtemp(join(tmpdir(), "somamcp-oauth-compat-"))
    state.calls.length = 0
    await cp(FIXTURE_STORE, state.directory, { recursive: true })
  })

  afterEach(async () => {
    providers.splice(0).forEach((p) => p.close())
    vi.useRealTimers()
    await rm(state.directory, { force: true, recursive: true })
  })

  describe("the store", () => {
    it("decrypts every entry fastmcp wrote", async () => {
      const store = createEncryptedStore(createDiskStore({ directory: state.directory }), config.encryptionKey)
      const client = (await store.get(`client:${registration.client_id}`)) as { clientSecret: string }
      expect(client).toMatchObject({ clientId: registration.client_id, redirectUris: registration.redirect_uris })
      expect(client.clientSecret).toBe(registration.client_secret)
      expect(await store.get(`transaction:${flow3.transactionId}`)).toMatchObject({ id: flow3.transactionId })
      store.close?.()
    })

    it("logs, rather than silently drops, a value the key cannot decrypt", async () => {
      const errors: unknown[][] = []
      const store = createEncryptedStore(createDiskStore({ directory: state.directory }), "the-wrong-key", {
        error: (...args) => errors.push(args),
      })
      expect(await store.get(`client:${registration.client_id}`)).toBeUndefined()
      expect(String(errors[0]?.[0])).toContain(`could not decrypt client:${registration.client_id}`)
      expect(await store.get("client:nobody")).toBeUndefined()
      expect(errors).toHaveLength(1)
      store.close?.()
    })

    it("names its files as fastmcp does", async () => {
      const store = createDiskStore({ directory: state.directory })
      await store.save("mapping:a.b/c+d", { x: 1 }, 60)
      expect(await readdir(state.directory)).toContain("mapping_a_b_c_d.json")
      store.close?.()
    })
  })

  describe("tokens fastmcp issued", () => {
    it("resolve the access token to the upstream tokens behind it", async () => {
      const tokens = await provider().upstreamTokens(flow1.tokenResponse.access_token)
      expect(tokens ? { ...tokens, issuedAt: tokens.issuedAt.toISOString() } : undefined).toEqual(
        flow1.upstreamFromAccess,
      )
    })

    it("authenticate a request to the session fastmcp's AzureProvider returned", async () => {
      const session = await provider().authenticate(
        new Request(`${BASE}/mcp`, { headers: { authorization: `Bearer ${flow1.tokenResponse.access_token}` } }),
      )
      const { expiresAt: _computedByFastmcp, ...same } = flow1.sessionFromAuthenticate
      expect(session).toMatchObject(same)
      // When the upstream token expires: issued at, plus its lifetime.
      const issuedAt = Math.floor(new Date(flow1.upstreamFromAccess.issuedAt).getTime() / 1000)
      expect(session?.expiresAt).toBe(issuedAt + flow1.upstreamFromAccess.expiresIn)
    })

    it("give a tool the upstream access token as context.session.accessToken", async () => {
      const server = serve()
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

    it("refresh with fastmcp's refresh token, once", async () => {
      const refresh = { grant_type: "refresh_token", refresh_token: flow1.tokenResponse.refresh_token }
      const first = await token(refresh)
      expect(first.status).toBe(200)
      const tokens = (await first.json()) as { access_token: string; refresh_token?: string }
      expect(tokens.refresh_token).toBeDefined()
      expect(state.calls).toHaveLength(1)
      expect(Object.fromEntries(new URLSearchParams(state.calls[0]?.body))).toEqual({
        grant_type: "refresh_token",
        refresh_token: flow1.upstreamFromAccess.refreshToken,
      })
      const upstream = await providers[0]?.upstreamTokens(tokens.access_token)
      expect(upstream?.accessToken).toBe(fixture.upstreamTokenResponses[1]?.access_token)
      const reused = await token(refresh)
      expect(reused.status).toBe(400)
      expect(await reused.json()).toMatchObject({ error: "invalid_grant" })
    })

    it("reject an access token signed with another key", async () => {
      expect(await provider({ jwtSigningKey: "another-key" }).upstreamTokens(flow1.tokenResponse.access_token)).toBe(
        undefined,
      )
    })
  })

  describe("codes and sign-ins fastmcp stored", () => {
    it("redeem the live code with its PKCE verifier, issuing tokens shaped like fastmcp's", async () => {
      const code = new URL(flow2.clientCallbackUrl).searchParams.get("code") ?? ""
      const res = await token({ code, code_verifier: flow2.codeVerifier, grant_type: "authorization_code" })
      expect(res.status).toBe(200)
      const tokens = (await res.json()) as Record<string, string>
      expect(Object.keys(tokens).sort()).toEqual(Object.keys(flow1.tokenResponse).sort())
      // The same claims, in the same order, as the token fastmcp issued for the same user.
      expect(Object.keys(claimsOf(tokens.access_token ?? ""))).toEqual(
        Object.keys(claimsOf(flow1.tokenResponse.access_token)),
      )
    })

    it("report the code fastmcp marked spent as already used", async () => {
      const code = new URL(flow1.clientCallbackUrl).searchParams.get("code") ?? ""
      const res = await token({ code, code_verifier: flow1.codeVerifier, grant_type: "authorization_code" })
      expect(await res.json()).toEqual({
        error: "invalid_grant",
        error_description: "The authorization code was already used.",
      })
    })

    it("approve the pending sign-in and send the user to Microsoft with its state", async () => {
      const res = await serve().fetch(
        new Request(`${BASE}/oauth/consent`, form({ action: "approve", transaction_id: flow3.transactionId })),
      )
      expect(res.status).toBe(302)
      const location = new URL(res.headers.get("location") ?? "")
      expect(`${location.origin}${location.pathname}`).toBe(
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      )
      expect(location.searchParams.get("state")).toBe(flow3.transactionId)
      expect(location.searchParams.get("redirect_uri")).toBe(`${BASE}/oauth/callback`)
    })
  })

  describe("the HTTP responses clients already rely on, byte for byte", () => {
    const captured = fixture.http
    const capturedBase = "http://127.0.0.1:39417"
    const served = () => serve(provider({ baseUrl: capturedBase }))

    it.each([
      ["authorization server metadata", captured.authorizationServerMetadata],
      ["protected resource metadata", captured.protectedResourceBare],
      ["protected resource metadata at the MCP path", captured.protectedResourceMcp],
    ])("serves the %s", async (_name, capture) => {
      const res = await served().fetch(new Request(`${capturedBase}${capture.request.path}`))
      expect(res.status).toBe(capture.status)
      expect(res.headers.get("content-type")).toBe(capture.headers["content-type"])
      expect(await res.text()).toBe(capture.body)
    })

    it.each([
      ["a missing bearer", captured.mcpUnauthenticated, {}],
      ["a bad bearer", captured.mcpBadBearer, { authorization: "Bearer not-a-token" }],
    ])("answers %s with the same 401", async (_name, capture, headers) => {
      const res = await served().fetch(
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
