// createServer({ auth }): an auth provider's authenticate, routes and 401 challenge on the SDK backend.
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { createServer } from "../../src/index.js"
import type { AuthChallenge, AuthProvider } from "../../src/types/auth.js"
import { ERAS, MCP_URL, rawRequest, withHeader } from "./sdk-clients.js"

type Session = { accessToken: string }

const describeError = (error: unknown): string => (error instanceof Error ? error.message : `raw:${String(error)}`)

const provider = (overrides: Partial<AuthProvider<Session>> = {}): AuthProvider<Session> => ({
  authenticate: (request) =>
    Promise.resolve(
      request?.headers.get("authorization") === "Bearer good" ? { accessToken: "upstream-token" } : undefined,
    ),
  challenge: (challenge: AuthChallenge) =>
    new Response(
      JSON.stringify({
        endpoint: challenge.endpoint,
        error: "error" in challenge ? describeError(challenge.error) : "none",
        method: challenge.request.method,
        requestId: challenge.requestId,
      }),
      { headers: { "WWW-Authenticate": `Bearer resource_metadata="${challenge.endpoint}"` }, status: 401 },
    ),
  routes: (endpoint) => [
    { handler: (c) => c.json({ endpoint: endpoint() }), method: "GET", path: "/.well-known/test" },
  ],
  ...overrides,
})

const makeServer = (options: Partial<Parameters<typeof createServer<Session>>[0]> = {}) => {
  const server = createServer<Session>({
    auth: provider(),
    enableDashboard: false,
    name: "auth",
    version: "1.0.0",
    ...options,
  })
  server.addTool({
    execute: (_args, context) => Promise.resolve(`token: ${context.session?.accessToken}`),
    name: "whoami",
    parameters: z.object({}),
  })
  return server
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(MCP_URL, {
    body: JSON.stringify(body),
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
    method: "POST",
  })

describe("createServer({ auth })", () => {
  it.each(ERAS)("a tool sees the provider's session as context.session (%s)", async (_era, connect) => {
    const client = await connect(withHeader(makeServer(), "authorization", "Bearer good"))
    const result = await client.callTool({ arguments: {}, name: "whoami" })
    expect(JSON.stringify(result)).toContain("token: upstream-token")
  })

  it("answers a request without a session with the provider's challenge, echoing its JSON-RPC id", async () => {
    const res = await makeServer().fetch(post({ id: 7, jsonrpc: "2.0", method: "tools/list" }))
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toBe('Bearer resource_metadata="/mcp"')
    expect(await res.json()).toEqual({ endpoint: "/mcp", error: "none", method: "POST", requestId: 7 })
  })

  it.each([
    ["a GET", new Request(MCP_URL, { method: "GET" })],
    ["a batch", post([{ id: 1, jsonrpc: "2.0", method: "tools/list" }])],
    ["a body that is not JSON", new Request(MCP_URL, { body: "nope", method: "POST" })],
  ])("gives the challenge a null id for %s", async (_case, request) => {
    const res = await makeServer().fetch(request)
    expect(((await res.json()) as AuthChallenge).requestId).toBeNull()
  })

  it("reads no more than 64 KiB of a rejected request for its id, whatever maxRequestBodySize allows", async () => {
    const server = makeServer({ maxRequestBodySize: 10 * 1024 * 1024 })
    const sized = (pad: number) =>
      post({ id: 3, jsonrpc: "2.0", method: "tools/list", params: { pad: "x".repeat(pad) } })
    expect(((await (await server.fetch(sized(60 * 1024))).json()) as AuthChallenge).requestId).toBe(3)
    const big = await server.fetch(sized(65 * 1024))
    expect(big.status).toBe(401)
    expect(((await big.json()) as AuthChallenge).requestId).toBeNull()
  })

  it("does not read a body over maxRequestBodySize for the id", async () => {
    const res = await makeServer({ maxRequestBodySize: 64 }).fetch(
      post({ id: 3, jsonrpc: "2.0", method: "tools/list", params: { pad: "x".repeat(200) } }),
    )
    expect(((await res.json()) as AuthChallenge).requestId).toBeNull()
  })

  it("passes what authenticate threw to the challenge", async () => {
    const server = makeServer({ auth: provider({ authenticate: () => Promise.reject(new Error("store down")) }) })
    const res = await server.fetch(rawRequest("tools/list", {}, { modern: true }))
    expect(await res.json()).toMatchObject({ error: "store down", requestId: 1 })
  })

  it("serves a rejected Response as-is, not the challenge", async () => {
    const teapot = new Response("teapot", { status: 418 })
    const server = makeServer({ auth: provider({ authenticate: () => Promise.reject(teapot) }) })
    const res = await server.fetch(rawRequest("tools/list", {}, { modern: true }))
    expect(res.status).toBe(418)
  })

  it("answers a plain 401 when the provider has no challenge", async () => {
    const res = await makeServer({ auth: provider({ challenge: undefined }) }).fetch(rawRequest("tools/list"))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "Unauthorized" })
  })

  it("lets an explicit authenticate decide sessions, keeping the provider's challenge", async () => {
    const server = makeServer({
      authenticate: (request) =>
        Promise.resolve(
          request?.headers.get("x-key") === "k" ? { accessToken: "from-explicit" } : (undefined as unknown as Session),
        ),
    })
    const ok = await server.fetch(
      rawRequest("tools/call", { arguments: {}, name: "whoami" }, { headers: { "x-key": "k" }, modern: true }),
    )
    expect(await ok.text()).toContain("token: from-explicit")
    const provided = await server.fetch(
      rawRequest("tools/list", {}, { headers: { authorization: "Bearer good" }, modern: true }),
    )
    expect(provided.status).toBe(401)
    expect(provided.headers.get("www-authenticate")).toContain("resource_metadata")
  })

  it("serves the provider's routes without authentication", async () => {
    const res = await makeServer().fetch(new Request("http://sdk.test/.well-known/test"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ endpoint: "/mcp" })
  })

  it("gives routes and the challenge the configured MCP path", async () => {
    const server = makeServer({ backendOptions: { mcpPath: "/rpc" } })
    expect(await (await server.fetch(new Request("http://sdk.test/.well-known/test"))).json()).toEqual({
      endpoint: "/rpc",
    })
    const res = await server.fetch(new Request("http://sdk.test/rpc", { method: "GET" }))
    expect(((await res.json()) as AuthChallenge).endpoint).toBe("/rpc")
  })

  it("protects routes with the provider's authenticate, answering their own 401 rather than the challenge", async () => {
    const server = makeServer()
    server.addRoute({ handler: (c) => c.text("secret"), method: "GET", path: "/private", protected: true })
    const denied = await server.fetch(new Request("http://sdk.test/private"))
    expect(denied.status).toBe(401)
    expect(denied.headers.get("www-authenticate")).toBeNull()
    const allowed = await server.fetch(
      new Request("http://sdk.test/private", { headers: { authorization: "Bearer good" } }),
    )
    expect(await allowed.text()).toBe("secret")
  })

  it("gives the challenge a null id when authenticate already read the body", async () => {
    const reader = provider({
      authenticate: async (request) => {
        await request?.json()
        return undefined
      },
    })
    const res = await makeServer({ auth: reader }).fetch(post({ id: 4, jsonrpc: "2.0", method: "tools/list" }))
    expect(res.status).toBe(401)
    expect(((await res.json()) as AuthChallenge).requestId).toBeNull()
  })

  it("does not read a body whose declared length is over the bound", async () => {
    const res = await makeServer({ maxRequestBodySize: 64 }).fetch(
      post({ id: 5, jsonrpc: "2.0", method: "tools/list" }, { "content-length": "999999" }),
    )
    expect(((await res.json()) as AuthChallenge).requestId).toBeNull()
  })

  it("leaves error out when authenticate resolved to no session, and passes a non-Error throw as-is", async () => {
    const none = await makeServer().fetch(rawRequest("tools/list", {}, { modern: true }))
    expect(await none.json()).toMatchObject({ error: "none" })
    const thrown = makeServer({ auth: provider({ authenticate: () => Promise.reject("nope") }) })
    const res = await thrown.fetch(rawRequest("tools/list", {}, { modern: true }))
    expect(await res.json()).toMatchObject({ error: "raw:nope" })
  })

  it("gives the challenge the request", async () => {
    const res = await makeServer().fetch(new Request(MCP_URL, { method: "DELETE" }))
    expect(await res.json()).toMatchObject({ method: "DELETE" })
  })

  it("protects artifacts with the provider's authenticate", async () => {
    const server = makeServer({ enableDashboard: true })
    expect((await server.fetch(new Request("http://sdk.test/dashboard"))).status).toBe(401)
    const allowed = await server.fetch(
      new Request("http://sdk.test/dashboard", { headers: { authorization: "Bearer good" } }),
    )
    expect(allowed.status).toBe(200)
  })

  it("protects routes with an explicit authenticate over the provider's", async () => {
    const server = makeServer({
      authenticate: (request) =>
        Promise.resolve(
          request?.headers.get("x-key") === "k" ? { accessToken: "explicit" } : (undefined as unknown as Session),
        ),
    })
    server.addRoute({ handler: (c) => c.text("secret"), method: "GET", path: "/private", protected: true })
    const provided = await server.fetch(
      new Request("http://sdk.test/private", { headers: { authorization: "Bearer good" } }),
    )
    expect(provided.status).toBe(401)
    const explicit = await server.fetch(new Request("http://sdk.test/private", { headers: { "x-key": "k" } }))
    expect(await explicit.text()).toBe("secret")
  })
})
