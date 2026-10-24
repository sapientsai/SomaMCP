import { Option } from "functype"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { createSdkBackend } from "../../src/backend/index.js"
import { createToolContext } from "../../src/backend/sdk/mapping.js"
import { createServer } from "../../src/index.js"
import { UserError } from "../../src/types/core.js"
import {
  connectAuto,
  connectLegacy,
  connectModern,
  ERAS,
  type Fetchable,
  rawRequest,
  withHeader,
} from "./sdk-clients.js"

type ServerOptions = Partial<Parameters<typeof createServer>[0]>

const makeServer = (options: ServerOptions = {}) => {
  const server = createServer({
    backend: createSdkBackend,
    enableDashboard: false,
    name: "sdk",
    version: "1.0.0",
    ...options,
  })
  server.addTool({
    description: "Echo the text back",
    execute: (args) => Promise.resolve(`echo: ${args.text}`),
    name: "echo",
    parameters: z.object({ text: z.string() }),
  })
  return server
}

const textOf = (result: unknown): string => JSON.stringify(result)

describe("createSdkBackend", () => {
  describe("protocol eras", () => {
    it.each(ERAS)("a %s client lists and calls tools", async (_era, connect) => {
      const client = await connect(makeServer())
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("echo")
      expect(textOf(await client.callTool({ arguments: { text: "hi" }, name: "echo" }))).toContain("echo: hi")
    })

    it("a pinned 2026-07-28 client negotiates the modern era", async () => {
      expect((await connectModern(makeServer())).getDiscoverResult()).toBeDefined()
    })

    it("an auto-negotiating SDK 2.x client picks the modern era", async () => {
      expect((await connectAuto(makeServer())).getDiscoverResult()).toBeDefined()
    })

    it.each(["2025-11-25", "2025-06-18", "2025-03-26"])("a raw %s initialize returns 200", async (protocolVersion) => {
      const res = await makeServer().fetch(
        rawRequest("initialize", { capabilities: {}, clientInfo: { name: "raw", version: "1" }, protocolVersion }),
      )
      expect(res.status).toBe(200)
    })

    it.each(["server/discover", "tools/list"])("a raw enveloped %s returns 200", async (method) => {
      const res = await makeServer().fetch(rawRequest(method, {}, { modern: true }))
      expect(res.status).toBe(200)
    })
  })

  describe("tools", () => {
    it.each(ERAS)("advertises schema, annotations and _meta (%s)", async (_era, connect) => {
      const server = makeServer()
      server.addTool({
        _meta: { ui: { resourceUri: "ui://card" } },
        annotations: { readOnlyHint: true, title: "Look up" },
        description: "Look something up",
        execute: () => Promise.resolve("ok"),
        name: "lookup",
        outputSchema: z.object({ answer: z.string() }),
        parameters: z.object({ query: z.string(), limit: z.number().optional() }),
      })
      const tool = (await (await connect(server)).listTools()).tools.find((t) => t.name === "lookup")
      expect(tool?.inputSchema).toMatchObject({ properties: { query: { type: "string" } }, required: ["query"] })
      expect(tool?.outputSchema).toMatchObject({ properties: { answer: { type: "string" } } })
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, title: "Look up" })
      expect(tool?._meta).toMatchObject({ ui: { resourceUri: "ui://card" } })
    })

    it.each(ERAS)("a thrown UserError becomes an isError result (%s)", async (_era, connect) => {
      const server = makeServer()
      server.addTool({
        execute: () => Promise.reject(new UserError("bad input")),
        name: "fail",
        parameters: z.object({}),
      })
      const result = (await (await connect(server)).callTool({ arguments: {}, name: "fail" })) as { isError?: boolean }
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain("bad input")
    })

    it("rejects invalid arguments before execute runs", async () => {
      const execute = vi.fn(() => Promise.resolve("ran"))
      const server = makeServer()
      server.addTool({ execute, name: "strict", parameters: z.object({ n: z.number() }) })
      const result = (await (await connectModern(server)).callTool({ arguments: { n: "x" }, name: "strict" })) as {
        isError?: boolean
      }
      expect(result.isError).toBe(true)
      expect(execute).not.toHaveBeenCalled()
    })

    it("enforces timeoutMs", async () => {
      const server = makeServer()
      server.addTool({
        execute: () => new Promise((resolve) => setTimeout(() => resolve("late"), 500)),
        name: "slow",
        parameters: z.object({}),
        timeoutMs: 20,
      })
      const result = (await (await connectModern(server)).callTool({ arguments: {}, name: "slow" })) as {
        isError?: boolean
      }
      expect(result.isError).toBe(true)
      expect(textOf(result)).toContain("timed out after 20ms")
    })

    it("accepts every somamcp result shape", async () => {
      const server = makeServer()
      server.addTool({ execute: () => Promise.resolve(), name: "nothing", parameters: z.object({}) })
      server.addTool({
        execute: () => Promise.resolve({ text: "one part", type: "text" as const }),
        name: "part",
        parameters: z.object({}),
      })
      const client = await connectModern(server)
      expect(await client.callTool({ arguments: {}, name: "nothing" })).toMatchObject({ content: [] })
      expect(textOf(await client.callTool({ arguments: {}, name: "part" }))).toContain("one part")
    })

    it("removeTool applies from the next request", async () => {
      const server = makeServer()
      server.removeTool("echo")
      expect((await (await connectModern(server)).listTools()).tools.map((t) => t.name)).not.toContain("echo")
    })

    it("streams progress and log notifications on the call's own response", async () => {
      const server = makeServer()
      server.addTool({
        execute: async (_args, context) => {
          context.log.info("working")
          await context.reportProgress({ progress: 1, total: 2 })
          return "done"
        },
        name: "report",
        parameters: z.object({}),
      })
      const client = await connectModern(server)
      const progress = vi.fn()
      const result = await client.callTool({ arguments: {}, name: "report" }, { onprogress: progress })
      expect(textOf(result)).toContain("done")
      expect(progress).toHaveBeenCalledWith(expect.objectContaining({ progress: 1, total: 2 }))
    })

    it.each([
      ["2026-07-28", true],
      ["2025", false],
    ])("writes SSE keepalive comments during a silent long call (%s)", async (_era, modern) => {
      const server = makeServer({ streamKeepalive: { enabled: true, intervalMs: 20 } })
      server.addTool({
        execute: () => new Promise((resolve) => setTimeout(() => resolve("done"), 150)),
        name: "long",
        parameters: z.object({}),
      })
      const res = await server.fetch(rawRequest("tools/call", { arguments: {}, name: "long" }, { modern }))
      const body = await res.text()
      expect(res.headers.get("content-type")).toContain("text/event-stream")
      expect(body).toMatch(/^:/m)
      expect(body).toContain("done")
    })

    it("without streamKeepalive a silent call is a plain JSON response", async () => {
      const res = await makeServer().fetch(
        rawRequest("tools/call", { arguments: { text: "x" }, name: "echo" }, { modern: true }),
      )
      expect(res.headers.get("content-type")).toContain("application/json")
    })

    describe("maxRequestBodySize", () => {
      const MIB = 1024 * 1024
      const echo = (text: string, modern: boolean) =>
        rawRequest("tools/call", { arguments: { text }, name: "echo" }, { modern })

      it.each([
        ["2026-07-28", true],
        ["2025", false],
      ])("answers 413 to a body over the SDK's 4 MiB default (%s)", async (_era, modern) => {
        const res = await makeServer().fetch(echo("x".repeat(5 * MIB), modern))
        expect(res.status).toBe(413)
      })

      it.each([
        ["2026-07-28", true],
        ["2025", false],
      ])("serves a body under a raised limit (%s)", async (_era, modern) => {
        const res = await makeServer({ maxRequestBodySize: 10 * MIB }).fetch(echo("x".repeat(5 * MIB), modern))
        expect(res.status).toBe(200)
        expect(await res.text()).toContain("echo: xxx")
      })

      it("answers 413 to a body over a lowered limit", async () => {
        const res = await makeServer({ maxRequestBodySize: 1024 }).fetch(echo("x".repeat(2048), true))
        expect(res.status).toBe(413)
      })
    })

    describe("context.log delivery", () => {
      const logging = () => {
        const server = makeServer()
        server.addTool({
          execute: (_args, context) => {
            context.log.info("working")
            return Promise.resolve("done")
          },
          name: "chatty",
          parameters: z.object({}),
        })
        return server
      }
      const call = (modern: boolean, meta: Record<string, unknown> = {}) =>
        logging().fetch(rawRequest("tools/call", { _meta: meta, arguments: {}, name: "chatty" }, { modern }))

      it("reaches a 2026-07-28 client that asked for a log level", async () => {
        const body = await (await call(true, { "io.modelcontextprotocol/logLevel": "info" })).text()
        expect(body).toContain("notifications/message")
        expect(body).toContain("working")
      })

      it("is dropped for a 2026-07-28 client that asked for no log level", async () => {
        const body = await (await call(true)).text()
        expect(body).not.toContain("notifications/message")
        expect(body).toContain("done")
      })

      it("reaches a 2025 client on the stateless leg", async () => {
        const body = await (await call(false)).text()
        expect(body).toContain("notifications/message")
        expect(body).toContain("done")
      })
    })

    it("passes the client's version to the tool context", async () => {
      const server = makeServer()
      server.addTool({
        execute: (_args, context) => Promise.resolve(`client ${String(context.client.version)}`),
        name: "who",
        parameters: z.object({}),
      })
      expect(textOf(await (await connectModern(server)).callTool({ arguments: {}, name: "who" }))).toContain(
        "client 1.0.0",
      )
    })
  })

  describe("resources and prompts", () => {
    it.each(ERAS)("reads a resource, serving every result (%s)", async (_era, connect) => {
      const server = makeServer()
      server.addResource({
        load: () => Promise.resolve([{ text: "first" }, { text: "second", uri: "mem://notes/2" }]),
        mimeType: "text/plain",
        name: "notes",
        uri: "mem://notes",
      })
      const { contents } = await (await connect(server)).readResource({ uri: "mem://notes" })
      expect(contents).toEqual([
        { mimeType: "text/plain", text: "first", uri: "mem://notes" },
        { mimeType: "text/plain", text: "second", uri: "mem://notes/2" },
      ])
    })

    it.each(ERAS)("serves resource templates (%s)", async (_era, connect) => {
      const server = makeServer()
      server.addResourceTemplate({
        arguments: [{ name: "id", required: true }],
        load: (args: Record<string, string>) => Promise.resolve({ text: `doc ${args.id}` }),
        mimeType: "text/plain",
        name: "doc",
        uriTemplate: "docs://{id}",
      })
      const client = await connect(server)
      expect((await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate)).toEqual([
        "docs://{id}",
      ])
      expect(textOf(await client.readResource({ uri: "docs://42" }))).toContain("doc 42")
    })

    it("an unknown resource is a JSON-RPC error", async () => {
      await expect((await connectModern(makeServer())).readResource({ uri: "mem://missing" })).rejects.toThrow()
    })

    it.each(ERAS)("gets a prompt and enforces required arguments (%s)", async (_era, connect) => {
      const server = makeServer()
      server.addPrompt({
        arguments: [{ name: "topic", required: true }],
        load: (args) => Promise.resolve(`Write about ${args.topic}`),
        name: "write",
      })
      const client = await connect(server)
      expect(textOf(await client.getPrompt({ arguments: { topic: "otters" }, name: "write" }))).toContain("otters")
      await expect(client.getPrompt({ arguments: {}, name: "write" })).rejects.toThrow(/topic/)
    })

    it("completes prompt arguments from enum and from complete()", async () => {
      const server = makeServer()
      server.addPrompt({
        arguments: [
          { enum: ["formal", "friendly", "terse"], name: "tone" },
          { complete: (value) => Promise.resolve({ values: [`${value}-1`, `${value}-2`] }), name: "draft" },
        ],
        load: () => Promise.resolve("ok"),
        name: "letter",
      })
      const client = await connectModern(server)
      const tone = await client.complete({
        argument: { name: "tone", value: "f" },
        ref: { name: "letter", type: "ref/prompt" },
      })
      expect(tone.completion.values).toEqual(["formal", "friendly"])
      const draft = await client.complete({
        argument: { name: "draft", value: "v" },
        ref: { name: "letter", type: "ref/prompt" },
      })
      expect(draft.completion.values).toEqual(["v-1", "v-2"])
    })
  })

  describe("auth", () => {
    const secured = () =>
      makeServer({
        authenticate: (request: unknown) => {
          const header = (request as Request).headers.get("authorization")
          if (!header) return Promise.reject(new Error("no token"))
          return Promise.resolve({ role: header === "Bearer admin" ? "admin" : "user" })
        },
      })

    const addAdminTool = (server: ReturnType<typeof makeServer>) =>
      server.addTool({
        canAccess: (auth) => (auth as { role?: string } | undefined)?.role === "admin",
        execute: (_args, context) => Promise.resolve(`hello ${(context.session as { role: string }).role}`),
        name: "admin",
        parameters: z.object({}),
      })

    it.each(ERAS)("authenticate and canAccess apply per caller (%s)", async (_era, connect) => {
      const server = secured()
      addAdminTool(server)
      const names = async (target: Fetchable) => (await (await connect(target)).listTools()).tools.map((t) => t.name)
      expect(await names(withHeader(server, "authorization", "Bearer user"))).not.toContain("admin")
      expect(await names(withHeader(server, "authorization", "Bearer admin"))).toContain("admin")
      const call = await (
        await connect(withHeader(server, "authorization", "Bearer admin"))
      ).callTool({
        arguments: {},
        name: "admin",
      })
      expect(textOf(call)).toContain("hello admin")
    })

    it.each(ERAS)("a hidden tool can't be called, and looks like an unknown one (%s)", async (_era, connect) => {
      const server = secured()
      addAdminTool(server)
      const client = await connect(withHeader(server, "authorization", "Bearer user"))
      await expect(client.callTool({ arguments: {}, name: "admin" })).rejects.toThrow(/Unknown tool: admin/)
      await expect(client.callTool({ arguments: {}, name: "nope" })).rejects.toThrow(/Unknown tool: nope/)
    })

    it("treats a nullish authenticate result as unauthenticated, as FastMCP does", async () => {
      const server = makeServer({ authenticate: () => Promise.resolve(null as never) })
      expect((await server.fetch(rawRequest("tools/list"))).status).toBe(401)
    })

    it("treats a synchronously throwing authenticate as unauthenticated", async () => {
      const server = makeServer({
        authenticate: (() => {
          throw new Error("no headers on this request")
        }) as never,
      })
      expect((await server.fetch(rawRequest("tools/list"))).status).toBe(401)
    })

    it("never calls canAccess without a session when authenticate is not configured", async () => {
      const server = makeServer()
      server.addTool({
        // Written the natural way: it would throw if handed undefined.
        canAccess: (auth) => (auth as { role: string }).role === "admin",
        execute: () => Promise.resolve("ok"),
        name: "gated",
        parameters: z.object({}),
      })
      // No authenticate: like FastMCP, every tool is visible.
      expect((await (await connectModern(server)).listTools()).tools.map((t) => t.name)).toContain("gated")
    })

    it("answers 401 when authenticate rejects", async () => {
      expect((await secured().fetch(rawRequest("tools/list"))).status).toBe(401)
    })

    it("serves a Response that authenticate rejects with, as FastMCP does", async () => {
      const server = makeServer({
        authenticate: () => Promise.reject(new Response("go away", { status: 403 })),
      })
      const res = await server.fetch(rawRequest("tools/list"))
      expect(res.status).toBe(403)
      expect(await res.text()).toBe("go away")
    })
  })

  describe("hardening", () => {
    it("swallows notifications that fail after the client hung up", async () => {
      const failing = () => Promise.reject(new Error("Not connected"))
      const ctx = { mcpReq: { _meta: { progressToken: 1 }, id: 1, log: failing, notify: failing } } as never
      const context = createToolContext(ctx, Option.none<{ role: string }>(), "t")
      context.log.info("after disconnect")
      await context.reportProgress({ progress: 1 })
      await context.streamContent({ text: "x", type: "text" })
      // An unhandled rejection here would fail the run.
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    it("warns when a tool's schema can't describe itself as JSON Schema", () => {
      const warn = vi.fn()
      const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), warn }
      const server = makeServer({ logger })
      server.addTool({
        execute: () => Promise.resolve("ok"),
        name: "opaque",
        parameters: { "~standard": { validate: (value: unknown) => ({ value }), vendor: "custom", version: 1 } },
      })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('tool "opaque"'))
    })
  })

  describe("routing", () => {
    it("serves somamcp's own routes next to the MCP endpoint", async () => {
      const server = makeServer()
      const health = await server.fetch(new Request("http://sdk.test/health"))
      expect(health.status).toBe(200)
      await connectLegacy(server)
    })

    it("honours backendOptions.mcpPath", async () => {
      const server = makeServer({ backendOptions: { mcpPath: "/rpc" } })
      const client = await connectModern(server, new URL("http://sdk.test/rpc"))
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("echo")
    })

    it("still counts capabilities from somamcp's registry", () => {
      expect(
        makeServer()
          .getCapabilities()
          .tools.map((t) => t.name),
      ).toContain("echo")
    })
  })
})
