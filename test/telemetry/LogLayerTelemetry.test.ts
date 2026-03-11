import { ConsoleTransport, LogLayer } from "loglayer"
import { describe, expect, it, vi } from "vitest"

import { createLogLayerTelemetry } from "../../src/telemetry/LogLayerTelemetry.js"
import type { TelemetryEvent } from "../../src/telemetry/TelemetryCollector.js"

const createSpyLogger = () => {
  const mockConsole = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  }
  const logger = new LogLayer({
    transport: new ConsoleTransport({ logger: mockConsole as unknown as Console }),
  })
  return { logger, mockConsole }
}

describe("LogLayerTelemetry", () => {
  it("routes non-error events to info()", () => {
    const { logger, mockConsole } = createSpyLogger()
    const telemetry = createLogLayerTelemetry(logger)

    const event: TelemetryEvent = {
      data: { name: "test-tool" },
      durationMs: 42,
      name: "test-tool",
      timestamp: Date.now(),
      type: "tool.execute",
    }

    telemetry.recordEvent(event)

    expect(mockConsole.info).toHaveBeenCalled()
    expect(mockConsole.error).not.toHaveBeenCalled()
  })

  it("routes error events to error()", () => {
    const { logger, mockConsole } = createSpyLogger()
    const telemetry = createLogLayerTelemetry(logger)

    const event: TelemetryEvent = {
      error: "something failed",
      name: "test-tool",
      timestamp: Date.now(),
      type: "tool.error",
    }

    telemetry.recordEvent(event)

    expect(mockConsole.error).toHaveBeenCalled()
  })

  it("includes structured metadata in events", () => {
    const { logger, mockConsole } = createSpyLogger()
    const telemetry = createLogLayerTelemetry(logger)

    const event: TelemetryEvent = {
      data: { toolName: "greet" },
      durationMs: 100,
      name: "greet",
      timestamp: 1700000000000,
      type: "tool.execute",
    }

    telemetry.recordEvent(event)

    const callArgs = mockConsole.info.mock.calls[0]
    const output = JSON.stringify(callArgs)
    expect(output).toContain("greet")
    expect(output).toContain("tool.execute")
  })

  it("flush resolves immediately", async () => {
    const { logger } = createSpyLogger()
    const telemetry = createLogLayerTelemetry(logger)
    await expect(telemetry.flush?.()).resolves.toBeUndefined()
  })
})
