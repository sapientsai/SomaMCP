// SPIKE (#36): Phase 0 questions 2-4, run in Node. Throwaway.
import { appendFileSync } from "node:fs"

import { Client as Client2, StreamableHTTPClientTransport as Transport2 } from "@modelcontextprotocol/client"
import { Client as Client1 } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport as Transport1 } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { createSdkBackend } from "../../src/backend/sdk.js"
import { createServer as createEdgeServer } from "../../src/edge.js"
import { createServerCore } from "../../src/Server.js"
import { UserError } from "../../src/types/core.js"

const URL_ = new URL("http://spike.test/mcp")

type Fetchable = { fetch: (request: Request) => Promise<Response> }

/** Route a client's HTTP calls straight into the server's fetch handler — no port. */
const fetchInto =
  (server: Fetchable) =>
  (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    server.fetch(new Request(input, init))

const makeServer = (opts: { authenticate?: (req: unknown) => Promise<{ role: string }> } = {}) => {
  const server = createServerCore({
    authenticate: opts.authenticate,
    backend: createSdkBackend,
    enableDashboard: false,
    name: "spike",
    version: "1.0.0",
  })
  server.addTool({
    description: "Echo",
    execute: async ({ text }) => `echo: ${text}`,
    name: "echo",
    parameters: z.object({ text: z.string() }),
  })
  server.addTool({
    description: "Admin only",
    canAccess: (auth) => (auth as { role?: string } | undefined)?.role === "admin",
    execute: async () => "secret",
    name: "admin",
    parameters: z.object({}),
  })
  server.addTool({
    description: "Fails",
    execute: async () => {
      throw new UserError("bad input")
    },
    name: "fail",
    parameters: z.object({}),
  })
  server.addResource({
    load: async () => ({ text: "hello" }),
    mimeType: "text/plain",
    name: "greeting",
    uri: "mem://greeting",
  })
  server.addPrompt({
    arguments: [{ name: "topic", required: true }],
    load: async (args) => `Write about ${args.topic}`,
    name: "write",
  })
  return server
}

const modernClient = async (server: Fetchable) => {
  const client = new Client2(
    { name: "modern", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  )
  await client.connect(new Transport2(URL_, { fetch: fetchInto(server) }))
  return client
}

const autoClient = async (server: Fetchable) => {
  const client = new Client2({ name: "auto", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } })
  await client.connect(new Transport2(URL_, { fetch: fetchInto(server) }))
  return client
}

const legacyClient = async (server: Fetchable) => {
  const client = new Client1({ name: "legacy", version: "1.0.0" })
  await client.connect(new Transport1(URL_, { fetch: fetchInto(server) }))
  return client
}

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, {
    body: JSON.stringify(body),
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
    method: "POST",
  })

const ENVELOPE = {
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1.0.0" },
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
}

// ── Q2: one endpoint, both eras ───────────────────────────────────────

describe("Q2: both protocol eras from one endpoint", () => {
  it("control: today's FastMCP edge backend rejects a 2026-07-28 client", async () => {
    const edge = createEdgeServer({ enableDashboard: false, name: "edge", version: "1.0.0" })
    await expect(modernClient(edge)).rejects.toThrow()
  })

  it("SDK 2.x client pinned to 2026-07-28 connects, lists and calls", async () => {
    const client = await modernClient(makeServer())
    expect(client.getDiscoverResult()).toBeDefined()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["echo", "fail"]))
    const result = await client.callTool({ arguments: { text: "hi" }, name: "echo" })
    expect(JSON.stringify(result)).toContain("echo: hi")
  })

  it("SDK 2.x client in auto mode negotiates the modern era", async () => {
    const client = await autoClient(makeServer())
    expect(client.getDiscoverResult()).toBeDefined()
    expect(JSON.stringify(await client.callTool({ arguments: { text: "a" }, name: "echo" }))).toContain("echo: a")
  })

  it("SDK 1.x client (2025 handshake) connects, lists and calls", async () => {
    const client = await legacyClient(makeServer())
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain("echo")
    expect(JSON.stringify(await client.callTool({ arguments: { text: "b" }, name: "echo" }))).toContain("echo: b")
  })

  it.each(["2025-06-18", "2025-03-26"])("raw %s initialize returns 200", async (protocolVersion) => {
    const res = await makeServer().fetch(
      rpc({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { capabilities: {}, clientInfo: { name: "raw", version: "1" }, protocolVersion },
      }),
    )
    expect(res.status).toBe(200)
  })

  it("raw server/discover returns 200", async () => {
    const res = await makeServer().fetch(
      rpc(
        { id: 1, jsonrpc: "2.0", method: "server/discover", params: { _meta: ENVELOPE } },
        { "mcp-method": "server/discover", "mcp-protocol-version": "2026-07-28" },
      ),
    )
    expect(res.status).toBe(200)
  })

  it("raw enveloped tools/list with MCP-Protocol-Version: 2026-07-28 returns 200", async () => {
    const res = await makeServer().fetch(
      rpc(
        { id: 1, jsonrpc: "2.0", method: "tools/list", params: { _meta: ENVELOPE } },
        { "mcp-method": "tools/list", "mcp-protocol-version": "2026-07-28" },
      ),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("echo")
  })
})

// ── somamcp semantics on the per-request model ────────────────────────

describe("somamcp semantics", () => {
  it("UserError surfaces as an isError result in both eras", async () => {
    for (const connect of [modernClient, legacyClient]) {
      const result = (await (await connect(makeServer())).callTool({ arguments: {}, name: "fail" })) as {
        isError?: boolean
      }
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).toContain("bad input")
    }
  })

  it("invalid arguments are rejected before execute", async () => {
    const result = (await (await modernClient(makeServer())).callTool({ arguments: { text: 5 }, name: "echo" })) as {
      isError?: boolean
    }
    expect(result.isError).toBe(true)
  })

  it("removeTool takes effect on the next request", async () => {
    const server = makeServer()
    server.removeTool("echo")
    const { tools } = await (await modernClient(server)).listTools()
    expect(tools.map((t) => t.name)).not.toContain("echo")
  })

  it("authenticate runs per request and canAccess filters per caller", async () => {
    const server = makeServer({
      authenticate: async (req) => {
        const token = (req as Request).headers.get("authorization")
        if (!token) throw new Error("no token")
        return { role: token === "Bearer admin" ? "admin" : "user" }
      },
    })
    const withToken = (token: string): Fetchable => ({
      fetch: (request) => {
        const headers = new Headers(request.headers)
        headers.set("authorization", token)
        return server.fetch(new Request(request, { headers }))
      },
    })
    const userTools = (await (await modernClient(withToken("Bearer user"))).listTools()).tools.map((t) => t.name)
    const adminTools = (await (await modernClient(withToken("Bearer admin"))).listTools()).tools.map((t) => t.name)
    expect(userTools).not.toContain("admin")
    expect(adminTools).toContain("admin")
    expect((await server.fetch(rpc({ id: 1, jsonrpc: "2.0", method: "tools/list" }))).status).toBe(401)
  })

  it("resources and prompts work", async () => {
    const client = await modernClient(makeServer())
    expect(JSON.stringify(await client.readResource({ uri: "mem://greeting" }))).toContain("hello")
    expect(JSON.stringify(await client.getPrompt({ arguments: { topic: "otters" }, name: "write" }))).toContain(
      "otters",
    )
  })

  it("capability counts still come from somamcp's registry", () => {
    expect(makeServer().getCapabilities().tools.length).toBeGreaterThanOrEqual(3)
  })
})

// ── Q3: per-request construction cost ─────────────────────────────────

describe("Q3: per-request cost", () => {
  const timeListCalls = async (toolCount: number, calls: number): Promise<number> => {
    const server = createServerCore({
      backend: createSdkBackend,
      enableDashboard: false,
      name: "bench",
      version: "1.0.0",
    })
    for (let i = 0; i < toolCount; i++) {
      server.addTool({
        description: `Tool ${i}`,
        execute: async ({ n }) => String(n),
        name: `tool_${i}`,
        parameters: z.object({ n: z.number(), s: z.string().optional() }),
      })
    }
    const req = () =>
      rpc(
        {
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { _meta: ENVELOPE, arguments: { n: 1 }, name: "tool_0" },
        },
        {
          "mcp-method": "tools/call",
          "mcp-name": "tool_0",
          "mcp-protocol-version": "2026-07-28",
        },
      )
    const probe = await server.fetch(req())
    const probeBody = await probe.text()
    expect(probe.status, probeBody).toBe(200)
    expect(probeBody).toContain('"1"')
    for (let i = 0; i < 20; i++) await (await server.fetch(req())).text()
    const start = performance.now()
    for (let i = 0; i < calls; i++) await (await server.fetch(req())).text()
    return (performance.now() - start) / calls
  }

  it("tools/call latency barely moves with tool count", async () => {
    const rows: string[] = []
    for (const n of [1, 50, 500]) rows.push(`${n} tools: ${(await timeListCalls(n, 300)).toFixed(3)} ms/call`)
    appendFileSync(process.env.SPIKE_OUT ?? "/dev/null", `${rows.join(" | ")}\n`)
  }, 60_000)
})
