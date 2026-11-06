import type { DirectLogger } from "functype-log"

import type { TelemetryCollector, TelemetryEvent } from "./TelemetryCollector.js"

export const createLogLayerTelemetry = (logger: DirectLogger): TelemetryCollector => ({
  flush: () => Promise.resolve(),
  recordEvent: (event: TelemetryEvent) => {
    const metadata: Record<string, unknown> = {
      durationMs: event.durationMs,
      eventName: event.name,
      timestamp: new Date(event.timestamp).toISOString(),
      type: event.type,
      ...(event.sessionId && { sessionId: event.sessionId }),
      ...(event.requestId && { requestId: event.requestId }),
      ...(event.trace && { traceparent: event.trace.traceparent }),
      ...(event.errorCategory && { errorCategory: event.errorCategory }),
      ...event.data,
    }

    if (event.error) {
      logger.withError(new Error(event.error)).error(event.type, metadata)
    } else {
      logger.info(event.type, metadata)
    }
  },
})
