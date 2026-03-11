import { ConsoleTransport, LogLayer } from "loglayer"

import { createLogLayerTelemetry } from "./LogLayerTelemetry.js"
import type { TelemetryCollector } from "./TelemetryCollector.js"

export const createConsoleTelemetry = (prefix = "[soma]"): TelemetryCollector => {
  const logger = new LogLayer({
    prefix,
    transport: new ConsoleTransport({
      logger: console,
    }),
  })

  return createLogLayerTelemetry(logger)
}
