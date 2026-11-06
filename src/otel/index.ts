// somamcp/otel: tool-call spans through @opentelemetry/api, an optional peer dependency. Only
// this entry imports it, so a server without tracing never needs it installed.
import {
  type Attributes,
  type Context as OtelContext,
  context as otelContext,
  createTraceState,
  isSpanContextValid,
  type Link,
  type Span,
  type SpanContext,
  SpanKind,
  SpanStatusCode,
  trace as otelTrace,
  type Tracer,
} from "@opentelemetry/api"
import { Option, Try } from "functype"

import { parseTraceparent } from "../telemetry/traceContext.js"
import type { ToolCallInfo, ToolTracer, TraceContext } from "../types/tracing.js"

const TOOL_CALL_METHOD = "tools/call"
// What an unknown tool gets. The conventions say the caller's mistake isn't the server's error.
const INVALID_PARAMS = "-32602"

const toRemoteSpanContext = (trace: TraceContext): Option<SpanContext> =>
  parseTraceparent(trace.traceparent).map(({ flags, spanId, traceId }): SpanContext => ({
    isRemote: true,
    spanId,
    traceFlags: flags,
    traceId,
    ...(trace.tracestate ? { traceState: createTraceState(trace.tracestate) } : {}),
  }))

const toTraceContext = (span: SpanContext): TraceContext => {
  const flags = span.traceFlags.toString(16).padStart(2, "0")
  const state = span.traceState?.serialize()
  return {
    traceparent: `00-${span.traceId}-${span.spanId}-${flags}`,
    ...(state ? { tracestate: state } : {}),
  }
}

/**
 * An OpenTelemetry context whose current span is `trace`'s, for starting a span under a tool
 * call by hand. Node needs this only without a context manager; Workers need it because they
 * have none unless `nodejs_compat` is on:
 *
 *     tracer.startSpan("query", {}, otelContextFrom(context.trace))
 */
export const otelContextFrom = (
  trace: TraceContext | undefined,
  base: OtelContext = otelContext.active(),
): OtelContext =>
  Option(trace)
    .flatMap(toRemoteSpanContext)
    .fold(
      () => base,
      (span) => otelTrace.setSpanContext(base, span),
    )

/** The span's attributes, from OpenTelemetry's semantic conventions for MCP. */
const callAttributes = (call: ToolCallInfo): Attributes => ({
  "gen_ai.operation.name": "execute_tool",
  "mcp.method.name": TOOL_CALL_METHOD,
  ...(call.name === undefined ? {} : { "gen_ai.tool.name": call.name }),
  ...(call.requestId === undefined ? {} : { "jsonrpc.request.id": call.requestId }),
  ...(call.sessionId === undefined ? {} : { "mcp.session.id": call.sessionId }),
})

/** The server's ambient span, such as an HTTP span, which the conventions say to link rather than parent. */
const linksToAmbient = (call: ToolCallInfo, ambient: OtelContext): Link[] =>
  Option(call.trace)
    .flatMap(() => Option(otelTrace.getSpanContext(ambient)))
    .filter(isSpanContextValid)
    .fold<Link[]>(
      () => [],
      (context) => [{ context }],
    )

const codeOf = (error: Error): Option<string> =>
  "code" in error && (typeof error.code === "number" || typeof error.code === "string")
    ? Option(String(error.code))
    : Option.none()

const markFailed = (span: Span, error: Error, type: string): void => {
  span.setAttribute("error.type", type)
  span.recordException(error)
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
}

/** A rejected call. Its JSON-RPC code is always recorded; only the server's own errors fail the span. */
const recordRejection = (span: Span, error: Error): void => {
  const code = codeOf(error)
  code.forEach((value) => span.setAttribute("rpc.status_code", value))
  code
    .filter((value) => value === INVALID_PARAMS)
    .fold(
      () => markFailed(span, error, code.orElse(error.name)),
      () => undefined,
    )
}

/** A tool's own failure. Its text goes to the client, not the span, because it can quote the arguments. */
const recordToolError = (span: Span): void => {
  span.setAttribute("error.type", "tool_error")
  span.setStatus({ code: SpanStatusCode.ERROR })
}

export type OtelTracerOptions = {
  /** Defaults to the global provider's tracer named `somamcp`. */
  tracer?: Tracer
}

/**
 * A `ToolTracer` that opens one `SERVER` span named `tools/call <tool>` around each tool call. The
 * client's `_meta` trace context is its parent; otherwise the current span, if any, is. Spans
 * hold no arguments or results, and `context.trace` carries the span on to the tool and gateways.
 */
export const createOtelTracer = ({ tracer = otelTrace.getTracer("somamcp") }: OtelTracerOptions = {}): ToolTracer => ({
  traceToolCall: async (call, run) => {
    const ambient = otelContext.active()
    const span = tracer.startSpan(
      call.name === undefined ? TOOL_CALL_METHOD : `${TOOL_CALL_METHOD} ${call.name}`,
      { attributes: callAttributes(call), kind: SpanKind.SERVER, links: linksToAmbient(call, ambient) },
      otelContextFrom(call.trace, ambient),
    )
    // With no SDK registered and no parent, the span has no ids to pass on.
    const trace = Option(span.spanContext()).filter(isSpanContextValid).map(toTraceContext).or(Option(call.trace))
    const result = await Try.fromPromise(
      otelContext.with(otelTrace.setSpan(ambient, span), () => run(trace.orUndefined())),
    )
    result.fold(
      (error) => recordRejection(span, error),
      (value) => {
        if (value.isError) recordToolError(span)
      },
    )
    span.end()
    return result.orThrow()
  },
})
