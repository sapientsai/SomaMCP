import { z } from "zod"
import { describe, expect, it, vi } from "vitest"

// Imported from the published edge entry — the same path a Workers consumer uses,
// so this also guards the barrel's default-backend wiring.
import { createServer } from "../../src/edge.js"

const baseConfig = {
  enableDashboard: false,
  name: "edge-server",
  version: "1.0.0",
} as const

const rpc = (method: string, params?: unknown, id = 1, headers: Record<string, string> = {}) =>
  new Request("http://edge.test/mcp", {
    body: JSON.stringify({ id, jsonrpc: "2.0", method, params }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  })

const callTool = (name: string, args: Record<string, unknown> = {}) => rpc("tools/call", { arguments: args, name })

describe("createEdgeBackend", () => {
  it("is accepted as a backend factory by createServer", () => {
    const server = createServer({ ...baseConfig })
    expect(server.name).toBe("edge-server")
    expect(server.serverState).toBe("running")
    expect(server.sessions).toEqual([])
  })

  it("serves MCP tool calls through server.fetch", async () => {
    const server = createServer({ ...baseConfig })
    server.addTool({
      description: "Echo a message",
      execute: async ({ message }) => `echo: ${message}`,
      name: "echo",
      parameters: z.object({ message: z.string() }),
    })

    const res = await server.fetch(rpc("tools/call", { arguments: { message: "hi" }, name: "echo" }))
    expect(res.status).toBe(200)
    expect(JSON.stringify(await res.json())).toContain("echo: hi")
  })

  it("lists registered tools including the introspection tool", async () => {
    const server = createServer({ ...baseConfig })
    server.addTool({
      description: "Echo a message",
      execute: async () => "ok",
      name: "echo",
      parameters: z.object({ message: z.string() }),
    })

    const res = await server.fetch(rpc("tools/list"))
    const body = JSON.stringify(await res.json())
    expect(body).toContain("echo")
    expect(body).toContain("info")
  })

  it("somamcp's health artifact wins over EdgeFastMCP's built-in /health", async () => {
    const server = createServer({ ...baseConfig })

    const res = await server.fetch(new Request("http://edge.test/health"))
    expect(res.status).toBe(200)
    // EdgeFastMCP's own handler returns the text "✓ Ok"; somamcp returns JSON.
    expect(await res.json()).toEqual({ name: "edge-server", status: "running" })
  })

  it("falls back to EdgeFastMCP /health when somamcp's is disabled", async () => {
    const server = createServer({ ...baseConfig, enableHealthEndpoint: false })

    const res = await server.fetch(new Request("http://edge.test/health"))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("Ok")
  })

  it("serves artifacts and custom routes alongside MCP", async () => {
    const server = createServer({ ...baseConfig })
    server.addRoute({
      handler: (c) => c.json({ ok: true }),
      method: "POST",
      path: "/ingest",
    })

    const route = await server.fetch(new Request("http://edge.test/ingest", { method: "POST" }))
    expect(route.status).toBe(200)
    expect(await route.json()).toEqual({ ok: true })

    // and the MCP endpoint still resolves through the fallthrough
    const mcp = await server.fetch(rpc("tools/list"))
    expect(mcp.status).toBe(200)
  })

  it("tracks capabilities through the edge backend", () => {
    const server = createServer({ ...baseConfig })
    server.addTool({
      description: "Echo a message",
      execute: async () => "ok",
      name: "echo",
      parameters: z.object({ message: z.string() }),
    })

    expect(server.getInfo().name).toBe("edge-server")
    // Counts the built-in `info` tool as well as `echo` — the count must match
    // what tools/list actually serves.
    expect(server.getInfo().capabilities.tools).toBe(2)
    expect(
      server
        .getCapabilities()
        .tools.map((t) => t.name)
        .sort(),
    ).toEqual(["echo", "info"])
  })

  it("reports a capability count matching what tools/list serves", async () => {
    const server = createServer({ ...baseConfig })
    server.addTool({
      description: "Echo",
      execute: async () => "ok",
      name: "echo",
      parameters: z.object({}),
    })

    const body = (await (await server.fetch(rpc("tools/list"))).json()) as {
      result: { tools: Array<{ name: string }> }
    }

    // The reported bug: info reported 4 while 5 tools were exposed, because the
    // `info` tool registered straight on the backend and was never inventoried.
    expect(server.getInfo().capabilities.tools).toBe(body.result.tools.length)
  })

  it("keeps counting a tool the edge backend cannot actually remove", async () => {
    const server = createServer({ ...baseConfig, enableIntrospection: false })
    server.addTool({
      description: "Echo",
      execute: async () => "ok",
      name: "echo",
      parameters: z.object({}),
    })
    expect(server.getInfo().capabilities.tools).toBe(1)

    // EdgeFastMCP has no removal API, so `echo` is still served. The count must
    // not drop, or it would understate what tools/list returns.
    server.removeTool("echo")
    expect(server.getInfo().capabilities.tools).toBe(1)

    const body = (await (await server.fetch(rpc("tools/list"))).json()) as {
      result: { tools: Array<{ name: string }> }
    }
    expect(body.result.tools).toHaveLength(1)
    expect(server.getInfo().capabilities.tools).toBe(body.result.tools.length)
  })

  it("start and stop are inert", async () => {
    const server = createServer({ ...baseConfig })
    await expect(server.start()).resolves.toBeUndefined()
    await expect(server.stop()).resolves.toBeUndefined()
  })

  describe("authenticate", () => {
    const secured = {
      ...baseConfig,
      authenticate: async (req: unknown) => {
        const header = (req as Request).headers?.get("authorization")
        if (header !== "Bearer good") throw new Error("denied")
        return { user: "ops" }
      },
    }

    it("rejects unauthenticated MCP calls when authenticate is configured", async () => {
      const server = createServer(secured)
      server.addTool({
        description: "Echo",
        execute: async () => "ok",
        name: "echo",
        parameters: z.object({}),
      })

      const res = await server.fetch(callTool("echo"))
      expect(res.status).toBe(401)
    })

    it("allows MCP calls carrying valid credentials", async () => {
      const server = createServer(secured)
      server.addTool({
        description: "Echo",
        execute: async () => "ok",
        name: "echo",
        parameters: z.object({}),
      })

      const res = await server.fetch(
        rpc("tools/call", { arguments: {}, name: "echo" }, 1, {
          authorization: "Bearer good",
        }),
      )
      expect(res.status).toBe(200)
      expect(JSON.stringify(await res.json())).toContain("ok")
    })

    it("leaves the MCP endpoint open when no authenticate is configured", async () => {
      const server = createServer({ ...baseConfig })
      const res = await server.fetch(rpc("tools/list"))
      expect(res.status).toBe(200)
    })
  })

  describe("tool errors", () => {
    it("surfaces a thrown tool error as a JSON-RPC error, not a success", async () => {
      const server = createServer({ ...baseConfig })
      server.addTool({
        description: "Always fails",
        execute: async () => {
          throw new Error("boom")
        },
        name: "explode",
        parameters: z.object({}),
      })

      // The telemetry wrapper converts throws into `isError: true`, and EdgeFastMCP
      // drops `isError` — without the adapter rethrowing, this would look like a
      // successful call.
      const body = (await (await server.fetch(callTool("explode"))).json()) as Record<string, unknown>
      expect(body.error).toBeDefined()
      expect(body.result).toBeUndefined()
    })

    it("surfaces an explicit isError result as a JSON-RPC error", async () => {
      const server = createServer({ ...baseConfig })
      server.addTool({
        description: "Returns an error result",
        execute: async () => ({
          content: [{ text: "bad input", type: "text" as const }],
          isError: true,
        }),
        name: "invalid",
        parameters: z.object({}),
      })

      const body = (await (await server.fetch(callTool("invalid"))).json()) as Record<string, unknown>
      expect(body.error).toBeDefined()
      expect(JSON.stringify(body.error)).toContain("bad input")
    })

    it("still returns successful results as results", async () => {
      const server = createServer({ ...baseConfig })
      server.addTool({
        description: "Works",
        execute: async () => "fine",
        name: "ok",
        parameters: z.object({}),
      })

      const body = (await (await server.fetch(callTool("ok"))).json()) as Record<string, unknown>
      expect(body.error).toBeUndefined()
      expect(JSON.stringify(body.result)).toContain("fine")
    })
  })

  it("warns when a resource returns multiple results instead of truncating silently", async () => {
    const warn = vi.fn()
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), warn }
    const server = createServer({ ...baseConfig, logger })
    server.addResource({
      description: "Two results",
      load: async () => [{ text: "first" }, { text: "second" }],
      name: "multi",
      uri: "test://multi",
    })

    const res = await server.fetch(rpc("resources/read", { uri: "test://multi" }))
    expect(JSON.stringify(await res.json())).toContain("first")
    expect(warn.mock.calls.some((c) => String(c[0]).includes("only the first is served"))).toBe(true)
  })

  it("warns instead of silently dropping unsupported operations", () => {
    const warn = vi.fn()
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), warn }
    const server = createServer({ ...baseConfig, logger })

    server.removeTool("echo")
    server.addResourceTemplate({})

    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0]?.[0]).toContain("removeTool")
    expect(warn.mock.calls[1]?.[0]).toContain("addResourceTemplate")
  })
})
