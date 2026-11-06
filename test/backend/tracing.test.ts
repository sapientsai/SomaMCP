// Trace context from a client's _meta to tools, telemetry, tracers and gateways, in both protocol eras.
import { describe, expect, it } from "vitest"

import { createSdkBackend } from "../../src/backend/sdk/index.js"
import { createServerCore } from "../../src/Server.js"
import type { TelemetryEvent } from "../../src/telemetry/TelemetryCollector.js"
import type { Context } from "../../src/types/core.js"
import type { ToolCallInfo, ToolTracer, TraceContext } from "../../src/types/tracing.js"
import { ERAS, fetchInto, MCP_URL } from "./sdk-clients.js"

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`
const SPAN_TRACE: TraceContext = { traceparent: `00-${TRACE_ID}-1111111111111111-01` }

const textOf = (result: unknown): string => (result as { content: Array<{ text: string }> }).content[0]?.text ?? ""

const traceServer = (options: { events?: TelemetryEvent[]; tracer?: ToolTracer } = {}) => {
  const server = createServerCore({
    backend: createSdkBackend,
    name: "traced",
    telemetry: { recordEvent: (event) => options.events?.push(event) },
    tracer: options.tracer,
    version: "1.0.0",
  })
  server.addTool({
    description: "Reports the trace context it was given",
    execute: async (_args, context: Context) => JSON.stringify(context.trace ?? null),
    name: "trace",
  })
  server.addTool({
    description: "Always fails",
    execute: () => Promise.reject(new Error("boom")),
    name: "fail",
  })
  return server
}

describe.each(ERAS)("trace context over %s", (_era, connect) => {
  it("reaches the tool", async () => {
    const client = await connect(traceServer())
    const result = await client.callTool({
      _meta: { traceparent: TRACEPARENT, tracestate: "vendor=1" },
      arguments: {},
      name: "trace",
    })
    expect(JSON.parse(textOf(result))).toEqual({ traceparent: TRACEPARENT, tracestate: "vendor=1" })
    await client.close()
  })

  it("is undefined when the client sends none", async () => {
    const client = await connect(traceServer())
    expect(JSON.parse(textOf(await client.callTool({ arguments: {}, name: "trace" })))).toBeNull()
    await client.close()
  })

  it("is dropped when invalid, without failing the call", async () => {
    const client = await connect(traceServer())
    const result = await client.callTool({ _meta: { traceparent: "nope" }, arguments: {}, name: "trace" })
    expect(JSON.parse(textOf(result))).toBeNull()
    await client.close()
  })

  it("is on the tool's telemetry events, success and failure", async () => {
    const events: TelemetryEvent[] = []
    const client = await connect(traceServer({ events }))
    await client.callTool({ _meta: { traceparent: TRACEPARENT }, arguments: {}, name: "trace" })
    await client.callTool({ _meta: { traceparent: TRACEPARENT }, arguments: {}, name: "fail" })
    expect(events.find((e) => e.type === "tool.execute")?.trace).toEqual({ traceparent: TRACEPARENT })
    expect(events.find((e) => e.type === "tool.error")?.trace).toEqual({ traceparent: TRACEPARENT })
    await client.close()
  })

  it.each(["auto", "legacy"] as const)("forwards through a gateway negotiating %s", async (versionNegotiation) => {
    const remote = traceServer()
    const front = createServerCore({
      backend: createSdkBackend,
      enableIntrospection: false,
      gateways: [{ fetch: fetchInto(remote), id: "up", toolPrefix: "up_", url: MCP_URL.href, versionNegotiation }],
      name: "front",
      version: "1.0.0",
    })
    await front.start()
    const client = await connect(front)
    const result = await client.callTool({
      _meta: { traceparent: TRACEPARENT, tracestate: "vendor=1" },
      arguments: {},
      name: "up_trace",
    })
    // The proxy returns the remote result as JSON, so the tool's text is nested inside it.
    expect(JSON.parse(textOf(JSON.parse(textOf(result))))).toEqual({ traceparent: TRACEPARENT, tracestate: "vendor=1" })
    await client.close()
    await front.stop()
  })
})

describe("the tracer hook", () => {
  const recordingTracer = (calls: ToolCallInfo[], results: Array<{ isError?: boolean }> = []): ToolTracer => ({
    traceToolCall: async (call, run) => {
      calls.push(call)
      const result = await run(SPAN_TRACE)
      results.push(result)
      return result
    },
  })

  it("sees the call, and gives the tool and telemetry the span's context, not the client's", async () => {
    const calls: ToolCallInfo[] = []
    const events: TelemetryEvent[] = []
    const client = await ERAS[0][1](traceServer({ events, tracer: recordingTracer(calls) }))
    const result = await client.callTool({ _meta: { traceparent: TRACEPARENT }, arguments: {}, name: "trace" })

    expect(calls[0]).toMatchObject({ name: "trace", trace: { traceparent: TRACEPARENT } })
    expect(calls[0]?.requestId).toEqual(expect.any(String))
    expect(JSON.parse(textOf(result))).toEqual(SPAN_TRACE)
    expect(events.find((e) => e.type === "tool.execute")?.trace).toEqual(SPAN_TRACE)
    await client.close()
  })

  it("covers tools that skip wrapTool: info and proxied ones", async () => {
    const calls: ToolCallInfo[] = []
    const remote = traceServer()
    const front = createServerCore({
      backend: createSdkBackend,
      gateways: [{ fetch: fetchInto(remote), id: "up", toolPrefix: "up_", url: MCP_URL.href }],
      name: "front",
      tracer: recordingTracer(calls),
      version: "1.0.0",
    })
    await front.start()
    const client = await ERAS[0][1](front)
    await client.callTool({ arguments: {}, name: "info" })
    await client.callTool({ arguments: {}, name: "up_trace" })
    expect(calls.map((c) => c.name)).toEqual(["info", "up_trace"])
    await client.close()
    await front.stop()
  })

  it("sees isError on a tool's failure", async () => {
    const results: Array<{ isError?: boolean }> = []
    const client = await ERAS[0][1](traceServer({ tracer: recordingTracer([], results) }))
    await client.callTool({ arguments: {}, name: "fail" })
    await client.callTool({ arguments: {}, name: "trace" })
    expect(results.map((r) => r.isError === true)).toEqual([true, false])
    await client.close()
  })

  it("sees the rejection for an unknown tool, and the client still gets its error", async () => {
    const calls: ToolCallInfo[] = []
    const seen: unknown[] = []
    const tracer: ToolTracer = {
      traceToolCall: async (call, run) => {
        calls.push(call)
        return run(undefined).catch((error: unknown) => {
          seen.push(error)
          throw error
        })
      },
    }
    const client = await ERAS[0][1](traceServer({ tracer }))
    await expect(client.callTool({ arguments: {}, name: "missing" })).rejects.toThrow(/missing/)
    expect(calls.map((c) => c.name)).toEqual(["missing"])
    expect(seen).toHaveLength(1)
    await client.close()
  })
})
