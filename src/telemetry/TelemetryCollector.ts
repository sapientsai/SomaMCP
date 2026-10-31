export type TelemetryEventType =
  | "server.start"
  | "server.stop"
  | "tool.execute"
  | "tool.error"
  | "resource.load"
  | "resource.error"
  | "prompt.load"
  | "prompt.error"
  | "gateway.connect"
  | "gateway.disconnect"
  | "gateway.error"
  | "session.connect"
  | "session.disconnect"

/**
 * How a failure is labelled. `execution` is a tool reporting that the operation it ran failed
 * (a `UserError` with no category of its own); `validation` is input the tool's schema refused.
 */
export type ErrorCategory = "validation" | "execution" | "timeout" | "gateway" | "internal" | "auth" | "not_found"

export type CaptureLevel = "full" | "metadata" | "none"

export type ToolCaptureConfig = {
  captureLevel?: CaptureLevel
  maxOutputSize?: number
  redactInputFields?: ReadonlyArray<string>
}

export type TelemetryEvent = {
  data?: Record<string, unknown>
  durationMs?: number
  error?: string
  errorCategory?: ErrorCategory
  errorStack?: string
  input?: Record<string, unknown>
  name: string
  output?: unknown
  requestId?: string
  sessionId?: string
  timestamp: number
  type: TelemetryEventType
}

export type TelemetryCollector = {
  flush?: () => Promise<void>
  recordEvent: (event: TelemetryEvent) => void
}
