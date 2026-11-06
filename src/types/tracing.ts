/**
 * W3C Trace Context for one tool call. A client sends it in the request's `_meta`, and a
 * tracer replaces it with its own span's, so whatever reads it next nests under that span.
 * Both values are the client's own: use them to correlate telemetry, never to authorize.
 */
export type TraceContext = {
  traceparent: string
  tracestate?: string
}

export type ToolCallInfo = {
  /**
   * The tool's name. Absent when the call names no tool this caller can use: the name is then
   * whatever the client made up, and a span name built from it could grow without limit.
   */
  name?: string
  requestId?: string
  sessionId?: string
  /** The caller's trace context, when it sent a valid one. */
  trace?: TraceContext
}

/**
 * Opens a span around each MCP tool call, with no dependency on a tracing library.
 * `createOtelTracer` from `somamcp/otel` is the OpenTelemetry implementation.
 */
export type ToolTracer = {
  /**
   * Runs `run` inside a span, and hands it the trace context that tools should see, which
   * is usually that span's. A callback rather than start and end calls, because OpenTelemetry
   * can only make a span current for the length of a function.
   */
  traceToolCall: <R extends { isError?: boolean }>(
    call: ToolCallInfo,
    run: (trace: TraceContext | undefined) => Promise<R>,
  ) => Promise<R>
}
