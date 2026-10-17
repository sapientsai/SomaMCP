import type {
  CallToolResult,
  GetPromptResult,
  ReadResourceResult,
  ServerContext,
  Tool as SdkTool,
} from "@modelcontextprotocol/server"
import { Option } from "functype"

import type {
  Completion,
  Content,
  ContentResult,
  Context,
  PromptResult,
  ResourceResult,
  SchemaParams,
  SessionAuth,
} from "../../types/core.js"

// ── Schemas ───────────────────────────────────────────────────────────

/**
 * The slice of Standard JSON Schema (`~standard.jsonSchema`) the SDK needs to
 * advertise a tool's shape. zod 4, ArkType and Valibot (via
 * `@valibot/to-json-schema`) implement it; somamcp's `SchemaParams` only promises
 * `validate`, so it is read structurally here.
 */
type JsonSchemaCapable = {
  "~standard": { jsonSchema?: { input: (options: { target: string }) => Record<string, unknown> } }
}

type ObjectSchema = SdkTool["inputSchema"]

const EMPTY_OBJECT_SCHEMA: ObjectSchema = { properties: {}, type: "object" }

/** JSON Schema for a tool's arguments; an empty object schema when the schema can't produce one. */
export const toJsonSchema = (params: Option<SchemaParams>): ObjectSchema =>
  params
    .flatMap((p) => Option((p as JsonSchemaCapable)["~standard"].jsonSchema))
    .map((js) => js.input({ target: "draft-2020-12" }) as ObjectSchema)
    .orElse(EMPTY_OBJECT_SCHEMA)

// ── Results ───────────────────────────────────────────────────────────

/** somamcp tools may return a string, one Content part, a full ContentResult, or nothing. */
export const toCallResult = (result: Content | ContentResult | string | void): CallToolResult => {
  if (typeof result === "string") return { content: [{ text: result, type: "text" }] }
  if (result === undefined) return { content: [] }
  if ("content" in result) return result as CallToolResult
  return { content: [result] } as CallToolResult
}

export const errorResult = (message: string): CallToolResult => ({
  content: [{ text: message, type: "text" }],
  isError: true,
})

/** Every result is served; resources are not truncated to their first entry. */
export const toReadResult = (
  loaded: ResourceResult | ResourceResult[],
  defaults: { mimeType?: string; uri: string },
): ReadResourceResult => ({
  contents: (Array.isArray(loaded) ? loaded : [loaded]).map((r) => ({
    mimeType: r.mimeType ?? defaults.mimeType,
    uri: r.uri ?? defaults.uri,
    ...("blob" in r ? { blob: r.blob } : { text: r.text }),
  })),
})

/** A bare string prompt result becomes one user message, as FastMCP does. */
export const toPromptResult = (loaded: PromptResult): GetPromptResult =>
  typeof loaded === "string"
    ? { messages: [{ content: { text: loaded, type: "text" }, role: "user" }] }
    : (loaded as GetPromptResult)

const EMPTY_COMPLETION: Completion = { values: [] }

export const toCompleteResult = (completion: Option<Completion>) => ({
  completion: completion.orElse(EMPTY_COMPLETION),
})

/** Completion from a fixed list of allowed values, filtered by the typed prefix. */
export const completeFromEnum = (values: ReadonlyArray<string>, prefix: string): Completion => {
  const matches = values.filter((v) => v.startsWith(prefix))
  return { total: matches.length, values: matches }
}

// ── Context ───────────────────────────────────────────────────────────

const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo"

type LogLevel = "debug" | "error" | "info" | "warning"

/**
 * The somamcp `Context` for one request. Logging and progress travel as
 * notifications on the request's own response stream, so they work in both
 * protocol eras and in stateless mode.
 */
export const createToolContext = <T extends SessionAuth>(
  ctx: ServerContext,
  session: Option<T>,
  toolName: string,
): Context<T> => {
  const log =
    (level: LogLevel) =>
    (message: string, data?: unknown): void => {
      void ctx.mcpReq.log(level, data === undefined ? message : { data, message })
    }
  const progressToken = Option(ctx.mcpReq._meta?.progressToken)
  const clientInfo = Option(ctx.mcpReq.envelope?.[CLIENT_INFO_META_KEY])

  return {
    client: { version: clientInfo.map((info) => info.version).orUndefined() },
    log: { debug: log("debug"), error: log("error"), info: log("info"), warn: log("warning") },
    reportProgress: async ({ progress, total }) => {
      await progressToken.fold(
        async () => {},
        (token) =>
          ctx.mcpReq.notify({ method: "notifications/progress", params: { progress, progressToken: token, total } }),
      )
    },
    requestId: String(ctx.mcpReq.id),
    session: session.orUndefined(),
    sessionId: ctx.sessionId,
    // Same custom notification FastMCP sends, so clients that read it keep working.
    streamContent: async (content) => {
      await ctx.mcpReq.notify({
        method: "notifications/tool/streamContent",
        params: { content: Array.isArray(content) ? content : [content], toolName },
      })
    },
  }
}
