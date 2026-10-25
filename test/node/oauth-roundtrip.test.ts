// A full sign-in through the OAuth proxy's HTTP endpoints, against a stubbed Microsoft:
// register, authorize, consent, the upstream redirect and callback, the code exchange
// with PKCE, an MCP call carrying the JWT, and a refresh.
import { createHash, randomBytes } from "node:crypto"

import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { createAzureProvider, createMemoryTokenStorage, createServer } from "../../src/node/index.js"
import type { OAuthAuthProvider, OAuthSession } from "../../src/node/oauth/provider.js"

const BASE = "https://ms365.test"
const CLIENT_CALLBACK = "https://claude.ai/api/mcp/auth_callback"
const TENANT = "contoso"

const upstreamTokens = (n: number) => ({
  access_token: `graph-access-${n}`,
  expires_in: 3599,
  refresh_token: `graph-refresh-${n}`,
  scope: "User.Read Mail.Read",
  token_type: "Bearer",
})

const setup = () => {
  const calls: Array<{ body: URLSearchParams; headers: Headers; url: string }> = []
  const microsoft = vi.fn((url: string, init: RequestInit) => {
    calls.push({ body: new URLSearchParams(String(init.body)), headers: new Headers(init.headers), url })
    return Promise.resolve(
      new Response(JSON.stringify(upstreamTokens(calls.length)), { headers: { "content-type": "application/json" } }),
    )
  })
  const provider = createAzureProvider({
    allowedRedirectUriPatterns: ["https://claude.ai/*"],
    baseUrl: BASE,
    clientId: "azure-client",
    clientSecret: "azure-secret",
    encryptionKey: "encryption-key",
    fetch: microsoft,
    jwtSigningKey: "signing-key",
    scopes: ["offline_access", "User.Read", "Mail.Read"],
    tenantId: TENANT,
    tokenStorage: createMemoryTokenStorage(),
  })
  const server = createServer<OAuthSession>({ auth: provider, enableDashboard: false, name: "ms365", version: "1.0.0" })
  server.addTool({
    execute: (_args, context) => Promise.resolve(`graph token: ${context.session?.accessToken}`),
    name: "whoami",
    parameters: z.object({}),
  })
  const fetchPath = (path: string, init?: RequestInit) => server.fetch(new Request(`${BASE}${path}`, init))
  return { calls, fetchPath, provider }
}

const form = (fields: Record<string, string>): RequestInit => ({
  body: new URLSearchParams(fields).toString(),
  headers: { "content-type": "application/x-www-form-urlencoded" },
  method: "POST",
})

const callTool = (fetchPath: ReturnType<typeof setup>["fetchPath"], token: string) =>
  fetchPath("/mcp", {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name: "whoami" } }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  })

describe("OAuth proxy round trip", () => {
  const providers: OAuthAuthProvider[] = []
  afterEach(() => providers.splice(0).forEach((p) => p.destroy()))

  /** Register, sign in, and exchange the code: what claude.ai does on connect. */
  const signIn = async () => {
    const env = setup()
    providers.push(env.provider)
    const { calls, fetchPath } = env

    const registered = await fetchPath("/oauth/register", {
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [CLIENT_CALLBACK] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect(registered.status).toBe(201)
    expect(registered.headers.get("cache-control")).toBe("no-store")
    const client = (await registered.json()) as { client_id: string; client_secret: string }

    const verifier = randomBytes(32).toString("base64url")
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    const authorize = await fetchPath(
      `/oauth/authorize?${new URLSearchParams({
        client_id: client.client_id,
        code_challenge: challenge,
        code_challenge_method: "S256",
        redirect_uri: CLIENT_CALLBACK,
        response_type: "code",
        state: "client-state",
      })}`,
    )
    expect(authorize.status).toBe(200)
    expect(authorize.headers.get("content-type")).toBe("text/html")
    const transactionId = /name="transaction_id" value="([^"]+)"/.exec(await authorize.text())?.[1] ?? ""

    const consent = await fetchPath("/oauth/consent", form({ action: "approve", transaction_id: transactionId }))
    expect(consent.status).toBe(302)
    const upstream = new URL(consent.headers.get("location") ?? "")
    expect(`${upstream.origin}${upstream.pathname}`).toBe(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
    )
    expect(upstream.searchParams.get("redirect_uri")).toBe(`${BASE}/oauth/callback`)
    expect(upstream.searchParams.get("code_challenge_method")).toBe("S256")

    const callback = await fetchPath(`/oauth/callback?code=ms-code&state=${upstream.searchParams.get("state") ?? ""}`)
    expect(callback.status).toBe(302)
    const back = new URL(callback.headers.get("location") ?? "")
    expect(`${back.origin}${back.pathname}`).toBe(CLIENT_CALLBACK)
    expect(back.searchParams.get("state")).toBe("client-state")
    expect(back.searchParams.get("iss")).toBe(BASE)

    // The proxy's own PKCE verifier and Basic client auth went to Microsoft's token endpoint.
    expect(calls[0]?.url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`)
    expect(calls[0]?.body.get("code")).toBe("ms-code")
    expect(calls[0]?.body.get("code_verifier")).toBeTruthy()
    expect(calls[0]?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("azure-client:azure-secret").toString("base64")}`,
    )

    const basic = `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")}`
    const token = await fetchPath("/oauth/token", {
      ...form({
        code: back.searchParams.get("code") ?? "",
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: CLIENT_CALLBACK,
      }),
      headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded" },
    })
    expect(token.status).toBe(200)
    expect(token.headers.get("pragma")).toBe("no-cache")
    const tokens = (await token.json()) as { access_token: string; refresh_token: string }
    return { ...env, basic, client, tokens, verifier }
  }

  it("signs in, and a tool sees Microsoft's access token", async () => {
    const { fetchPath, tokens } = await signIn()
    expect(tokens.access_token.split(".")).toHaveLength(3)
    const res = await callTool(fetchPath, tokens.access_token)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("graph token: graph-access-1")
  })

  it("refreshes through Microsoft, once per refresh token", async () => {
    const { calls, client, fetchPath, tokens } = await signIn()
    const refresh = () =>
      fetchPath(
        "/oauth/token",
        form({ client_id: client.client_id, grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
      )
    const refreshed = await refresh()
    expect(refreshed.status).toBe(200)
    expect(calls[1]?.body.get("refresh_token")).toBe("graph-refresh-1")
    const next = (await refreshed.json()) as { access_token: string }
    expect(await (await callTool(fetchPath, next.access_token)).text()).toContain("graph token: graph-access-2")

    const reused = await refresh()
    expect(reused.status).toBe(400)
    expect(await reused.json()).toEqual({
      error: "invalid_grant",
      error_description: "Refresh token already used or expired",
    })
  })

  it("rejects an unknown client at the token endpoint", async () => {
    const env = setup()
    providers.push(env.provider)
    const res = await env.fetchPath(
      "/oauth/token",
      form({ client_id: "nobody", code: "x", grant_type: "authorization_code" }),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "invalid_client", error_description: "Unknown client_id" })
  })

  it("answers an unknown grant type", async () => {
    const env = setup()
    providers.push(env.provider)
    const res = await env.fetchPath("/oauth/token", form({ grant_type: "password" }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "unsupported_grant_type" })
  })

  it("rejects a body over 1 MiB", async () => {
    const env = setup()
    providers.push(env.provider)
    const res = await env.fetchPath("/oauth/register", {
      body: "x".repeat(1024 * 1024 + 1),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "invalid_request", error_description: "Request body exceeds 1 MiB" })
  })

  it("rejects a redirect URI outside the allowed patterns", async () => {
    const env = setup()
    providers.push(env.provider)
    const res = await env.fetchPath("/oauth/register", {
      body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "invalid_redirect_uri",
      error_description: "Invalid redirect URI: https://evil.example/cb",
    })
  })

  it("sends the user back with access_denied when they deny consent", async () => {
    const env = setup()
    providers.push(env.provider)
    const registered = (await (
      await env.fetchPath("/oauth/register", {
        body: JSON.stringify({ redirect_uris: [CLIENT_CALLBACK] }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    ).json()) as { client_id: string }
    const page = await env.fetchPath(
      `/oauth/authorize?${new URLSearchParams({ client_id: registered.client_id, redirect_uri: CLIENT_CALLBACK, response_type: "code", state: "s" })}`,
    )
    const transactionId = /name="transaction_id" value="([^"]+)"/.exec(await page.text())?.[1] ?? ""
    const denied = await env.fetchPath("/oauth/consent", form({ action: "deny", transaction_id: transactionId }))
    const back = new URL(denied.headers.get("location") ?? "")
    expect(back.searchParams.get("error")).toBe("access_denied")
    expect(back.searchParams.get("state")).toBe("s")
  })
})
