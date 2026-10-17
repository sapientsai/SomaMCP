// SPIKE (#36): throwaway SDK 2.x backend. Answers the Phase 0 questions; not production code.
import {
  type CallToolResult,
  createMcpHandler,
  type GetPromptResult,
  ProtocolError,
  ProtocolErrorCode,
  type ReadResourceResult,
  ResourceNotFoundError,
  Server,
  type ServerContext,
} from "@modelcontextprotocol/server"
import { Option, Try } from "functype"
import { Hono } from "hono"

import type {
  Content,
  ContentResult,
  Context,
  Prompt,
  PromptArgument,
  Resource,
  ResourceResult,
  SchemaParams,
  ServerStatus,
  SessionAuth,
  Tool,
} from "../types/core.js"
import type { ServerConfig } from "../types/server.js"
import type { BackendAdapter, BackendSession } from "./adapter.js"

// ── Registry ──────────────────────────────────────────────────────────

type AnyTool<T extends SessionAuth> = Tool<T, SchemaParams>
type AnyPrompt<T extends SessionAuth> = Prompt<T, PromptArgument<T>[]>

// ── Helpers ───────────────────────────────────────────────────────────

type JsonSchemaCapable = {
  "~standard": { jsonSchema?: { input: (options: { target: string }) => Record<string, unknown> } }
}

const EMPTY_OBJECT_SCHEMA = { properties: {}, type: "object" } as const

/** Standard JSON Schema (`~standard.jsonSchema`), implemented by zod 4, ArkType and Valibot. */
const toInputSchema = (params: Option<SchemaParams>): Record<string, unknown> =>
  params
    .flatMap((p) => Option((p as JsonSchemaCapable)["~standard"].jsonSchema))
    .map((js) => js.input({ target: "draft-2020-12" }))
    .orElse(EMPTY_OBJECT_SCHEMA)

const toCallResult = (result: Content | ContentResult | string | void): CallToolResult => {
  if (typeof result === "string") return { content: [{ text: result, type: "text" }] }
  if (result === undefined) return { content: [] }
  if ("content" in result) return result as CallToolResult
  return { content: [result] } as CallToolResult
}

const errorResult = (message: string): CallToolResult => ({ content: [{ text: message, type: "text" }], isError: true })

const toResourceContents = (resource: Resource<SessionAuth>, loaded: ResourceResult | ResourceResult[]) =>
  (Array.isArray(loaded) ? loaded : [loaded]).map((r) => ({
    mimeType: r.mimeType ?? resource.mimeType,
    uri: r.uri ?? resource.uri,
    ...("blob" in r ? { blob: r.blob } : { text: r.text }),
  }))

const createContext = <T extends SessionAuth>(ctx: ServerContext, session: Option<T>): Context<T> => {
  const log =
    (level: "debug" | "error" | "info" | "warning") =>
    (message: string, data?: unknown): void => {
      void ctx.mcpReq.log(level, data === undefined ? message : { data, message })
    }
  const progressToken = ctx.mcpReq._meta?.progressToken
  return {
    client: { version: undefined },
    log: { debug: log("debug"), error: log("error"), info: log("info"), warn: log("warning") },
    reportProgress: async ({ progress, total }) => {
      if (progressToken === undefined) return
      await ctx.mcpReq.notify({ method: "notifications/progress", params: { progress, progressToken, total } })
    },
    requestId: String(ctx.mcpReq.id),
    session: session.orUndefined(),
    sessionId: ctx.sessionId,
    // SPIKE: no streamContent mapping yet (FastMCP-specific extension).
    streamContent: async () => {},
  }
}

// ── Factory ───────────────────────────────────────────────────────────

export type SdkBackendOptions = {
  /** Endpoint path. Defaults to "/mcp". */
  mcpPath?: string
}

export const createSdkBackend = <T extends SessionAuth = SessionAuth>(
  config: ServerConfig<T>,
  backendOptions?: Record<string, unknown>,
): BackendAdapter<T> => {
  const mcpPath = Option(backendOptions as SdkBackendOptions)
    .flatMap((o) => Option(o.mcpPath))
    .orElse("/mcp")

  // Mutable registries are the point: the factory below replays them on every request,
  // so add/remove take effect on the next request with no list-changed plumbing.
  const tools = new globalThis.Map<string, AnyTool<T>>()
  const resources = new globalThis.Map<string, Resource<T>>()
  const prompts = new globalThis.Map<string, AnyPrompt<T>>()

  /**
   * One low-level Server per request, with a fixed set of handlers that read the
   * registries. Construction cost is independent of how many tools are registered.
   */
  const buildServer = (session: Option<T>): Server => {
    const visible = (): AnyTool<T>[] =>
      [...tools.values()].filter((t) => !t.canAccess || t.canAccess(session.orUndefined() as T))

    const server = new Server(
      { name: config.name, version: config.version },
      {
        capabilities: { prompts: {}, resources: {}, tools: {} },
        instructions: config.instructions,
      },
    )

    server.setRequestHandler("tools/list", () => ({
      tools: visible().map((t) => ({
        _meta: t._meta,
        annotations: t.annotations,
        description: t.description,
        inputSchema: toInputSchema(Option(t.parameters)) as { type: "object" },
        name: t.name,
        ...(t.outputSchema ? { outputSchema: toInputSchema(Option(t.outputSchema)) as { type: "object" } } : {}),
      })),
    }))

    server.setRequestHandler("tools/call", async (request, ctx) => {
      const tool = visible().find((t) => t.name === request.params.name)
      if (!tool) return errorResult(`Unknown tool: ${request.params.name}`)
      const args = request.params.arguments ?? {}
      const parsed = tool.parameters ? await tool.parameters["~standard"].validate(args) : { value: args }
      if ("issues" in parsed) return errorResult(parsed.issues.map((i) => i.message).join("; "))
      const outcome = await Try.fromPromise(tool.execute(parsed.value as never, createContext(ctx, session)))
      return outcome.fold(
        (error) => errorResult(error instanceof Error ? error.message : String(error)),
        (result) => toCallResult(result),
      )
    })

    server.setRequestHandler("resources/list", () => ({
      resources: [...resources.values()].map((r) => ({
        description: r.description,
        mimeType: r.mimeType,
        name: r.name,
        uri: r.uri,
      })),
    }))

    /** @interop SDK request handlers report JSON-RPC errors by throwing. */
    const readResource = async (uri: string): Promise<ReadResourceResult> => {
      const resource = [...resources.values()].find((r) => r.uri === uri)
      if (!resource) throw new ResourceNotFoundError(uri)
      const loaded = await resource.load(session.orUndefined())
      return { contents: toResourceContents(resource as Resource<SessionAuth>, loaded) }
    }
    server.setRequestHandler("resources/read", (request) => readResource(request.params.uri))

    server.setRequestHandler("prompts/list", () => ({
      prompts: [...prompts.values()].map((p) => ({
        arguments: p.arguments?.map((a) => ({ description: a.description, name: a.name, required: a.required })),
        description: p.description,
        name: p.name,
      })),
    }))

    /** @interop SDK request handlers report JSON-RPC errors by throwing. */
    const getPrompt = async (name: string, args: Record<string, string>): Promise<GetPromptResult> => {
      const prompt = prompts.get(name)
      if (!prompt) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown prompt: ${name}`)
      const loaded = await prompt.load(args, session.orUndefined())
      return typeof loaded === "string"
        ? { messages: [{ content: { text: loaded, type: "text" }, role: "user" }] }
        : (loaded as GetPromptResult)
    }
    server.setRequestHandler("prompts/get", (request) => getPrompt(request.params.name, request.params.arguments ?? {}))

    return server
  }

  // Auth runs once per request in front of the handler. The result rides through
  // `authInfo`, which the SDK passes to the factory unchanged on both eras. (Keying a
  // WeakMap by the Request does not work: the 2025 leg hands the factory a clone.)
  const SESSION_KEY = "somamcp/session"

  const handler = createMcpHandler(
    ({ authInfo }) => buildServer(Option(authInfo).flatMap((a) => Option(a.extra?.[SESSION_KEY] as T))),
    {
      keepAliveMs: config.streamKeepalive?.enabled ? config.streamKeepalive.intervalMs : undefined,
    },
  )

  const app = new Hono()
  app.all(mcpPath, async (c) => {
    const request = c.req.raw
    if (!config.authenticate) return handler.fetch(request)
    const auth = await Try.fromPromise(config.authenticate(request))
    if (auth.isFailure()) return c.json({ error: "Unauthorized" }, 401)
    return handler.fetch(request, {
      authInfo: { clientId: "", extra: { [SESSION_KEY]: auth.orThrow() }, scopes: [], token: "" },
    })
  })

  return {
    get serverState(): ServerStatus {
      return "running"
    },
    get sessions(): ReadonlyArray<BackendSession<T>> {
      return []
    },

    addPrompt: (prompt) => void prompts.set(prompt.name, prompt as unknown as AnyPrompt<T>),
    addResource: (resource) => void resources.set(resource.name, resource),
    // SPIKE: templates need UriTemplate matching + resources/templates/list; not wired.
    addResourceTemplate: () => {},
    addTool: (tool) => void tools.set(tool.name, tool as unknown as AnyTool<T>),

    fetch: async (request: Request): Promise<Response> => app.fetch(request),
    getApp: (): Hono => app,
    on: () => {},

    removePrompt: (name) => void prompts.delete(name),
    removeResource: (name) => void resources.delete(name),
    removeTool: (name) => void tools.delete(name),

    // SPIKE: Node port listener / stdio not wired; fetch() is the entry point.
    start: async () => {},
    stop: () => handler.close(),
  }
}
