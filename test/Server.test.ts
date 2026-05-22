import { directSilentLogger } from "functype-log"
import { describe, expect, it } from "vitest"

import { createServer } from "../src/Server.js"
import type { TelemetryCollector, TelemetryEvent } from "../src/telemetry/TelemetryCollector.js"

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
    expect(server.serverState).toBe("stopped")
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
    expect(health.status).toBe("stopped")
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
})
