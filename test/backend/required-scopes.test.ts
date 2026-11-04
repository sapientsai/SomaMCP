import { describe, expect, it, vi } from "vitest"

import { createServer } from "../../src/index.js"
import type { AuthProvider } from "../../src/types/auth.js"
import { rawRequest } from "./sdk-clients.js"

const serverWith = (session: Record<string, unknown>, auth?: AuthProvider<Record<string, unknown>>) => {
  const execute = vi.fn(async () => "ran")
  const server = createServer<Record<string, unknown>>({
    ...(auth ? { auth } : { authenticate: () => Promise.resolve(session) }),
    enableDashboard: false,
    enableInfoEndpoint: false,
    name: "s",
    version: "1.0.0",
  })
  server.addTool({ execute, name: "send-mail", requiredScopes: ["Mail.Send"] })
  server.addTool({ execute: async () => "open", name: "open" })
  return { execute, fetch: server.fetch }
}

const call = (name: string) => rawRequest("tools/call", { arguments: {}, name })

describe("a tool's requiredScopes", () => {
  it("answers a session without them with a 403 that asks for them, keeping what it has", async () => {
    const { execute, fetch } = serverWith({ scopes: ["User.Read"] })
    const response = await fetch(call("send-mail"))
    expect(response.status).toBe(403)
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope", scope="User.Read Mail.Send"',
    )
    expect(await response.json()).toMatchObject({ error: { code: -32000 }, id: 1, jsonrpc: "2.0" })
    expect(execute).not.toHaveBeenCalled()
  })

  it("runs the tool for a session with them, in an array or a Set", async () => {
    for (const scopes of [["Mail.Send"], new Set(["Mail.Send"])]) {
      const { execute, fetch } = serverWith({ scopes })
      const response = await fetch(call("send-mail"))
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("ran")
      expect(execute).toHaveBeenCalledTimes(1)
    }
  })

  it("refuses a session with no scopes at all", async () => {
    const { fetch } = serverWith({})
    const response = await fetch(call("send-mail"))
    expect(response.status).toBe(403)
    expect(response.headers.get("www-authenticate")).toBe('Bearer error="insufficient_scope", scope="Mail.Send"')
  })

  it("leaves other tools and other methods alone", async () => {
    const { fetch } = serverWith({ scopes: [] })
    expect((await fetch(call("open"))).status).toBe(200)
  })

  it("keeps the tool listed", async () => {
    const { fetch } = serverWith({ scopes: [] })
    expect(await (await fetch(rawRequest("tools/list"))).text()).toContain("send-mail")
  })

  it("catches the call inside a batch", async () => {
    const { execute, fetch } = serverWith({ scopes: [] })
    const single = call("send-mail")
    const batch = new Request(single.url, {
      body: JSON.stringify([
        { id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name: "send-mail" } },
      ]),
      headers: single.headers,
      method: "POST",
    })
    const response = await fetch(batch)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ id: null })
    expect(execute).not.toHaveBeenCalled()
  })

  it("doesn't reveal a tool canAccess hides", async () => {
    const server = createServer<Record<string, unknown>>({
      authenticate: () => Promise.resolve({ scopes: [] }),
      enableDashboard: false,
      enableInfoEndpoint: false,
      name: "s",
      version: "1.0.0",
    })
    server.addTool({ canAccess: () => false, execute: async () => "x", name: "secret", requiredScopes: ["A"] })
    const response = await server.fetch(call("secret"))
    expect(response.status).not.toBe(403)
    expect(await response.text()).toContain("Unknown tool")
  })

  it(
    "doesn't hang on a body over the limit with no Content-Length: the SDK answers 413",
    { timeout: 2000 },
    async () => {
      const server = createServer<Record<string, unknown>>({
        authenticate: () => Promise.resolve({ scopes: [] }),
        enableDashboard: false,
        enableInfoEndpoint: false,
        maxRequestBodySize: 200,
        name: "s",
        version: "1.0.0",
      })
      server.addTool({ execute: async () => "x", name: "send-mail", requiredScopes: ["A"] })
      const single = call("send-mail")
      const oversized = new Request(single.url, {
        body: JSON.stringify({ padding: "x".repeat(1000) }),
        headers: single.headers,
        method: "POST",
      })
      expect(oversized.headers.get("content-length")).toBeNull()
      expect((await server.fetch(oversized)).status).toBe(413)
    },
  )

  it("reports a canAccess that throws as the SDK does, not as a bare 500", async () => {
    const server = createServer<Record<string, unknown>>({
      authenticate: () => Promise.resolve({ scopes: [] }),
      enableDashboard: false,
      enableInfoEndpoint: false,
      name: "s",
      version: "1.0.0",
    })
    server.addTool({ execute: async () => "x", name: "gated", requiredScopes: ["A"] })
    server.addTool({
      canAccess: () => {
        throw new TypeError("no roles")
      },
      execute: async () => "x",
      name: "other",
    })
    const response = await server.fetch(call("other"))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("no roles")
  })

  it("uses the provider's scopeChallenge when it has one", async () => {
    const scopeChallenge = vi.fn(() => new Response("custom", { status: 403 }))
    const { fetch } = serverWith({}, { authenticate: () => Promise.resolve({ scopes: ["User.Read"] }), scopeChallenge })
    expect(await (await fetch(call("send-mail"))).text()).toBe("custom")
    expect(scopeChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "/mcp", granted: ["User.Read"], required: ["Mail.Send"], requestId: 1 }),
    )
  })

  it("leaves a scope out of the header when it can't be written there", async () => {
    const { fetch } = serverWith({ scopes: ['bad"scope', "line\nbreak", "User.Read"] })
    const response = await fetch(call("send-mail"))
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope", scope="User.Read Mail.Send"',
    )
  })
})
