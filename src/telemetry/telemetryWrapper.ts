import { Try } from "functype"

import type { ContentResult, Prompt, PromptArgument, Resource, SchemaParams, SessionAuth, Tool } from "../types/core.js"
import { createEnrichedError } from "./EnrichedError.js"
import type { TelemetryCollector, ToolCaptureConfig } from "./TelemetryCollector.js"

const DEFAULT_MAX_OUTPUT_SIZE = 10000

const redactFields = (args: Record<string, unknown>, fields?: ReadonlyArray<string>): Record<string, unknown> => {
  if (!fields || fields.length === 0) return args
  return Object.fromEntries(
    // eslint-disable-next-line functype/prefer-flatmap -- mapping [k,v] entries to [k,v] entries; flatMap would incorrectly destructure the tuples
    Object.entries(args).map(([key, value]) => [key, fields.includes(key) ? "[REDACTED]" : value]),
  )
}

const truncateOutput = (result: unknown, maxSize: number = DEFAULT_MAX_OUTPUT_SIZE): unknown => {
  const str = typeof result === "string" ? result : JSON.stringify(result)
  if (str && str.length > maxSize) {
    return `${str.slice(0, maxSize)}...[truncated, ${str.length} total chars]`
  }
  return result
}

const toTry = <T>(promise: Promise<T>): Promise<Try<T>> => Try.fromPromise(promise)

export const wrapTool = <T extends SessionAuth, P extends SchemaParams>(
  tool: Tool<T, P>,
  telemetry: TelemetryCollector,
  captureConfig?: ToolCaptureConfig,
): Tool<T, P> => ({
  ...tool,
  execute: async (args, context) => {
    const level = captureConfig?.captureLevel ?? "full"
    if (level === "none") return tool.execute(args, context)

    const start = Date.now()
    const { requestId, sessionId } = context
    const inputData =
      level === "full" ? redactFields(args as Record<string, unknown>, captureConfig?.redactInputFields) : undefined

    const result = await toTry(tool.execute(args, context))

    return result.fold(
      (error) => {
        const enriched = createEnrichedError(error, { toolName: tool.name })
        telemetry.recordEvent({
          data: { name: tool.name },
          durationMs: Date.now() - start,
          error: enriched.message,
          errorCategory: enriched.errorCategory,
          errorStack: error.stack,
          input: inputData,
          name: tool.name,
          requestId,
          sessionId,
          timestamp: start,
          type: "tool.error",
        })
        return {
          content: [{ text: JSON.stringify(enriched, null, 2), type: "text" as const }],
          isError: true,
        } satisfies ContentResult
      },
      (value) => {
        telemetry.recordEvent({
          data: { name: tool.name },
          durationMs: Date.now() - start,
          input: inputData,
          name: tool.name,
          output: level === "full" ? truncateOutput(value, captureConfig?.maxOutputSize) : undefined,
          requestId,
          sessionId,
          timestamp: start,
          type: "tool.execute",
        })
        return value
      },
    )
  },
})

// eslint-disable-next-line functype/prefer-either -- wrapper must preserve the Resource.load Promise<ResourceResult> contract; errors are Promise rejections per MCP protocol
export const wrapResource = <T extends SessionAuth>(
  resource: Resource<T>,
  telemetry: TelemetryCollector,
): Resource<T> => ({
  ...resource,
  load: async (auth) => {
    const start = Date.now()
    const result = await toTry(resource.load(auth))

    return result.fold(
      (error) => {
        const enriched = createEnrichedError(error)
        telemetry.recordEvent({
          data: { name: resource.name, uri: resource.uri },
          durationMs: Date.now() - start,
          error: enriched.message,
          errorCategory: enriched.errorCategory,
          errorStack: error.stack,
          name: resource.name,
          timestamp: start,
          type: "resource.error",
        })
        // eslint-disable-next-line functype/prefer-either -- re-throw preserves Promise rejection semantics required by the MCP Resource contract
        throw error
      },
      (value) => {
        telemetry.recordEvent({
          data: { name: resource.name, uri: resource.uri },
          durationMs: Date.now() - start,
          name: resource.name,
          timestamp: start,
          type: "resource.load",
        })
        return value
      },
    )
  },
})

// eslint-disable-next-line functype/prefer-either -- wrapper must preserve the Prompt.load Promise<PromptResult> contract; errors are Promise rejections per MCP protocol
export const wrapPrompt = <T extends SessionAuth, Args extends PromptArgument<T>[] = PromptArgument<T>[]>(
  prompt: Prompt<T, Args>,
  telemetry: TelemetryCollector,
): Prompt<T, Args> => ({
  ...prompt,
  load: async (args, auth) => {
    const start = Date.now()
    const result = await toTry(prompt.load(args, auth))

    return result.fold(
      (error) => {
        const enriched = createEnrichedError(error)
        telemetry.recordEvent({
          data: { name: prompt.name },
          durationMs: Date.now() - start,
          error: enriched.message,
          errorCategory: enriched.errorCategory,
          errorStack: error.stack,
          name: prompt.name,
          timestamp: start,
          type: "prompt.error",
        })
        // eslint-disable-next-line functype/prefer-either -- re-throw preserves Promise rejection semantics required by the MCP Prompt contract
        throw error
      },
      (value) => {
        telemetry.recordEvent({
          data: { name: prompt.name },
          durationMs: Date.now() - start,
          name: prompt.name,
          timestamp: start,
          type: "prompt.load",
        })
        return value
      },
    )
  },
})
