// somamcp/otel against the real OpenTelemetry SDK: what a span backend would receive.
import { context as otelContext, SpanKind, SpanStatusCode, trace as otelTrace } from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createSdkBackend } from "../../src/backend/sdk/index.js"
import { createOtelTracer, otelContextFrom } from "../../src/otel/index.js"
import { createServerCore } from "../../src/Server.js"
import type { Context } from "../../src/types/core.js"
import { connectModern, ERAS, fetchInto, MCP_URL } from "../backend/sdk-clients.js"

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
const CLIENT_SPAN = "00f067aa0ba902b7"
const TRACEPARENT = `00-${TRACE_ID}-${CLIENT_SPAN}-01`

const textOf = (result: unknown): string => (result as { content: Array<{ text: string }> }).content[0]?.text ?? ""

const exporter = new InMemorySpanExporter()
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] })
const tracer = provider.getTracer("test")

const spanNamed = (name: string) => {
  const span = exporter.getFinishedSpans().find((s) => s.name === name)
  if (!span)
    throw new Error(
      `no span named ${name}: ${exporter
        .getFinishedSpans()
        .map((s) => s.name)
        .join(", ")}`,
    )
  return span
}

const tracedServer = () => {
  const server = createServerCore({
    backend: createSdkBackend,
    enableIntrospection: false,
    name: "traced",
    tracer: createOtelTracer({ tracer }),
    version: "1.0.0",
  })
  server.addTool({
    description: "Reports its trace context",
    execute: async (_args, context: Context) => JSON.stringify(context.trace ?? null),
    name: "trace",
  })
  server.addTool({
    description: "Fails",
    execute: () => Promise.reject(new Error("secret argument value")),
    name: "fail",
  })
  server.addTool({
    description: "Opens a span of its own",
    execute: async () => {
      tracer.startSpan("automatic", {}, otelContext.active()).end()
      return "ok"
    },
    name: "nest",
  })
  server.addTool({
    description: "Opens a span under context.trace by hand",
    execute: async (_args, context: Context) => {
      tracer.startSpan("explicit", {}, otelContextFrom(context.trace)).end()
      return "ok"
    },
    name: "nest-by-hand",
  })
  return server
}

beforeEach(() => exporter.reset())

describe.each(ERAS)("createOtelTracer over %s", (_era, connect) => {
  it("opens a SERVER span named by the conventions, parented on the client's _meta", async () => {
    const client = await connect(tracedServer())
    await client.callTool({ _meta: { traceparent: TRACEPARENT, tracestate: "vendor=1" }, arguments: {}, name: "trace" })
    await client.close()

    const span = spanNamed("tools/call trace")
    expect(span.kind).toBe(SpanKind.SERVER)
    expect(span.spanContext().traceId).toBe(TRACE_ID)
    expect(span.parentSpanContext?.spanId).toBe(CLIENT_SPAN)
    expect(span.parentSpanContext?.isRemote).toBe(true)
    expect(span.parentSpanContext?.traceState?.get("vendor")).toBe("1")
    expect(span.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "trace",
      "jsonrpc.request.id": expect.any(String),
      "mcp.method.name": "tools/call",
    })
    expect(span.status.code).toBe(SpanStatusCode.UNSET)
  })

  it("starts a new trace when the client sends none", async () => {
    const client = await connect(tracedServer())
    await client.callTool({ arguments: {}, name: "trace" })
    await client.close()

    const span = spanNamed("tools/call trace")
    expect(span.parentSpanContext).toBeUndefined()
    expect(span.spanContext().traceId).not.toBe(TRACE_ID)
  })

  it("marks a tool's failure tool_error, without its message", async () => {
    const client = await connect(tracedServer())
    await client.callTool({ arguments: {}, name: "fail" })
    await client.close()

    const span = spanNamed("tools/call fail")
    expect(span.attributes["error.type"]).toBe("tool_error")
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(JSON.stringify([span.status, span.events, span.attributes])).not.toContain("secret argument value")
  })

  it("keeps a client's made-up tool name out of the span, and doesn't call it an error", async () => {
    const client = await connect(tracedServer())
    await expect(client.callTool({ arguments: {}, name: "guess-123" })).rejects.toMatchObject({ code: -32602 })
    await client.close()

    const span = spanNamed("tools/call")
    expect(span.attributes["rpc.status_code"]).toBe("-32602")
    expect(span.attributes["error.type"]).toBeUndefined()
    expect(span.attributes["gen_ai.tool.name"]).toBeUndefined()
    expect(span.status.code).toBe(SpanStatusCode.UNSET)
    expect(span.events).toEqual([])
    expect(JSON.stringify([span.name, span.status, span.attributes])).not.toContain("guess-123")
  })

  it("treats a tool hidden from this caller like an unknown one", async () => {
    const server = createServerCore<{ user: string }>({
      authenticate: () => Promise.resolve({ user: "u" }),
      backend: createSdkBackend,
      enableIntrospection: false,
      name: "hidden",
      tracer: createOtelTracer({ tracer }),
      version: "1.0.0",
    })
    server.addTool({ canAccess: () => false, description: "Hidden", execute: async () => "x", name: "secret" })
    const client = await connect(server)
    await expect(client.callTool({ arguments: {}, name: "secret" })).rejects.toMatchObject({ code: -32602 })
    await client.close()

    expect(spanNamed("tools/call").attributes["gen_ai.tool.name"]).toBeUndefined()
  })
})

describe("a call the tracer sees rejected", () => {
  const reject = async (error: Error): Promise<void> => {
    const call = createOtelTracer({ tracer }).traceToolCall({ name: "t" }, () => Promise.reject(error))
    await expect(call).rejects.toBe(error)
  }

  it("fails the span on another JSON-RPC code, recording it both ways", async () => {
    await reject(Object.assign(new Error("internal"), { code: -32603 }))

    const span = spanNamed("tools/call t")
    expect(span.attributes["rpc.status_code"]).toBe("-32603")
    expect(span.attributes["error.type"]).toBe("-32603")
    expect(span.status).toMatchObject({ code: SpanStatusCode.ERROR, message: "internal" })
    expect(span.events.map((e) => e.name)).toEqual(["exception"])
  })

  it("fails the span on an error with no code, typed by its name", async () => {
    await reject(new TypeError("broken"))

    const span = spanNamed("tools/call t")
    expect(span.attributes["rpc.status_code"]).toBeUndefined()
    expect(span.attributes["error.type"]).toBe("TypeError")
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
  })
})

describe("what tools see", () => {
  it("context.trace is the span's own context, keeping the tracestate", async () => {
    const client = await connectModern(tracedServer())
    const result = await client.callTool({
      _meta: { traceparent: TRACEPARENT, tracestate: "vendor=1" },
      arguments: {},
      name: "trace",
    })
    await client.close()

    const span = spanNamed("tools/call trace")
    expect(JSON.parse(textOf(result))).toEqual({
      traceparent: `00-${TRACE_ID}-${span.spanContext().spanId}-01`,
      tracestate: "vendor=1",
    })
  })

  it("context.trace passes the client's through when no SDK is registered", async () => {
    const server = createServerCore({
      backend: createSdkBackend,
      enableIntrospection: false,
      name: "no-sdk",
      tracer: createOtelTracer(),
      version: "1.0.0",
    })
    server.addTool({
      description: "Reports its trace context",
      execute: async (_args, context: Context) => JSON.stringify(context.trace ?? null),
      name: "trace",
    })
    const client = await connectModern(server)
    const sent = await client.callTool({ _meta: { traceparent: TRACEPARENT }, arguments: {}, name: "trace" })
    const none = await client.callTool({ arguments: {}, name: "trace" })
    await client.close()

    expect(JSON.parse(textOf(sent))).toEqual({ traceparent: TRACEPARENT })
    expect(JSON.parse(textOf(none))).toBeNull()
  })

  it("nests by hand through otelContextFrom, with no context manager", async () => {
    const client = await connectModern(tracedServer())
    await client.callTool({ arguments: {}, name: "nest-by-hand" })
    await client.close()

    const parent = spanNamed("tools/call nest-by-hand").spanContext()
    const child = spanNamed("explicit")
    expect(child.spanContext().traceId).toBe(parent.traceId)
    expect(child.parentSpanContext?.spanId).toBe(parent.spanId)
  })

  it("otelContextFrom leaves the context alone for a missing or invalid trace", () => {
    const base = otelContext.active()
    expect(otelContextFrom(undefined, base)).toBe(base)
    expect(otelContextFrom({ traceparent: "nope" }, base)).toBe(base)
  })
})

describe("with a context manager", () => {
  const manager = new AsyncLocalStorageContextManager()

  beforeEach(() => {
    otelContext.setGlobalContextManager(manager.enable())
  })
  afterEach(() => {
    manager.disable()
    otelContext.disable()
  })

  it("nests a span the tool opens with no help", async () => {
    const client = await connectModern(tracedServer())
    await client.callTool({ arguments: {}, name: "nest" })
    await client.close()

    const parent = spanNamed("tools/call nest").spanContext()
    const child = spanNamed("automatic")
    expect(child.spanContext().traceId).toBe(parent.traceId)
    expect(child.parentSpanContext?.spanId).toBe(parent.spanId)
  })

  it("parents on _meta and links the ambient span, as the conventions say", async () => {
    const server = tracedServer()
    const ambient = tracer.startSpan("http")
    const inAmbient: typeof server = {
      ...server,
      fetch: (request) =>
        otelContext.with(otelTrace.setSpan(otelContext.active(), ambient), () => server.fetch(request)),
    }
    const client = await connectModern(inAmbient)
    await client.callTool({ _meta: { traceparent: TRACEPARENT }, arguments: {}, name: "trace" })
    await client.close()
    ambient.end()

    const span = spanNamed("tools/call trace")
    expect(span.parentSpanContext?.spanId).toBe(CLIENT_SPAN)
    expect(span.links.map((l) => l.context.spanId)).toEqual([ambient.spanContext().spanId])
  })

  it("parents on the ambient span when the client sends no trace", async () => {
    const server = tracedServer()
    const ambient = tracer.startSpan("http")
    const inAmbient: typeof server = {
      ...server,
      fetch: (request) =>
        otelContext.with(otelTrace.setSpan(otelContext.active(), ambient), () => server.fetch(request)),
    }
    const client = await connectModern(inAmbient)
    await client.callTool({ arguments: {}, name: "trace" })
    await client.close()
    ambient.end()

    const span = spanNamed("tools/call trace")
    expect(span.parentSpanContext?.spanId).toBe(ambient.spanContext().spanId)
    expect(span.links).toEqual([])
  })
})

describe("across a gateway", () => {
  it("joins one trace: client → front's span → remote's span", async () => {
    const remote = tracedServer()
    const front = createServerCore({
      backend: createSdkBackend,
      enableIntrospection: false,
      gateways: [{ fetch: fetchInto(remote), id: "up", toolPrefix: "up_", url: MCP_URL.href }],
      name: "front",
      tracer: createOtelTracer({ tracer }),
      version: "1.0.0",
    })
    await front.start()
    const client = await connectModern(front)
    await client.callTool({ _meta: { traceparent: TRACEPARENT }, arguments: {}, name: "up_trace" })
    await client.close()
    await front.stop()

    const frontSpan = spanNamed("tools/call up_trace")
    const remoteSpan = spanNamed("tools/call trace")
    expect(frontSpan.parentSpanContext?.spanId).toBe(CLIENT_SPAN)
    expect(remoteSpan.spanContext().traceId).toBe(TRACE_ID)
    expect(remoteSpan.parentSpanContext?.spanId).toBe(frontSpan.spanContext().spanId)
  })
})
