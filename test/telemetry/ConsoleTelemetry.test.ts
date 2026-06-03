import { describe, expect, it, vi } from "vitest"

import { createConsoleTelemetry } from "../../src/telemetry/ConsoleTelemetry.js"
import type { TelemetryEvent } from "../../src/telemetry/TelemetryCollector.js"

describe("ConsoleTelemetry", () => {
  it("routes events to stderr and keeps stdout clean (JSON-RPC channel on stdio)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
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

    // Even info-level events must go to stderr — stdout carries JSON-RPC on the stdio transport.
    expect(errorSpy).toHaveBeenCalled()
    expect(infoSpy).not.toHaveBeenCalled()
    expect(logSpy).not.toHaveBeenCalled()

    errorSpy.mockRestore()
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
