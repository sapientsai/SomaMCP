import type { ILogLayer } from "loglayer"

import type { TelemetryCollector, TelemetryEvent } from "./TelemetryCollector.js"

export const createLogLayerTelemetry = (logger: ILogLayer): TelemetryCollector => ({
  flush: () => Promise.resolve(),
  recordEvent: (event: TelemetryEvent) => {
    const metadata: Record<string, unknown> = {
      durationMs: event.durationMs,
      eventName: event.name,
      timestamp: new Date(event.timestamp).toISOString(),
      type: event.type,
      ...event.data,
    }

    if (event.error) {
      logger.withMetadata(metadata).withError(new Error(event.error)).error(event.type)
    } else {
      logger.withMetadata(metadata).info(event.type)
    }
  },
})
