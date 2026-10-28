// The OAuth server as clients meet it: createServer({ auth }) with the Azure provider, over HTTP.
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { type AzureSession, createAzureProvider, createMemoryStore, createServer } from "../../../src/node/index.js"
import { mcpChallenge } from "../../../src/node/oauth/http.js"
import type { OAuthAuthProvider } from "../../../src/node/oauth/provider.js"
import { UserError } from "../../../src/types/core.js"
import { rawRequest } from "../../backend/sdk-clients.js"
import { CALLBACK, createFakeProvider, type FakeProvider, json, pkcePair, quiet, upstreamTokens } from "./harness.js"

const BASE = "https://ms365.test"

const providers: OAuthAuthProvider[] = []
afterEach(() => {
  providers.splice(0).forEach((p) => p.close())
  vi.restoreAllMocks()
})

const azure = (fake: FakeProvider, overrides: Partial<Parameters<typeof createAzureProvider>[0]> = {}) => {
  const provider = createAzureProvider({
    allowedRedirectUriPatterns: ["https://claude.ai/*"],
    baseUrl: BASE,
    clientId: "azure-client",
    clientSecret: "azure-secret",
    encryptionKey: "encryption-key",
    fetch: fake.fetch,
    jwtSigningKey: "signing-key",
    logger: quiet,
    scopes: ["offline_access", "User.Read", "Mail.Read"],
    tenantId: "contoso",
    tokenStorage: createMemoryStore(),
    ...overrides,
  })
  providers.push(provider)
  return provider
}

const setup = (overrides: Partial<Parameters<typeof createAzureProvider>[0]> = {}, serverOptions = {}) => {
  const fake = createFakeProvider()
  const auth = azure(fake, overrides)
  const server = createServer<AzureSession>({
    auth,
    enableDashboard: false,
    name: "ms365",
    version: "1.0.0",
    ...serverOptions,
  })
  server.addTool({
    execute: (_args, context) => Promise.resolve(`graph token: ${context.session?.accessToken}`),
    name: "whoami",
    parameters: z.object({}),
  })
  const request = (path: string, init?: RequestInit) => server.fetch(new Request(`${BASE}${path}`, init))
  return { auth, fake, request, server }
}

const form = (fields: Record<string, string>, headers: Record<string, string> = {}): RequestInit => ({
  body: new URLSearchParams(fields).toString(),
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  method: "POST",
})

const postJson = (body: unknown): RequestInit => ({
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
  method: "POST",
})

/** A request body that arrives in pieces. */
const chunked = (
  chunks: ReadonlyArray<Uint8Array | string>,
  contentType = "application/json",
  fail = false,
): RequestInit => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        await new Promise((resolve) => setTimeout(resolve, 1))
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk)
      }
      if (fail) controller.error(new Error("connection reset"))
      else controller.close()
    },
  })
  return { body, duplex: "half", headers: { "content-type": contentType }, method: "POST" } as RequestInit
}

const transactionIn = (html: string): string => /name="transaction_id" value="([^"]+)"/.exec(html)?.[1] ?? ""

/** What claude.ai does on connect: register, sign in, and redeem the code. */
const signIn = async (env: ReturnType<typeof setup>, extra: Record<string, string> = {}) => {
  const { fake, request } = env
  const client = (await (
    await request("/oauth/register", postJson({ client_name: "Claude", redirect_uris: [CALLBACK] }))
  ).json()) as {
    client_id: string
    client_secret: string
  }
  const pkce = pkcePair()
  const page = await request(
    `/oauth/authorize?${new URLSearchParams({
      client_id: client.client_id,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      redirect_uri: CALLBACK,
      response_type: "code",
      state: "client-state",
      ...extra,
    })}`,
  )
  const consent = await request(
    "/oauth/consent",
    form({ action: "approve", transaction_id: transactionIn(await page.text()) }),
  )
  const upstream = new URL(consent.headers.get("location") ?? "")
  const callback = await request(`/oauth/callback?code=ms-code&state=${upstream.searchParams.get("state") ?? ""}`)
  const back = new URL(callback.headers.get("location") ?? "")
  const basic = `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")}`
  const token = await request(
    "/oauth/token",
    form(
      { code: back.searchParams.get("code") ?? "", code_verifier: pkce.verifier, grant_type: "authorization_code" },
      { authorization: basic },
    ),
  )
  return {
    back,
    basic,
    callback,
    client,
    consent,
    fake,
    page,
    token,
    tokens: (await token.clone().json()) as Record<string, string>,
    upstream,
  }
}

const callTool = (env: ReturnType<typeof setup>, token: string) =>
  env.request("/mcp", {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name: "whoami" } }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  })

describe("a sign-in over HTTP, as claude.ai does it", () => {
  it("ends with a tool seeing Microsoft's access token", async () => {
    const env = setup()
    const flow = await signIn(env)
    expect(flow.page.status).toBe(200)
    expect(flow.consent.status).toBe(302)
    expect(`${flow.upstream.origin}${flow.upstream.pathname}`).toBe(
      "https://login.microsoftonline.com/contoso/oauth2/v2.0/authorize",
    )
    expect(flow.callback.status).toBe(302)
    expect(`${flow.back.origin}${flow.back.pathname}`).toBe(CALLBACK)
    expect(flow.fake.requests[0]?.url).toBe("https://login.microsoftonline.com/contoso/oauth2/v2.0/token")
    expect(flow.token.status).toBe(200)
    const res = await callTool(env, flow.tokens.access_token ?? "")
    expect(await res.text()).toContain("graph token: access-1")
  })

  it("refreshes through Microsoft", async () => {
    const env = setup()
    const { client, tokens } = await signIn(env)
    const refreshed = await env.request(
      "/oauth/token",
      form({ client_id: client.client_id, grant_type: "refresh_token", refresh_token: tokens.refresh_token ?? "" }),
    )
    expect(refreshed.status).toBe(200)
    const next = (await refreshed.json()) as { access_token: string }
    expect(await (await callTool(env, next.access_token)).text()).toContain("graph token: access-2")
  })
})

describe("the metadata documents", () => {
  it("serve the authorization server's metadata (RFC 8414)", async () => {
    const res = await setup().request("/.well-known/oauth-authorization-server")
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(await res.json()).toMatchObject({
      authorization_endpoint: `${BASE}/oauth/authorize`,
      issuer: BASE,
      registration_endpoint: `${BASE}/oauth/register`,
      token_endpoint: `${BASE}/oauth/token`,
    })
  })

  it("serve the protected resource's metadata (RFC 9728), bare and at the MCP path, and 404 elsewhere", async () => {
    const env = setup()
    const expected = {
      authorization_servers: [BASE],
      resource: `${BASE}/mcp`,
      scopes_supported: ["offline_access", "User.Read", "Mail.Read"],
    }
    expect(await (await env.request("/.well-known/oauth-protected-resource")).json()).toEqual(expected)
    expect(await (await env.request("/.well-known/oauth-protected-resource/mcp")).json()).toEqual(expected)
    const other = await env.request("/.well-known/oauth-protected-resource/other")
    expect(other.status).toBe(404)
    expect(await other.text()).toBe("")
  })

  it("name a custom MCP path as the resource, and serve its metadata there", async () => {
    const env = setup({}, { backendOptions: { mcpPath: "/rpc" } })
    expect(await (await env.request("/.well-known/oauth-protected-resource/rpc")).json()).toMatchObject({
      resource: `${BASE}/rpc`,
    })
    expect((await env.request("/.well-known/oauth-protected-resource/mcp")).status).toBe(404)
    const challenge = await env.request("/rpc", postJson({ id: 3, jsonrpc: "2.0", method: "tools/list" }))
    expect(challenge.headers.get("www-authenticate")).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/rpc"`,
    )
  })
})

describe("credential responses", () => {
  it("are never cached: registration and tokens, successes and errors", async () => {
    const env = setup()
    const { token } = await signIn(env)
    const registered = await env.request("/oauth/register", postJson({ redirect_uris: [CALLBACK] }))
    const failedToken = await env.request("/oauth/token", form({ grant_type: "password" }))
    const failedRegistration = await env.request(
      "/oauth/register",
      postJson({ redirect_uris: ["https://evil.example/"] }),
    )
    ;[registered, token, failedToken, failedRegistration].forEach((res) => {
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(res.headers.get("pragma")).toBe("no-cache")
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8")
    })
    expect(registered.status).toBe(201)
  })

  it("answer a registration body that is not JSON", async () => {
    const res = await setup().request("/oauth/register", {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "invalid_client_metadata",
      error_description: "The request body must be JSON.",
    })
  })
})

describe("the token endpoint's client credentials", () => {
  it("takes the client id from HTTP Basic, from the body, or from Basic with an empty secret", async () => {
    const env = setup()
    const { client } = await signIn(env)
    const unknownGrant = (init: RequestInit) => env.request("/oauth/token", init)
    // A known client with a bad grant gets past the client check: invalid_grant, not invalid_client.
    const viaBasic = await unknownGrant(
      form(
        { code: "nope", grant_type: "authorization_code" },
        { authorization: `Basic ${Buffer.from(`${client.client_id}:x`).toString("base64")}` },
      ),
    )
    const viaBody = await unknownGrant(
      form({ client_id: client.client_id, code: "nope", grant_type: "authorization_code" }),
    )
    const emptySecret = await unknownGrant(
      form(
        { code: "nope", grant_type: "authorization_code" },
        { authorization: `Basic ${Buffer.from(`${client.client_id}:`).toString("base64")}` },
      ),
    )
    for (const res of [viaBasic, viaBody, emptySecret])
      expect(((await res.json()) as { error: string }).error).toBe("invalid_grant")
  })

  it("prefers Basic over the body, and form-decodes it", async () => {
    const env = setup()
    const { client } = await signIn(env)
    // The id's first character percent-encoded: only a decoded Basic id names the real client.
    const encoded = `%${client.client_id.charCodeAt(0).toString(16)}${client.client_id.slice(1)}`
    const res = await env.request(
      "/oauth/token",
      form(
        { client_id: "from-body", code: "nope", grant_type: "authorization_code" },
        { authorization: `Basic ${Buffer.from(`${encoded}:secret`).toString("base64")}` },
      ),
    )
    expect(await res.json()).toMatchObject({ error: "invalid_grant" })
  })
})

describe("request bodies", () => {
  it("are refused past 64 KiB, declared or streamed, and the connection closed", async () => {
    const env = setup()
    const declared = await env.request(
      "/oauth/register",
      postJson({ client_name: "x".repeat(64 * 1024), redirect_uris: [CALLBACK] }),
    )
    expect(declared.status).toBe(413)
    expect(declared.headers.get("connection")).toBe("close")
    expect(await declared.json()).toEqual({
      error: "invalid_request",
      error_description: "The request body is over 64 KiB, or could not be read.",
    })
    const streamed = await env.request(
      "/oauth/register",
      chunked(Array.from({ length: 5 }, () => "x".repeat(16 * 1024))),
    )
    expect(streamed.status).toBe(413)
  })

  it("are accepted up to the limit, with room for a client's jwks", async () => {
    const res = await setup().request(
      "/oauth/register",
      postJson({ jwks: { keys: [{ n: "x".repeat(60 * 1024) }] }, redirect_uris: [CALLBACK] }),
    )
    expect(res.status).toBe(201)
  })

  it("arrive whole when sent in slow chunks, with characters split between chunks intact", async () => {
    const env = setup()
    const body = new TextEncoder().encode(JSON.stringify({ client_name: "Zoë — café ☕", redirect_uris: [CALLBACK] }))
    const at = body.indexOf(0xc3) + 1
    const res = await env.request(
      "/oauth/register",
      chunked([body.slice(0, at), body.slice(at, at + 3), body.slice(at + 3)]),
    )
    expect(res.status).toBe(201)
    expect(((await res.json()) as { client_name: string }).client_name).toBe("Zoë — café ☕")
  })

  it("that break off part way are refused", async () => {
    const res = await setup().request("/oauth/register", chunked(['{"redirect_uris":'], "application/json", true))
    expect(res.status).toBe(413)
  })
})

describe("pages for people", () => {
  const authorizeUrl = (clientId: string, extra: Record<string, string> = {}) =>
    `/oauth/authorize?${new URLSearchParams({
      client_id: clientId,
      code_challenge: pkcePair().challenge,
      code_challenge_method: "S256",
      redirect_uri: CALLBACK,
      response_type: "code",
      ...extra,
    })}`

  it("serve the consent page as locked-down HTML: no framing, no scripts, no caching", async () => {
    const env = setup()
    const { client_id } = (await (
      await env.request("/oauth/register", postJson({ client_name: "Claude", redirect_uris: [CALLBACK] }))
    ).json()) as { client_id: string }
    const page = await env.request(authorizeUrl(client_id))
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(page.headers.get("x-frame-options")).toBe("DENY")
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'")
    expect(page.headers.get("cache-control")).toBe("no-store")
    const html = await page.text()
    expect(html).not.toContain("<script")
    expect(html).toContain("Allow Claude to use this server?")
    expect(html).toContain("sign in with <strong>Microsoft</strong>")
    expect(html).toContain("You return to <code>claude.ai</code>")
    expect(html).toContain("started this from <strong>claude.ai</strong>")
    expect(html).toContain(`action="${BASE}/oauth/consent"`)
    // Deny comes first, so pressing Enter declines.
    expect(html.indexOf('value="deny"')).toBeLessThan(html.indexOf('value="approve"'))
  })

  it("escape what a client registered, so a name cannot inject markup", async () => {
    const env = setup()
    const { client_id } = (await (
      await env.request(
        "/oauth/register",
        postJson({ client_name: '<img src=x onerror="alert(1)">', redirect_uris: [CALLBACK] }),
      )
    ).json()) as { client_id: string }
    const html = await (await env.request(authorizeUrl(client_id, { scope: "<b>Mail.Read</b>" }))).text()
    expect(html).not.toContain("<img")
    expect(html).not.toContain("<b>")
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;")
  })

  it("show an error a person can read when the browser asks for HTML, and JSON otherwise", async () => {
    const env = setup()
    const asPage = await env.request("/oauth/authorize?client_id=nobody&redirect_uri=x", {
      headers: { accept: "text/html,*/*" },
    })
    expect(asPage.status).toBe(400)
    expect(asPage.headers.get("content-type")).toBe("text/html; charset=utf-8")
    const html = await asPage.text()
    expect(html).toContain("This sign-in can't continue")
    expect(html).toContain("invalid_client")
    const asJson = await env.request("/oauth/authorize?client_id=nobody&redirect_uri=x")
    expect(await asJson.json()).toEqual({
      error: "invalid_client",
      error_description: "This client is not registered with the server.",
    })
  })

  it("answer a failure they did not expect with a 500, logged, and no detail", async () => {
    const errors: unknown[][] = []
    const store = createMemoryStore()
    vi.spyOn(store, "get").mockRejectedValue(new Error("disk on fire"))
    const env = setup({ logger: { error: (...a) => errors.push(a), warn: () => {} }, tokenStorage: store })
    const res = await env.request("/oauth/authorize?client_id=c&redirect_uri=x")
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: "server_error",
      error_description: "The server could not complete the request.",
    })
    expect(String(errors[0]?.[0])).toContain("authorization failed")
    store.close?.()
  })
})

describe("authenticating MCP requests", () => {
  it("calls authenticate exactly once per request, in both protocol eras", async () => {
    const fake = createFakeProvider()
    const auth = azure(fake)
    const authenticate = vi.spyOn(auth, "authenticate")
    const server = createServer<AzureSession>({ auth, enableDashboard: false, name: "ms365", version: "1.0.0" })
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      server.fetch(
        new Request(`${BASE}/mcp`, {
          body: JSON.stringify(body),
          headers: {
            accept: "application/json, text/event-stream",
            authorization: "Bearer x",
            "content-type": "application/json",
            ...headers,
          },
          method: "POST",
        }),
      )
    await post({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { capabilities: {}, clientInfo: { name: "c", version: "1" }, protocolVersion: "2025-06-18" },
    })
    expect(authenticate).toHaveBeenCalledTimes(1)
    await post({ id: 2, jsonrpc: "2.0", method: "tools/list", params: {} })
    expect(authenticate).toHaveBeenCalledTimes(2)
    // A 2026-07-28 request, with the per-request envelope and routing headers.
    await server.fetch(rawRequest("tools/list", {}, { headers: { authorization: "Bearer x" }, modern: true }))
    expect(authenticate).toHaveBeenCalledTimes(3)
  })
})

describe("who signed in", () => {
  const TENANT = "8f2a1c4e-0b3d-4e5f-9a6b-7c8d9e0f1a2b"
  const OTHER = "11111111-2222-3333-4444-555555555555"
  /** An id token as Microsoft's token endpoint returns it; the server never checks its signature. */
  const idToken = (claims: Record<string, unknown>) =>
    ['{"alg":"RS256","typ":"JWT"}', JSON.stringify(claims)]
      .map((part) => Buffer.from(part).toString("base64url"))
      .concat("signature")
      .join(".")
  const person = (tid: string, iss = `https://login.microsoftonline.com/${tid}/v2.0`) => ({
    iss,
    name: "Avery Example",
    oid: "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
    preferred_username: "avery@contoso.example",
    tid,
  })
  const withIdToken = (env: ReturnType<typeof setup>, claims: Record<string, unknown>) =>
    env.fake.queue(json({ ...upstreamTokens(1), id_token: idToken(claims) }))
  const sessionFor = (env: ReturnType<typeof setup>, accessToken: string) =>
    env.auth.authenticate(new Request(`${BASE}/mcp`, { headers: { authorization: `Bearer ${accessToken}` } }))

  it("gives tools the user's oid, tenant and sign-in name from the id token", async () => {
    const env = setup({ scopes: ["openid", "User.Read"] })
    withIdToken(env, person(TENANT))
    const { tokens } = await signIn(env)
    const session = await sessionFor(env, tokens.access_token ?? "")
    expect(session).toMatchObject({
      oid: "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
      tid: TENANT,
      upn: "avery@contoso.example",
    })
    expect(session?.claims).toMatchObject({ name: "Avery Example", tid: TENANT })
  })

  it("leaves them unset, with empty claims, when Microsoft sends no id token", async () => {
    const env = setup()
    const { tokens } = await signIn(env)
    const session = await sessionFor(env, tokens.access_token ?? "")
    expect(session?.claims).toEqual({})
    expect([session?.oid, session?.tid, session?.upn]).toEqual([undefined, undefined, undefined])
  })

  it("keeps the id token when a refresh comes back without one", async () => {
    const env = setup({ scopes: ["openid", "User.Read"] })
    withIdToken(env, person(TENANT))
    const { client, tokens } = await signIn(env)
    const refreshed = (await (
      await env.request(
        "/oauth/token",
        form({ client_id: client.client_id, grant_type: "refresh_token", refresh_token: tokens.refresh_token ?? "" }),
      )
    ).json()) as { access_token: string }
    // The fake's default refresh answer carries no id_token, so the identity is the sign-in's.
    expect((await sessionFor(env, refreshed.access_token))?.upn).toBe("avery@contoso.example")
  })

  it("keeps the id token when a refresh sends an empty one", async () => {
    const env = setup({ scopes: ["openid", "User.Read"] })
    withIdToken(env, person(TENANT))
    const { client, tokens } = await signIn(env)
    env.fake.queue(json({ ...upstreamTokens(2), id_token: "" }))
    const refreshed = (await (
      await env.request(
        "/oauth/token",
        form({ client_id: client.client_id, grant_type: "refresh_token", refresh_token: tokens.refresh_token ?? "" }),
      )
    ).json()) as { access_token: string }
    const session = await sessionFor(env, refreshed.access_token)
    expect(session?.accessToken).toBe("access-2")
    expect(session?.upn).toBe("avery@contoso.example")
  })

  it("gives empty claims for an id token it cannot read, and still signs in without the check", async () => {
    const env = setup({ scopes: ["openid"] })
    env.fake.queue(json({ ...upstreamTokens(1), id_token: "not-a-jwt" }))
    const { tokens } = await signIn(env)
    expect((await sessionFor(env, tokens.access_token ?? ""))?.claims).toEqual({})
  })

  describe("with tenantId set to a tenant's id", () => {
    it("runs acceptSignIn after the tenant check, and only for accounts in the tenant", async () => {
      const rule = vi.fn((claims: Readonly<Record<string, unknown>>) =>
        claims.preferred_username === "avery@contoso.example" ? undefined : "Not on the pilot list.",
      )
      const outcome = async (claims: Record<string, unknown>) => {
        const env = setup({ acceptSignIn: rule, scopes: ["openid"], tenantId: TENANT })
        withIdToken(env, claims)
        const back = (await signIn(env)).back
        return back.searchParams.get("error_description") ?? `code: ${String(back.searchParams.has("code"))}`
      }
      expect(await outcome(person(OTHER))).toBe("This account belongs to another organization.")
      expect(rule).not.toHaveBeenCalled()
      expect(await outcome({ ...person(TENANT), preferred_username: "sam@contoso.example" })).toBe(
        "Not on the pilot list.",
      )
      expect(await outcome(person(TENANT))).toBe("code: true")
    })

    it("accepts a sign-in from that tenant", async () => {
      const env = setup({ scopes: ["openid"], tenantId: TENANT.toUpperCase() })
      withIdToken(env, person(TENANT))
      const flow = await signIn(env)
      expect(flow.back.searchParams.get("code")).not.toBeNull()
      expect(flow.token.status).toBe(200)
    })

    it.each([
      ["another tenant", person(OTHER)],
      ["an issuer that names another tenant", person(TENANT, `https://login.microsoftonline.com/${OTHER}/v2.0`)],
      ["no tenant at all", { oid: "x", preferred_username: "y" }],
    ])("refuses %s, back on the client's redirect URI with access_denied", async (_name, claims) => {
      const env = setup({ scopes: ["openid"], tenantId: TENANT })
      withIdToken(env, claims)
      const flow = await signIn(env)
      expect(`${flow.back.origin}${flow.back.pathname}`).toBe(CALLBACK)
      expect(flow.back.searchParams.get("error")).toBe("access_denied")
      expect(flow.back.searchParams.get("error_description")).toBe("This account belongs to another organization.")
      expect(flow.back.searchParams.get("code")).toBeNull()
      expect(flow.back.searchParams.get("state")).toBe("client-state")
    })

    it("refuses an id token it cannot read", async () => {
      const env = setup({ scopes: ["openid"], tenantId: TENANT })
      env.fake.queue(json({ ...upstreamTokens(1), id_token: "not-a-jwt" }))
      expect((await signIn(env)).back.searchParams.get("error")).toBe("access_denied")
    })

    it("keeps openid when a client leaves it out, and refuses a sign-in that still has no id token", async () => {
      const env = setup({ scopes: ["openid", "User.Read"], tenantId: TENANT })
      const flow = await signIn(env, { scope: "User.Read" })
      expect(flow.upstream.searchParams.get("scope")).toBe("openid User.Read")
      expect(flow.back.searchParams.get("error")).toBe("access_denied")
      expect(flow.back.searchParams.get("error_description")).toBe(
        "The provider sent no id token, so the account could not be checked.",
      )
      expect(flow.back.searchParams.get("code")).toBeNull()
    })

    it("cannot check when the server's scopes leave out openid, so it signs the user in and says so at startup", async () => {
      const warn = vi.fn()
      const env = setup({ logger: { error: () => {}, warn }, tenantId: TENANT })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("the tenant is not checked"))
      const flow = await signIn(env)
      expect(flow.token.status).toBe(200)
    })
  })

  it("takes the generic provider's options, such as claims", async () => {
    const env = setup({ claims: { allow: ["name"] }, scopes: ["openid"] })
    withIdToken(env, person(TENANT))
    const { tokens } = await signIn(env)
    const claims = JSON.parse(Buffer.from((tokens.access_token ?? "").split(".")[1] ?? "", "base64url").toString())
    expect(claims).toMatchObject({ name: "Avery Example", token_use: "access" })
    expect(claims).not.toHaveProperty("oid")
  })

  it("warns that acceptSignIn never runs when the scopes leave out openid", () => {
    const warn = vi.fn()
    setup({ acceptSignIn: () => undefined, logger: { error: () => {}, warn } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("and acceptSignIn never runs"))
  })

  it("does not check the tenant when tenantId is a name, not an id", async () => {
    const env = setup({ scopes: ["openid"], tenantId: "contoso.onmicrosoft.com" })
    withIdToken(env, person(OTHER))
    expect((await signIn(env)).token.status).toBe(200)
  })

  it("warns at startup when the scopes leave out openid, and not otherwise", () => {
    const warn = vi.fn()
    setup({ logger: { error: () => {}, warn } })
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining("scopes leave out openid, so Microsoft sends no id token"),
    ])
    expect(warn.mock.calls[0]?.[0]).not.toContain("tenant")
    const quietWarn = vi.fn()
    setup({ logger: { error: () => {}, warn: quietWarn }, scopes: ["openid"] })
    expect(quietWarn).not.toHaveBeenCalled()
  })
})

describe("the MCP 401", () => {
  it("tells the client what a UserError says, and nothing of any other error, which it logs", async () => {
    const errors: unknown[][] = []
    const challenge = mcpChallenge(BASE, { error: (...args: unknown[]) => errors.push(args) })
    const answer = async (error?: unknown) => {
      const res = challenge({ endpoint: "/mcp", error, request: new Request(`${BASE}/mcp`), requestId: 1 })
      const body = (await res.json()) as { error: { message: string } }
      return { header: res.headers.get("www-authenticate") ?? "", message: body.error.message }
    }
    expect((await answer(new UserError("Your access was switched off."))).message).toBe("Your access was switched off.")
    expect(await answer()).toMatchObject({ message: "Unauthorized: Authentication failed" })
    expect(errors).toHaveLength(0)
    const leak = await answer(new Error("ENOENT: /var/lib/mcp/tokens/mapping_abc.json"))
    expect(leak.message).toBe("Unauthorized: Authentication error")
    expect(leak.header).not.toContain("/var/lib")
    expect(String(errors[0]?.[1])).toContain("/var/lib/mcp/tokens")
  })
})
