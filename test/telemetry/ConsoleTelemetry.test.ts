import { describe, expect, it, vi } from "vitest"

import { createConsoleTelemetry } from "../../src/telemetry/ConsoleTelemetry.js"
import type { TelemetryEvent } from "../../src/telemetry/TelemetryCollector.js"

describe("ConsoleTelemetry", () => {
  it("logs events to console", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const telemetry = createConsoleTelemetry()

    const event: TelemetryEvent = {
      data: { name: "test-tool" },
      durationMs: 42,
      name: "test-tool",
      timestamp: Date.now(),
      type: "tool.execute",
    }

    telemetry.recordEvent(event)

    // loglayer routes info-level to console.info or console.log
    const called = infoSpy.mock.calls.length > 0 || logSpy.mock.calls.length > 0
    expect(called).toBe(true)
    infoSpy.mockRestore()
    logSpy.mockRestore()
  })

  it("logs error events to console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const telemetry = createConsoleTelemetry("[test]")

    const event: TelemetryEvent = {
      error: "something failed",
      name: "test-tool",
      timestamp: Date.now(),
      type: "tool.error",
    }

    telemetry.recordEvent(event)

    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it("flush resolves immediately", async () => {
    const telemetry = createConsoleTelemetry()
    await expect(telemetry.flush?.()).resolves.toBeUndefined()
  })
})
