// A Worker using somamcp/otel, for otel.test.ts. No OpenTelemetry SDK runs here: it is the API
// package and a recording tracer, which is what has to load and work without nodejs_compat.
import {
  type Context,
  INVALID_SPAN_CONTEXT,
  type Span,
  type SpanContext,
  type SpanOptions,
  trace,
  type Tracer,
} from "@opentelemetry/api"

import { createServer } from "../../src/index.js"
import { createOtelTracer, otelContextFrom } from "../../src/otel/index.js"

type Recorded = {
  attributes: SpanOptions["attributes"]
  errorType?: unknown
  name: string
  parent?: SpanContext
}

const recorded: Recorded[] = []

const spanWith = (spanContext: SpanContext, entry: Recorded): Span =>
  ({
    addEvent: () => spanWith(spanContext, entry),
    addLink: () => spanWith(spanContext, entry),
    addLinks: () => spanWith(spanContext, entry),
    end: () => undefined,
    isRecording: () => true,
    recordException: () => undefined,
    setAttribute: (key: string, value: unknown) => {
      if (key === "error.type") entry.errorType = value
      return spanWith(spanContext, entry)
    },
    setAttributes: () => spanWith(spanContext, entry),
    setStatus: () => spanWith(spanContext, entry),
    spanContext: () => spanContext,
    updateName: () => spanWith(spanContext, entry),
  }) as Span

const recordingTracer: Tracer = {
  startActiveSpan: () => {
    throw new Error("unused")
  },
  startSpan: (name: string, options?: SpanOptions, context?: Context) => {
    const parent = context && trace.getSpanContext(context)
    const entry: Recorded = { attributes: options?.attributes, name, ...(parent ? { parent } : {}) }
    recorded.push(entry)
    const spanId = recorded.length.toString(16).padStart(16, "0")
    return spanWith(
      {
        spanId,
        traceFlags: 1,
        traceId: parent?.traceId ?? INVALID_SPAN_CONTEXT.traceId.replace(/0/g, "a"),
      },
      entry,
    )
  },
}

const server = createServer({
  enableDashboard: false,
  enableIntrospection: false,
  name: "otel-worker",
  tracer: createOtelTracer({ tracer: recordingTracer }),
  version: "1.0.0",
})

server.addTool({
  description: "Opens a span under context.trace, the way a Worker has to",
  execute: async (_args, context) => {
    recordingTracer.startSpan("explicit", {}, otelContextFrom(context.trace))
    return JSON.stringify(context.trace ?? null)
  },
  name: "trace",
})

server.addTool({
  description: "Always fails",
  execute: () => Promise.reject(new Error("nope")),
  name: "fail",
})

server.addTool({
  description: "What was recorded",
  execute: async () => JSON.stringify(recorded),
  name: "spans",
})

export default { fetch: (request: Request): Promise<Response> => server.fetch(request) }
