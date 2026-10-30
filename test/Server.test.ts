import { directSilentLogger } from "functype-log"
import { describe, expect, it } from "vitest"

import { z } from "zod"

import { createServer, type SessionAuth, type Tool, type ToolOptions } from "../src/index.js"
import type { TelemetryCollector, TelemetryEvent } from "../src/telemetry/TelemetryCollector.js"
import { connectModern, rawRequest } from "./backend/sdk-clients.js"

const createCollector = (): TelemetryCollector & {
  events: TelemetryEvent[]
} => {
  const events: TelemetryEvent[] = []
  return { events, recordEvent: (e) => events.push(e) }
}

describe("Server", () => {
  it("creates a server with default options", () => {
    const server = createServer({ name: "test-server", version: "1.0.0" })
    expect(server.name).toBe("test-server")
    expect(server.serverState).toBe("running")
  })

  it("registers tools with telemetry wrapping", async () => {
    const telemetry = createCollector()
    const server = createServer({
      enableDashboard: false,
      enableIntrospection: false,
      name: "tool-server",
      telemetry,
      version: "1.0.0",
    })

    server.addTool({
      execute: async () => "hello",
      name: "greet",
    })

    const capabilities = server.getCapabilities()
    expect(capabilities.tools).toHaveLength(1)
    expect(capabilities.tools[0]?.name).toBe("greet")
  })

  describe("per-tool captureConfig", () => {
    const makeServer = (telemetry: TelemetryCollector) =>
      createServer({ enableDashboard: false, enableIntrospection: false, name: "capture", telemetry, version: "1.0.0" })
    const call = (server: ReturnType<typeof makeServer>, name: string) =>
      server.fetch(rawRequest("tools/call", { arguments: { card: "4242", amount: 5 }, name }, { modern: true }))
    const toolEvent = (telemetry: { events: TelemetryEvent[] }, name: string) =>
      telemetry.events.find((e) => e.type === "tool.execute" && e.name === name)

    // An object literal is the documented shape (README "Per-tool capture configuration"),
    // so this also fails to compile if addTool's type stops accepting captureConfig.
    it("addTool honors captureConfig passed in the tool literal", async () => {
      const telemetry = createCollector()
      const server = makeServer(telemetry)
      server.addTool({
        captureConfig: { captureLevel: "full", redactInputFields: ["card"] },
        execute: async () => "paid",
        name: "pay",
        parameters: z.object({ amount: z.number(), card: z.string() }),
      })

      await call(server, "pay")

      expect(toolEvent(telemetry, "pay")?.input).toEqual({ amount: 5, card: "[REDACTED]" })
    })

    it("addTools honors captureConfig on each tool", async () => {
      const telemetry = createCollector()
      const server = makeServer(telemetry)
      server.addTools([
        {
          captureConfig: { captureLevel: "metadata" },
          execute: async () => "quiet",
          name: "quiet",
          parameters: z.object({ amount: z.number(), card: z.string() }),
        },
      ])

      await call(server, "quiet")

      const event = toolEvent(telemetry, "quiet")
      expect(event).toBeDefined()
      expect(event?.input).toBeUndefined()
      expect(event?.output).toBeUndefined()
    })
  })

  // Each call below also fails to compile if addTools goes back to one schema for the whole array.
  describe("addTools with different parameter schemas", () => {
    const makeServer = () =>
      createServer({ enableDashboard: false, enableIntrospection: false, name: "mixed", version: "1.0.0" })
    const textOf = (result: Awaited<ReturnType<Awaited<ReturnType<typeof connectModern>>["callTool"]>>) =>
      JSON.stringify(result.content)

    it("takes tools with different schemas in one literal array, and each execute keeps its own args", async () => {
      const server = makeServer()
      server.addTools([
        { execute: async (args) => args.word.toUpperCase(), name: "shout", parameters: z.object({ word: z.string() }) },
        { execute: async (args) => String(args.n * 2), name: "double", parameters: z.object({ n: z.number() }) },
        { execute: async () => "pong", name: "ping" },
      ])

      const client = await connectModern(server)
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["shout", "double", "ping"])
      expect(textOf(await client.callTool({ arguments: { word: "hi" }, name: "shout" }))).toContain("HI")
      expect(textOf(await client.callTool({ arguments: { n: 21 }, name: "double" }))).toContain("42")
    })

    it("takes typed tool values with different schemas, and Tool[] and readonly lists as before", () => {
      const word = z.object({ word: z.string() })
      const count = z.object({ n: z.number() })
      const shout: Tool<SessionAuth, typeof word> = {
        execute: async (args) => args.word,
        name: "shout",
        parameters: word,
      }
      const double: ToolOptions<SessionAuth, typeof count> = {
        captureConfig: { captureLevel: "metadata" },
        execute: async (args) => String(args.n),
        name: "double",
        parameters: count,
      }
      const listed: Tool[] = [{ execute: async () => "a", name: "a" }]
      const frozen: ReadonlyArray<ToolOptions> = [{ execute: async () => "b", name: "b" }]

      const server = makeServer()
      server.addTools([shout, double])
      server.addTools(listed)
      server.addTools(frozen)
      server.addTools([])

      expect(server.getCapabilities().tools.map((t) => t.name)).toEqual(["shout", "double", "a", "b"])
    })

    it("still checks each tool's args against its own schema, and refuses what is not a tool", () => {
      // Checked by the typecheck only: never called, since these tools are wrong on purpose.
      const refused = (server: ReturnType<typeof makeServer>) => {
        server.addTools([
          // @ts-expect-error `n` belongs to the other tool's schema
          { execute: async (args) => String(args.n), name: "shout", parameters: z.object({ word: z.string() }) },
          { execute: async (args) => String(args.n), name: "double", parameters: z.object({ n: z.number() }) },
        ])
        // @ts-expect-error `parameters` must be a Standard Schema
        server.addTools([{ execute: async () => "x", name: "bad", parameters: { word: "string" } }])
        // @ts-expect-error a tool needs a name
        server.addTools([{ execute: async () => "x" }])
      }
      expect(refused).toBeTypeOf("function")
    })
  })

  it("registers resources with telemetry wrapping", () => {
    const telemetry = createCollector()
    const server = createServer({
      enableDashboard: false,
      enableIntrospection: false,
      name: "res-server",
      telemetry,
      version: "1.0.0",
    })

    server.addResource({
      load: async () => ({ text: "data" }),
      name: "my-res",
      uri: "res://test",
    })

    const capabilities = server.getCapabilities()
    expect(capabilities.resources).toHaveLength(1)
    expect(capabilities.resources[0]?.name).toBe("my-res")
  })

  it("registers prompts with telemetry wrapping", () => {
    const telemetry = createCollector()
    const server = createServer({
      enableDashboard: false,
      enableIntrospection: false,
      name: "prompt-server",
      telemetry,
      version: "1.0.0",
    })

    server.addPrompt({
      load: async () => "answer",
      name: "my-prompt",
    })

    const capabilities = server.getCapabilities()
    expect(capabilities.prompts).toHaveLength(1)
    expect(capabilities.prompts[0]?.name).toBe("my-prompt")
  })

  it("reports health with stopped status before start", () => {
    const server = createServer({
      enableDashboard: false,
      enableIntrospection: false,
      name: "health-server",
      version: "1.0.0",
    })

    const health = server.getHealth()
    expect(health.status).toBe("running")
    expect(health.name).toBe("health-server")
    expect(health.uptime).toBe(0)
    expect(health.activeSessions).toBe(0)
    expect(health.gateways.total).toBe(0)
  })

  it("exposes the Hono app via getApp()", () => {
    const server = createServer({
      enableDashboard: false,
      enableIntrospection: false,
      name: "app-server",
      version: "1.0.0",
    })

    const app = server.getApp()
    expect(app).toBeDefined()
  })

  it("exposes server info via getInfo()", () => {
    const server = createServer({
      build: { commit: "abc123", date: "2026-01-01", environment: "test" },
      enableDashboard: false,
      enableHealthEndpoint: false,
      enableInfoEndpoint: false,
      enableIntrospection: false,
      name: "info-server",
      version: "1.2.3",
    })

    server.addTool({ execute: async () => "ok", name: "t1" })
    server.addTool({ execute: async () => "ok", name: "t2" })

    const info = server.getInfo()
    expect(info.name).toBe("info-server")
    expect(info.version).toBe("1.2.3")
    expect(info.build.commit).toBe("abc123")
    expect(info.build.environment).toBe("test")
    expect(info.capabilities.tools).toBe(2)
    expect(info.runtime.platform).toBeTruthy()
    expect(info.runtime.nodeVersion).toBeTruthy()
  })

  it("getGatewayManager returns the manager", () => {
    const server = createServer({
      enableDashboard: false,
      enableIntrospection: false,
      gateways: [{ id: "remote", url: "http://localhost:9999/mcp" }],
      name: "gw-server",
      version: "1.0.0",
    })

    const manager = server.getGatewayManager()
    expect(manager.totalCount).toBe(1)
  })

  it("accepts a logger option and routes telemetry through it", () => {
    const server = createServer({
      enableDashboard: false,
      enableIntrospection: false,
      logLayer: directSilentLogger,
      name: "logger-server",
      version: "1.0.0",
    })

    server.addTool({
      execute: async () => "hello",
      name: "greet",
    })

    expect(server.name).toBe("logger-server")
  })

  it("telemetry option takes priority over logger option", () => {
    const telemetry = createCollector()

    const server = createServer({
      enableDashboard: false,
      enableIntrospection: false,
      logLayer: directSilentLogger,
      name: "priority-server",
      telemetry,
      version: "1.0.0",
    })

    server.addTool({
      execute: async () => "hello",
      name: "greet",
    })

    expect(server.name).toBe("priority-server")
  })

  it("counts the built-in info tool in its own capability count", () => {
    const server = createServer({ name: "count-server", version: "1.0.0" })
    server.addTool({ execute: async () => "hi", name: "greet" })

    // Reported from a deployed server: capabilities.tools said 4 while 5 tools
    // were exposed, because `info` registered straight on the backend.
    expect(server.getInfo().capabilities.tools).toBe(2)
    expect(
      server
        .getCapabilities()
        .tools.map((t) => t.name)
        .sort(),
    ).toEqual(["greet", "info"])
  })

  it("omits the info tool from the count when introspection is disabled", () => {
    const server = createServer({ enableIntrospection: false, name: "count-server", version: "1.0.0" })
    server.addTool({ execute: async () => "hi", name: "greet" })
    expect(server.getInfo().capabilities.tools).toBe(1)
  })

  it("drops a removed tool from the count on a backend that supports removal", () => {
    const server = createServer({ enableIntrospection: false, name: "count-server", version: "1.0.0" })
    server.addTool({ execute: async () => "hi", name: "greet" })
    expect(server.getInfo().capabilities.tools).toBe(1)

    server.removeTool("greet")
    expect(server.getInfo().capabilities.tools).toBe(0)
    expect(server.getCapabilities().tools).toEqual([])
  })

  it("does not double-count a tool registered twice", () => {
    const server = createServer({ enableIntrospection: false, name: "count-server", version: "1.0.0" })
    server.addTool({ execute: async () => "hi", name: "greet" })
    server.addTool({ execute: async () => "hi again", name: "greet" })
    expect(server.getInfo().capabilities.tools).toBe(1)
  })
})
