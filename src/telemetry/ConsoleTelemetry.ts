import { createDirectConsoleLogger } from "functype-log"

import { createLogLayerTelemetry } from "./LogLayerTelemetry.js"
import type { TelemetryCollector } from "./TelemetryCollector.js"

export const createConsoleTelemetry = (prefix = "[soma]"): TelemetryCollector => {
  // Route telemetry to stderr: on the stdio transport stdout IS the JSON-RPC channel, so any
  // diagnostic byte there corrupts the protocol (clients reject "Invalid JSON-RPC message" and
  // disconnect). An MCP server has no scenario where telemetry belongs on stdout.
  const logger = createDirectConsoleLogger({ prefix, stream: "stderr" })
  return createLogLayerTelemetry(logger)
}
