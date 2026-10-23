import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { afterEach, describe, expect, it } from "vitest"

import { createJsonFileTelemetry } from "../../src/node/JsonFileTelemetry.js"
import type { TelemetryEvent } from "../../src/telemetry/TelemetryCollector.js"

const createTempPath = () => join(tmpdir(), `soma-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)

describe("JsonFileTelemetry", () => {
  const tempFiles: string[] = []

  afterEach(async () => {
    for (const f of tempFiles) {
      await rm(f, { force: true })
    }
    tempFiles.length = 0
  })

  it("writes events to file on flush", async () => {
    const filePath = createTempPath()
    tempFiles.push(filePath)
    const telemetry = createJsonFileTelemetry({ filePath, flushIntervalMs: 60000 })

    const event: TelemetryEvent = {
      durationMs: 42,
      name: "test-tool",
      timestamp: Date.now(),
      type: "tool.execute",
    }
    telemetry.recordEvent(event)
    await telemetry.flush!()

    const content = await readFile(filePath, "utf-8")
    const lines = content.trim().split("\n")
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]) as TelemetryEvent
    expect(parsed.name).toBe("test-tool")
    expect(parsed.durationMs).toBe(42)
  })

  it("writes multiple events as separate JSON lines", async () => {
    const filePath = createTempPath()
    tempFiles.push(filePath)
    const telemetry = createJsonFileTelemetry({ filePath, flushIntervalMs: 60000 })

    telemetry.recordEvent({ name: "tool-1", timestamp: Date.now(), type: "tool.execute" })
    telemetry.recordEvent({ name: "tool-2", timestamp: Date.now(), type: "tool.error", error: "fail" })
    await telemetry.flush!()

    const content = await readFile(filePath, "utf-8")
    const lines = content.trim().split("\n")
    expect(lines).toHaveLength(2)
  })

  it("preserves extended event fields", async () => {
    const filePath = createTempPath()
    tempFiles.push(filePath)
    const telemetry = createJsonFileTelemetry({ filePath, flushIntervalMs: 60000 })

    telemetry.recordEvent({
      error: "timeout",
      errorCategory: "timeout",
      errorStack: "Error: timeout\n    at ...",
      input: { query: "test" },
      name: "enriched-tool",
      requestId: "req-123",
      sessionId: "sess-456",
      timestamp: Date.now(),
      type: "tool.error",
    })
    await telemetry.flush!()

    const content = await readFile(filePath, "utf-8")
    const parsed = JSON.parse(content.trim()) as TelemetryEvent
    expect(parsed.errorCategory).toBe("timeout")
    expect(parsed.input).toEqual({ query: "test" })
    expect(parsed.sessionId).toBe("sess-456")
    expect(parsed.requestId).toBe("req-123")
  })

  it("handles empty flush gracefully", async () => {
    const filePath = createTempPath()
    tempFiles.push(filePath)
    const telemetry = createJsonFileTelemetry({ filePath })

    await expect(telemetry.flush!()).resolves.toBeUndefined()
  })
})
