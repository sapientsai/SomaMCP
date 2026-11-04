import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client"
import { describe, expect, it } from "vitest"

import { createAzureProvider, createMemoryStore, createServer } from "../../../src/node/index.js"
import { createJwtSigner } from "../../../src/node/oauth/jwt.js"
import { createEncryptedStore } from "../../../src/node/oauth/stores/encrypted.js"
import { quiet } from "./harness.js"

const BASE = "https://ms365.test"

/** A provider holding one sign-in, granted `granted`, and the access token for it. */
const signedIn = async (granted: ReadonlyArray<string>) => {
  const store = createMemoryStore()
  const provider = createAzureProvider({
    baseUrl: BASE,
    clientId: "azure-client",
    clientSecret: "azure-secret",
    encryptionKey: "k",
    jwtSigningKey: "j",
    logger: quiet,
    scopes: ["openid", "offline_access", "User.Read", "Mail.Send"],
    tokenStorage: store,
  })
  const jwt = createJwtSigner(BASE, "j").issue({ clientId: "c", lifetime: 3600, scope: [...granted], use: "access" })
  const now = new Date()
  const encrypted = createEncryptedStore(store, "k", quiet)
  await encrypted.save(`mapping:${jwt.jti}`, {
    clientId: "c",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 3_600_000),
    jti: jwt.jti,
    scope: granted,
    upstreamTokenKey: "u",
  })
  await encrypted.save("upstream:u", {
    accessToken: "ms",
    expiresIn: 3600,
    issuedAt: now,
    scope: granted,
    tokenType: "Bearer",
  })
  const server = createServer({
    auth: provider,
    enableDashboard: false,
    enableInfoEndpoint: false,
    name: "s",
    version: "1.0.0",
  })
  server.addTool({ execute: async () => "sent", name: "send-mail", requiredScopes: ["Mail.Send"] })
  server.addTool({ execute: async () => "open", name: "open" })
  return {
    close: () => {
      provider.close()
      store.close?.()
    },
    fetch: server.fetch,
    token: jwt.token,
  }
}

describe("step-up through the OAuth provider", () => {
  it("answers with the metadata URL and both sets of scopes", async () => {
    const { close, fetch, token } = await signedIn(["User.Read"])
    const response = await fetch(
      new Request(`${BASE}/mcp`, {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: {}, name: "send-mail" },
        }),
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
    )
    expect(response.status).toBe(403)
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", scope="User.Read Mail.Send"`,
    )
    close()
  })

  it("logs a required scope the server can't grant", async () => {
    const errors: unknown[][] = []
    const provider = createAzureProvider({
      baseUrl: BASE,
      clientId: "c",
      clientSecret: "s",
      encryptionKey: "k",
      jwtSigningKey: "j",
      logger: { ...quiet, error: (...args: unknown[]) => errors.push(args) },
      scopes: ["openid"],
      tokenStorage: createMemoryStore(),
    })
    const refusal = await provider.scopeChallenge?.({
      endpoint: "/mcp",
      granted: [],
      request: new Request(`${BASE}/mcp`),
      requestId: 1,
      required: ["Mail.Send"],
    })
    expect(refusal?.status).toBe(403)
    expect(String(errors[0]?.[0])).toContain("Mail.Send")
    provider.close()
  })

  it("makes the MCP SDK's client sign in again, asking for what it had and what it lacks", async () => {
    const { close, fetch, token } = await signedIn(["User.Read"])
    const redirects: URL[] = []
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      authProvider: {
        clientInformation: () => ({ client_id: "c" }),
        clientMetadata: { redirect_uris: ["http://localhost:1/cb"] },
        codeVerifier: () => "v",
        redirectToAuthorization: (url: URL) => {
          redirects.push(url)
        },
        redirectUrl: "http://localhost:1/cb",
        saveCodeVerifier: () => {},
        saveTokens: () => {},
        tokens: () => ({ access_token: token, token_type: "Bearer" }),
      },
      fetch: (input, init) => fetch(new Request(input as string, init)),
    })
    const client = new Client({ name: "c", version: "1" })
    await client.connect(transport)
    expect((await client.callTool({ arguments: {}, name: "open" })).isError).toBeFalsy()
    await expect(client.callTool({ arguments: {}, name: "send-mail" })).rejects.toThrow(UnauthorizedError)
    expect(redirects).toHaveLength(1)
    expect(redirects[0]?.origin + (redirects[0]?.pathname ?? "")).toBe(`${BASE}/oauth/authorize`)
    expect(redirects[0]?.searchParams.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining(["User.Read", "Mail.Send"]),
    )
    await client.close().catch(() => {})
    close()
  })
})
