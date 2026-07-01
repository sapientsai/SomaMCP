import { describe, expect, it, vi } from "vitest"

import type { TelemetryCollector, TelemetryEvent } from "../../src/telemetry/TelemetryCollector.js"
import { wrapPrompt, wrapResource, wrapTool } from "../../src/telemetry/telemetryWrapper.js"

const createMockTelemetry = (): TelemetryCollector & { events: TelemetryEvent[] } => {
  const events: TelemetryEvent[] = []
  return {
    events,
    recordEvent: (event) => events.push(event),
  }
}

const createMockContext = (overrides?: { requestId?: string; sessionId?: string }) =>
  ({
    client: { version: undefined },
    log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    reportProgress: vi.fn(),
    requestId: overrides?.requestId,
    sessionId: overrides?.sessionId,
    streamContent: vi.fn(),
  }) as never

describe("telemetryWrapper", () => {
  describe("wrapTool", () => {
    it("records successful tool execution", async () => {
      const telemetry = createMockTelemetry()
      const tool = {
        execute: vi.fn().mockResolvedValue("result"),
        name: "my-tool",
      }

      const wrapped = wrapTool(tool, telemetry)
      const result = await wrapped.execute({}, createMockContext())

      expect(result).toBe("result")
      expect(telemetry.events).toHaveLength(1)
      expect(telemetry.events[0]).toMatchObject({
        name: "my-tool",
        type: "tool.execute",
      })
    })

    it("captures input and output at full capture level", async () => {
      const telemetry = createMockTelemetry()
      const tool = {
        execute: vi.fn().mockResolvedValue("result-data"),
        name: "capture-tool",
      }

      const wrapped = wrapTool(tool, telemetry)
      await wrapped.execute({ query: "hello" }, createMockContext())

      expect(telemetry.events[0]).toMatchObject({
        input: { query: "hello" },
        output: "result-data",
        type: "tool.execute",
      })
    })

    it("passes a content-array return through unchanged (text + image)", async () => {
      const telemetry = createMockTelemetry()
      const contentReturn = {
        content: [
          { text: "here you go", type: "text" as const },
          { data: "iVBORw0KGgoAAAANS==", mimeType: "image/png", type: "image" as const },
        ],
      }
      const tool = {
        execute: vi.fn().mockResolvedValue(contentReturn),
        name: "download-file",
      }

      const wrapped = wrapTool(tool, telemetry)
      const result = await wrapped.execute({}, createMockContext())

      // wrapTool's success branch returns `value` unchanged — content arrays
      // (including image parts) reach the backend as authored.
      expect(result).toBe(contentReturn)
      expect(result).toEqual({
        content: [
          { text: "here you go", type: "text" },
          { data: "iVBORw0KGgoAAAANS==", mimeType: "image/png", type: "image" },
        ],
      })
      expect(telemetry.events[0]).toMatchObject({ name: "download-file", type: "tool.execute" })
    })

    it("passes a ContentResult (content + isError) through unchanged", async () => {
      const telemetry = createMockTelemetry()
      const contentReturn = {
        content: [{ text: "resource not found", type: "text" as const }],
        isError: true,
      }
      const tool = {
        execute: vi.fn().mockResolvedValue(contentReturn),
        name: "lookup",
      }

      const wrapped = wrapTool(tool, telemetry)
      const result = await wrapped.execute({}, createMockContext())

      expect(result).toBe(contentReturn)
    })

    it("captures sessionId and requestId from context", async () => {
      const telemetry = createMockTelemetry()
      const tool = {
        execute: vi.fn().mockResolvedValue("ok"),
        name: "ctx-tool",
      }

      const wrapped = wrapTool(tool, telemetry)
      await wrapped.execute({}, createMockContext({ requestId: "req-1", sessionId: "sess-1" }))

      expect(telemetry.events[0]).toMatchObject({
        requestId: "req-1",
        sessionId: "sess-1",
      })
    })

    it("returns enriched error as ContentResult with isError", async () => {
      const telemetry = createMockTelemetry()
      const tool = {
        execute: vi.fn().mockRejectedValue(new Error("connection refused")),
        name: "fail-tool",
      }

      const wrapped = wrapTool(tool, telemetry)
      const result = (await wrapped.execute({}, createMockContext())) as {
        content: Array<{ text: string; type: string }>
        isError: boolean
      }

      expect(result.isError).toBe(true)
      expect(result.content).toHaveLength(1)
      const parsed = JSON.parse(result.content[0].text) as { errorCategory: string; message: string }
      expect(parsed.errorCategory).toBe("gateway")
      expect(parsed.message).toBe("connection refused")
    })

    it("records error details in telemetry event", async () => {
      const telemetry = createMockTelemetry()
      const tool = {
        execute: vi.fn().mockRejectedValue(new Error("boom")),
        name: "fail-tool",
      }

      const wrapped = wrapTool(tool, telemetry)
      await wrapped.execute({}, createMockContext())

      expect(telemetry.events).toHaveLength(1)
      expect(telemetry.events[0]).toMatchObject({
        error: "boom",
        errorCategory: "internal",
        name: "fail-tool",
        type: "tool.error",
      })
      expect(telemetry.events[0].errorStack).toBeDefined()
    })

    it("skips telemetry when captureLevel is none", async () => {
      const telemetry = createMockTelemetry()
      const tool = {
        execute: vi.fn().mockResolvedValue("result"),
        name: "no-capture-tool",
      }

      const wrapped = wrapTool(tool, telemetry, { captureLevel: "none" })
      const result = await wrapped.execute({}, createMockContext())

      expect(result).toBe("result")
      expect(telemetry.events).toHaveLength(0)
    })

    it("omits input and output when captureLevel is metadata", async () => {
      const telemetry = createMockTelemetry()
      const tool = {
        execute: vi.fn().mockResolvedValue("result"),
        name: "meta-tool",
      }

      const wrapped = wrapTool(tool, telemetry, { captureLevel: "metadata" })
      await wrapped.execute({ secret: "value" }, createMockContext())

      expect(telemetry.events[0].input).toBeUndefined()
      expect(telemetry.events[0].output).toBeUndefined()
      expect(telemetry.events[0]).toMatchObject({
        name: "meta-tool",
        type: "tool.execute",
      })
    })

    it("redacts specified input fields", async () => {
      const telemetry = createMockTelemetry()
      const tool = {
        execute: vi.fn().mockResolvedValue("ok"),
        name: "redact-tool",
      }

      const wrapped = wrapTool(tool, telemetry, { redactInputFields: ["password", "token"] })
      await wrapped.execute({ password: "secret", query: "hello", token: "abc" }, createMockContext())

      expect(telemetry.events[0].input).toEqual({
        password: "[REDACTED]",
        query: "hello",
        token: "[REDACTED]",
      })
    })

    it("truncates large output", async () => {
      const telemetry = createMockTelemetry()
      const largeOutput = "x".repeat(200)
      const tool = {
        execute: vi.fn().mockResolvedValue(largeOutput),
        name: "large-tool",
      }

      const wrapped = wrapTool(tool, telemetry, { maxOutputSize: 50 })
      await wrapped.execute({}, createMockContext())

      const output = telemetry.events[0].output as string
      expect(output).toContain("...[truncated,")
      expect(output.length).toBeLessThan(200)
    })

    it("preserves tool metadata", () => {
      const telemetry = createMockTelemetry()
      const tool = {
        description: "A tool",
        execute: vi.fn(),
        name: "meta-tool",
      }

      const wrapped = wrapTool(tool, telemetry)
      expect(wrapped.name).toBe("meta-tool")
      expect(wrapped.description).toBe("A tool")
    })
  })

  describe("wrapResource", () => {
    it("records successful resource load", async () => {
      const telemetry = createMockTelemetry()
      const resource = {
        load: vi.fn().mockResolvedValue({ text: "data" }),
        name: "my-resource",
        uri: "res://test",
      }

      const wrapped = wrapResource(resource, telemetry)
      const result = await wrapped.load()

      expect(result).toEqual({ text: "data" })
      expect(telemetry.events).toHaveLength(1)
      expect(telemetry.events[0]).toMatchObject({
        name: "my-resource",
        type: "resource.load",
      })
    })

    it("records resource error with classification and re-throws", async () => {
      const telemetry = createMockTelemetry()
      const resource = {
        load: vi.fn().mockRejectedValue(new Error("not found")),
        name: "fail-resource",
        uri: "res://fail",
      }

      const wrapped = wrapResource(resource, telemetry)
      await expect(wrapped.load()).rejects.toThrow("not found")

      expect(telemetry.events[0]).toMatchObject({
        error: "not found",
        errorCategory: "not_found",
        type: "resource.error",
      })
    })
  })

  describe("wrapPrompt", () => {
    it("records successful prompt load", async () => {
      const telemetry = createMockTelemetry()
      const prompt = {
        load: vi.fn().mockResolvedValue("response"),
        name: "my-prompt",
      }

      const wrapped = wrapPrompt(prompt, telemetry)
      const result = await wrapped.load({})

      expect(result).toBe("response")
      expect(telemetry.events).toHaveLength(1)
      expect(telemetry.events[0]).toMatchObject({
        name: "my-prompt",
        type: "prompt.load",
      })
    })

    it("records prompt error with classification and re-throws", async () => {
      const telemetry = createMockTelemetry()
      const prompt = {
        load: vi.fn().mockRejectedValue(new Error("unauthorized access")),
        name: "fail-prompt",
      }

      const wrapped = wrapPrompt(prompt, telemetry)
      await expect(wrapped.load({})).rejects.toThrow("unauthorized access")

      expect(telemetry.events[0]).toMatchObject({
        error: "unauthorized access",
        errorCategory: "auth",
        type: "prompt.error",
      })
    })
  })
})
