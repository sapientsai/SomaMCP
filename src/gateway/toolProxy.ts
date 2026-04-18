import { Try } from "functype"

import type { TelemetryCollector } from "@/telemetry"
import { createEnrichedError } from "@/telemetry"

import type { ContentResult, SessionAuth, Tool } from "../types/core.js"
import type { GatewayInstance } from "./types.js"

const toTry = <T>(promise: Promise<T>): Promise<Try<T>> => Try.fromPromise(promise)

export const createProxiedTools = <T extends SessionAuth>(
  gateway: GatewayInstance,
  telemetry?: TelemetryCollector,
): ReadonlyArray<Tool<T>> => {
  const prefix = gateway.config.toolPrefix ?? `${gateway.config.id}_`

  return gateway.tools.map(
    (remoteTool): Tool<T> => ({
      annotations: {
        openWorldHint: true,
        readOnlyHint: true,
      },
      description: `[${gateway.name}] ${remoteTool.description ?? "Remote tool"}`,
      execute: async (args) => {
        const start = Date.now()
        const toolName = `${prefix}${remoteTool.name}`
        const result = await toTry(gateway.callTool(remoteTool.name, args as Record<string, unknown>))

        return result.fold<string | ContentResult>(
          (error) => {
            const enriched = createEnrichedError(error, {
              gatewayStatus: gateway.status,
              toolName: remoteTool.name,
            })
            telemetry?.recordEvent({
              data: { gateway: gateway.config.id, remoteTool: remoteTool.name },
              durationMs: Date.now() - start,
              error: enriched.message,
              errorCategory: enriched.errorCategory,
              errorStack: error.stack,
              input: args as Record<string, unknown>,
              name: toolName,
              timestamp: start,
              type: "tool.error",
            })
            return {
              content: [{ text: JSON.stringify(enriched, null, 2), type: "text" as const }],
              isError: true,
            } satisfies ContentResult
          },
          (value) => {
            telemetry?.recordEvent({
              data: { gateway: gateway.config.id, remoteTool: remoteTool.name },
              durationMs: Date.now() - start,
              input: args as Record<string, unknown>,
              name: toolName,
              output: value,
              timestamp: start,
              type: "tool.execute",
            })
            return JSON.stringify(value, null, 2)
          },
        )
      },
      name: `${prefix}${remoteTool.name}`,
    }),
  )
}
