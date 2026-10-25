// Generates an OAuth-proxy compat fixture with fastmcp 4.22.10, configured the way
// packages/microsoft365/src/auth/oauth-provider.ts configures it. Throwaway keys only.
// usage: node gen.mjs <fastmcp dist dir> <microsoft365 package dir> <out dir>
import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [fastmcpDist, m365Dir, outDir] = process.argv.slice(2)
const { AzureProvider, DiskStore } = await import(join(fastmcpDist, "auth/index.js"))
const { FastMCP } = await import(join(fastmcpDist, "FastMCP.js"))
const { resolveInteractiveScopes } = await import(join(m365Dir, "src/auth/scopes.ts"))

const generatedAtMs = Date.now()
const config = {
  baseUrl: "https://ms365.fixture.invalid",
  clientId: "fixture-upstream-client-id",
  clientSecret: "fixture-upstream-client-secret-not-a-secret",
  tenantId: "common",
  scopes: [...resolveInteractiveScopes()],
  jwtSigningKey: "fixture-jwt-signing-key-not-a-secret-0001",
  encryptionKey: "fixture-token-encryption-key-not-a-secret-0001",
  allowedRedirectUriPatterns: [
    "https://claude.ai/*",
    "https://claude.com/*",
    "http://localhost/*",
    "http://localhost:*/*",
    "http://127.0.0.1/*",
    "http://127.0.0.1:*/*",
  ],
}

// Fake Microsoft tokens. The access token is shaped like a JWT so fastmcp's claims
// passthrough has something to copy; its signature is not real.
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
const fakeJwt = (claims) => `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.fixture-not-a-real-signature`
const upstreamFor = (n) => {
  const claims = {
    oid: "00000000-0000-0000-0000-00000000f1x7",
    tid: "00000000-0000-0000-0000-0000000t3nan",
    preferred_username: "fixture.user@fixture.invalid",
    name: "Fixture User",
    scp: "Mail.ReadWrite User.Read",
    exp: Math.floor(generatedAtMs / 1000) + 3599,
  }
  return {
    access_token: fakeJwt({ ...claims, uti: `fixture-upstream-access-${n}` }),
    id_token: fakeJwt({ ...claims, aud: config.clientId }),
    refresh_token: `fixture-upstream-refresh-token-${n}`,
    expires_in: 3599,
    token_type: "Bearer",
    scope: "Mail.ReadWrite User.Read",
  }
}

let upstreamCalls = 0
const upstreamRequests = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://login.microsoftonline.com/")) {
    upstreamRequests.push({ url: String(url), body: String(init?.body ?? "") })
    upstreamCalls += 1
    return new Response(JSON.stringify(upstreamFor(upstreamCalls)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  return realFetch(url, init)
}

const storeDir = join(outDir, "store")
rmSync(outDir, { recursive: true, force: true })
mkdirSync(storeDir, { recursive: true, mode: 0o700 })

const provider = new AzureProvider({ ...config, tokenStorage: new DiskStore({ directory: storeDir }) })
const proxy = provider.getProxy()

const redirectUri = "https://claude.ai/api/mcp/auth_callback"
const registration = await proxy.registerClient({
  redirect_uris: [redirectUri],
  client_name: "Fixture Client",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
})

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url")
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }
}

// One authorize -> consent -> upstream redirect; returns the upstream state (= transaction id).
const startFlow = async (clientState, challenge) => {
  const consent = await proxy.authorize({
    response_type: "code",
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: clientState,
  })
  const html = await consent.text()
  const transactionId = html.match(/name="transaction_id" value="([^"]+)"/)[1]
  return { transactionId, consentStatus: consent.status }
}

const approve = async (transactionId) => {
  const res = await proxy.handleConsent(
    new Request(`${config.baseUrl}/oauth/consent`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ transaction_id: transactionId, action: "approve" }),
    }),
  )
  return new URL(res.headers.get("Location"))
}

const callback = async (upstreamState, upstreamCode) => {
  const res = await proxy.handleCallback(
    new Request(`${config.baseUrl}/oauth/callback?code=${upstreamCode}&state=${upstreamState}`),
  )
  return new URL(res.headers.get("Location"))
}

// Flow 1: complete, exchanged for our access/refresh JWTs.
const p1 = pkce()
const f1 = await startFlow("fixture-client-state-1", p1.challenge)
const upstreamAuthorizeUrl = await approve(f1.transactionId)
const cb1 = await callback(upstreamAuthorizeUrl.searchParams.get("state"), "fixture-upstream-code-1")
const tokens = await proxy.exchangeAuthorizationCode({
  client_id: registration.client_id,
  client_secret: registration.client_secret,
  code: cb1.searchParams.get("code"),
  code_verifier: p1.verifier,
  grant_type: "authorization_code",
  redirect_uri: redirectUri,
})
const upstreamFromAccess = await proxy.loadUpstreamTokens(tokens.access_token)
const session = await provider.authenticate({ headers: { authorization: `Bearer ${tokens.access_token}` } })

// Flow 2: through the callback, code issued but never exchanged -> leaves a code_* entry.
const p2 = pkce()
const f2 = await startFlow("fixture-client-state-2", p2.challenge)
const up2 = await approve(f2.transactionId)
const cb2 = await callback(up2.searchParams.get("state"), "fixture-upstream-code-2")

// Flow 3: authorize only, consent never given -> leaves a transaction_* entry.
const p3 = pkce()
const f3 = await startFlow("fixture-client-state-3", p3.challenge)

// HTTP captures from a real FastMCP server with the same config, on its own throwaway store.
const httpStore = join(outDir, ".http-store")
mkdirSync(httpStore, { recursive: true })
const httpProvider = new AzureProvider({
  ...config,
  baseUrl: "http://127.0.0.1:39417",
  tokenStorage: new DiskStore({ directory: httpStore }),
})
const server = new FastMCP({ name: "fixture", version: "0.0.0", auth: httpProvider })
await server.start({ transportType: "httpStream", httpStream: { port: 39417, host: "127.0.0.1", stateless: true } })
const capture = async (path, init) => {
  const res = await realFetch(`http://127.0.0.1:39417${path}`, init)
  return {
    request: { path, method: init?.method ?? "GET", body: init?.body ?? null },
    status: res.status,
    headers: Object.fromEntries([...res.headers].filter(([k]) => !["date", "connection", "keep-alive"].includes(k))),
    body: await res.text(),
  }
}
const http = {
  authorizationServerMetadata: await capture("/.well-known/oauth-authorization-server"),
  protectedResourceBare: await capture("/.well-known/oauth-protected-resource"),
  protectedResourceMcp: await capture("/.well-known/oauth-protected-resource/mcp"),
  mcpUnauthenticated: await capture("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } },
    }),
  }),
  mcpBadBearer: await capture("/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer not-a-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
  }),
}
await server.stop()
rmSync(httpStore, { recursive: true, force: true })

writeFileSync(
  join(outDir, "fixture.json"),
  JSON.stringify(
    {
      generator:
        "fastmcp 4.22.10 AzureProvider + DiskStore, configured as packages/microsoft365/src/auth/oauth-provider.ts",
      generatedAtMs,
      config,
      redirectUri,
      registration,
      flow1: {
        description: "Completed and exchanged. Our JWTs below must resolve to upstreamFromAccess.",
        clientState: "fixture-client-state-1",
        codeVerifier: p1.verifier,
        upstreamAuthorizeUrl: upstreamAuthorizeUrl.toString(),
        clientCallbackUrl: cb1.toString(),
        tokenResponse: tokens,
        upstreamFromAccess,
        sessionFromAuthenticate: session,
      },
      flow2: {
        description: "Code issued at the callback, never exchanged: the code_* entry. Exchange it with this verifier.",
        codeVerifier: p2.verifier,
        clientCallbackUrl: cb2.toString(),
      },
      flow3: {
        description: "Authorize only, consent pending: the transaction_* entry.",
        transactionId: f3.transactionId,
        codeVerifier: p3.verifier,
      },
      upstreamTokenResponses: [upstreamFor(1), upstreamFor(2)],
      upstreamRequests,
      http,
    },
    null,
    2,
  ),
)
proxy.destroy?.()
console.log("ok", outDir)
process.exit(0)
