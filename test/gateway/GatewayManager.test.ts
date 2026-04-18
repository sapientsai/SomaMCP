import { describe, expect, it } from "vitest"

import { createGatewayManager } from "../../src/gateway/GatewayManager.js"
import { NoopTelemetry } from "../../src/telemetry/NoopTelemetry.js"

describe("GatewayManager", () => {
  it("adds and retrieves gateways", () => {
    const manager = createGatewayManager(NoopTelemetry)

    manager.add({ id: "a", url: "http://localhost:3001/mcp" })
    manager.add({ id: "b", url: "http://localhost:3002/mcp" })

    expect(manager.totalCount).toBe(2)
    expect(manager.get("a").isSome()).toBe(true)
    expect(manager.get("b").isSome()).toBe(true)
    expect(manager.get("c").isNone()).toBe(true)
  })

  it("returns all gateways", () => {
    const manager = createGatewayManager(NoopTelemetry)
    manager.add({ id: "x", url: "http://localhost:3001/mcp" })
    manager.add({ id: "y", url: "http://localhost:3002/mcp" })

    const all = manager.getAll()
    expect(all).toHaveLength(2)
  })

  it("reports connected count", () => {
    const manager = createGatewayManager(NoopTelemetry)
    manager.add({ id: "x", url: "http://localhost:3001/mcp" })

    expect(manager.connectedCount).toBe(0)
  })

  it("returns info for all gateways", () => {
    const manager = createGatewayManager(NoopTelemetry)
    manager.add({ id: "a", name: "Alpha", url: "http://localhost:3001/mcp" })

    const infos = manager.getInfoAll()
    expect(infos).toHaveLength(1)
    expect(infos[0]?.id).toBe("a")
    expect(infos[0]?.name).toBe("Alpha")
  })
})
