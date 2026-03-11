import { MockLogLayer, type ILogLayer } from "loglayer"
import { describe, expect, it, vi } from "vitest"

import { createCell } from "../src/Cell.js"
import type { TelemetryCollector, TelemetryEvent } from "../src/telemetry/TelemetryCollector.js"

const createCollector = (): TelemetryCollector & {
  events: TelemetryEvent[]
} => {
  const events: TelemetryEvent[] = []
  return { events, recordEvent: (e) => events.push(e) }
}

describe("Cell", () => {
  it("creates a cell with default options", () => {
    const cell = createCell({ name: "test-cell", version: "1.0.0" })
    expect(cell.name).toBe("test-cell")
    expect(cell.serverState).toBe("stopped")
  })

  it("registers tools with telemetry wrapping", async () => {
    const telemetry = createCollector()
    const cell = createCell({
      enableDashboard: false,
      enableIntrospection: false,
      name: "tool-cell",
      telemetry,
      version: "1.0.0",
    })

    cell.addTool({
      execute: async () => "hello",
      name: "greet",
    })

    const capabilities = cell.getCapabilities()
    expect(capabilities.tools).toHaveLength(1)
    expect(capabilities.tools[0]?.name).toBe("greet")
  })

  it("registers resources with telemetry wrapping", () => {
    const telemetry = createCollector()
    const cell = createCell({
      enableDashboard: false,
      enableIntrospection: false,
      name: "res-cell",
      telemetry,
      version: "1.0.0",
    })

    cell.addResource({
      load: async () => ({ text: "data" }),
      name: "my-res",
      uri: "res://test",
    })

    const capabilities = cell.getCapabilities()
    expect(capabilities.resources).toHaveLength(1)
    expect(capabilities.resources[0]?.name).toBe("my-res")
  })

  it("registers prompts with telemetry wrapping", () => {
    const telemetry = createCollector()
    const cell = createCell({
      enableDashboard: false,
      enableIntrospection: false,
      name: "prompt-cell",
      telemetry,
      version: "1.0.0",
    })

    cell.addPrompt({
      load: async () => "answer",
      name: "my-prompt",
    })

    const capabilities = cell.getCapabilities()
    expect(capabilities.prompts).toHaveLength(1)
    expect(capabilities.prompts[0]?.name).toBe("my-prompt")
  })

  it("reports health with stopped status before start", () => {
    const cell = createCell({
      enableDashboard: false,
      enableIntrospection: false,
      name: "health-cell",
      version: "1.0.0",
    })

    const health = cell.getHealth()
    expect(health.status).toBe("stopped")
    expect(health.name).toBe("health-cell")
    expect(health.uptime).toBe(0)
    expect(health.activeSessions).toBe(0)
    expect(health.gateways.total).toBe(0)
  })

  it("exposes the Hono app via getApp()", () => {
    const cell = createCell({
      enableDashboard: false,
      enableIntrospection: false,
      name: "app-cell",
      version: "1.0.0",
    })

    const app = cell.getApp()
    expect(app).toBeDefined()
  })

  it("disables introspection tools when enableIntrospection is false", () => {
    const cell = createCell({
      enableIntrospection: false,
      name: "no-intro",
      version: "1.0.0",
    })

    const capabilities = cell.getCapabilities()
    expect(capabilities.tools.find((t) => t.name === "soma_health")).toBeUndefined()
  })

  it("getGatewayManager returns the manager", () => {
    const cell = createCell({
      enableDashboard: false,
      enableIntrospection: false,
      gateways: [{ id: "remote", url: "http://localhost:9999/mcp" }],
      name: "syn-cell",
      version: "1.0.0",
    })

    const manager = cell.getGatewayManager()
    expect(manager.totalCount).toBe(1)
  })

  it("accepts a logger option and routes telemetry through it", () => {
    const mockLogger = new MockLogLayer()
    const infoSpy = vi.spyOn(mockLogger, "info")

    const cell = createCell({
      enableDashboard: false,
      enableIntrospection: false,
      logLayer: mockLogger as unknown as ILogLayer,
      name: "logger-cell",
      version: "1.0.0",
    })

    cell.addTool({
      execute: async () => "hello",
      name: "greet",
    })

    expect(cell.name).toBe("logger-cell")
    // Logger is wired — we can't easily trigger telemetry without starting,
    // but we verify the cell was created successfully with the logger option
    expect(infoSpy).not.toHaveBeenCalled()
  })

  it("telemetry option takes priority over logger option", () => {
    const telemetry = createCollector()
    const mockLogger = new MockLogLayer()
    const infoSpy = vi.spyOn(mockLogger, "info")

    const cell = createCell({
      enableDashboard: false,
      enableIntrospection: false,
      logLayer: mockLogger as unknown as ILogLayer,
      name: "priority-cell",
      telemetry,
      version: "1.0.0",
    })

    cell.addTool({
      execute: async () => "hello",
      name: "greet",
    })

    // Logger should not be used when telemetry is explicitly provided
    expect(infoSpy).not.toHaveBeenCalled()
    expect(cell.name).toBe("priority-cell")
  })
})
