import { EdgeFastMCP, type EdgePrompt, type EdgeTool } from "fastmcp/edge"
import { Option } from "functype"
import { Hono } from "hono"

import type { Authenticate } from "../auth/index.js"
import { createAuthMiddleware } from "../auth/index.js"
import type {
  Content,
  ContentResult,
  Context,
  InferSchemaOutput,
  SchemaParams,
  ServerStatus,
  SessionAuth,
  Tool,
} from "../types/core.js"
import type { Logger, ServerConfig } from "../types/server.js"
import type { BackendAdapter, BackendSession } from "./adapter.js"

// ── Result Normalization ──────────────────────────────────────────────

/**
 * somamcp tools may return a bare string, a single Content part, a full
 * ContentResult, or nothing. EdgeFastMCP accepts only the first and third.
 */
const toEdgeResult = (result: Content | ContentResult | string | void): ContentResult | string => {
  if (typeof result === "string") return result
  if (result === undefined) return { content: [] }
  if ("content" in result) return result
  return { content: [result] }
}

/** Best-effort text for an error result, used as the thrown message. */
const errorText = (result: ContentResult): string =>
  result.content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join(" ")
    .trim() || "Tool execution failed"

// ── Context Synthesis ─────────────────────────────────────────────────

/**
 * EdgeFastMCP invokes `execute(params)` with no second argument, but somamcp
 * tools and the telemetry wrapper expect a `Context`. The edge transport is
 * stateless and has no server->client channel, so `reportProgress` and
 * `streamContent` are inert. Tools relying on either must guard for edge.
 */
const createEdgeContext = <T extends SessionAuth>(logger: Option<Logger>): Context<T> => ({
  client: { version: undefined },
  log: {
    debug: (message, data) => logger.forEach((l) => l.debug(message, data)),
    error: (message, data) => logger.forEach((l) => l.error(message, data)),
    info: (message, data) => logger.forEach((l) => l.info(message, data)),
    warn: (message, data) => logger.forEach((l) => l.warn(message, data)),
  },
  reportProgress: async () => {},
  session: undefined,
  streamContent: async () => {},
})

// ── Factory ───────────────────────────────────────────────────────────

const DEFAULT_MCP_PATH = "/mcp"

export type EdgeBackendOptions = {
  /** Base path for the MCP endpoint. Defaults to "/mcp". */
  mcpPath?: string
}

/**
 * Edge-runtime backend for Cloudflare Workers, Deno Deploy, and Bun.
 *
 * Routing: somamcp owns the outer Hono app so artifacts and routes registered
 * via `createServer` take precedence. Anything unmatched falls through to
 * EdgeFastMCP, which serves the MCP endpoint. This ordering matters — EdgeFastMCP
 * registers its own `/health` at construction, and Hono is first-match-wins, so
 * mounting it first would shadow somamcp's health artifact.
 *
 * The prefer-either disable below is for the nested tool-execute throw, which
 * EdgeFastMCP requires; this factory itself never throws.
 */
// eslint-disable-next-line functype/prefer-either -- see note above
export const createEdgeBackend = <T extends SessionAuth = SessionAuth>(
  config: ServerConfig<T>,
  backendOptions?: Record<string, unknown>,
): BackendAdapter<T> => {
  const { mcpPath } = (backendOptions ?? {}) as EdgeBackendOptions
  const resolvedMcpPath = mcpPath ?? DEFAULT_MCP_PATH
  const logger = Option(config.logger)

  const server = new EdgeFastMCP({
    logger: logger.orUndefined(),
    mcpPath: resolvedMcpPath,
    name: config.name,
    version: config.version,
  })

  const app = new Hono()

  // Gate the MCP endpoint ourselves. `EdgeFastMCPOptions` has no `authenticate`
  // field, so unlike the Node backend — which hands `authenticate` to FastMCP and
  // gets protocol-level auth — nothing would guard the protocol endpoint here.
  // Without this, moving a secured server to `somamcp/edge` would silently expose
  // an unauthenticated MCP endpoint.
  Option(config.authenticate as Authenticate).forEach((authenticate) => {
    app.use(resolvedMcpPath, createAuthMiddleware({ authenticate }))
  })

  app.notFound((c) => server.fetch(c.req.raw))

  const warn = (message: string): void => logger.forEach((l) => l.warn(`[somamcp/edge] ${message}`))

  const unsupported = (operation: string): void => warn(`${operation} is not supported by the edge backend; ignoring.`)

  return {
    get serverState(): ServerStatus {
      // Edge workers have no lifecycle — the isolate is live whenever it can answer.
      return "running"
    },

    get sessions(): ReadonlyArray<BackendSession<T>> {
      // Stateless transport: no sessions are retained between requests.
      return []
    },

    addPrompt: (prompt) => {
      server.addPrompt({
        arguments: prompt.arguments?.map((arg) => ({
          description: arg.description,
          name: arg.name,
          required: arg.required,
        })),
        description: prompt.description,
        // somamcp's PromptResult carries `messages: unknown[]` (opaque MCP payload);
        // EdgeFastMCP narrows it to a text-only shape. Same wire format, looser type.
        load: async (args) => (await prompt.load(args)) as Awaited<ReturnType<EdgePrompt["load"]>>,
        name: prompt.name,
      })
    },

    addResource: (resource) => {
      server.addResource({
        description: resource.description,
        load: async () => {
          const loaded = await resource.load()
          if (!Array.isArray(loaded)) return loaded
          // EdgeFastMCP's resource contract is single-valued. Truncating silently
          // would be data loss, so say so rather than drop entries quietly.
          if (loaded.length > 1) {
            warn(`resource "${resource.name}" returned ${loaded.length} results; only the first is served.`)
          }
          return loaded[0] ?? { text: "" }
        },
        mimeType: resource.mimeType,
        name: resource.name,
        uri: resource.uri,
      })
    },

    addResourceTemplate: () => unsupported("addResourceTemplate"),

    addTool: <P extends SchemaParams>(tool: Tool<T, P>) => {
      const context = createEdgeContext<T>(logger)
      server.addTool({
        description: tool.description ?? "",
        execute: async (params) => {
          const result = toEdgeResult(await tool.execute(params as InferSchemaOutput<P>, context))
          // EdgeFastMCP builds its response as `result: { content }`, dropping
          // `isError` entirely — a failed tool would reach the client looking like
          // a success. somamcp's telemetry wrapper converts every thrown error into
          // `isError: true`, so without this, tool errors could never surface on
          // edge at all. Throwing routes it into EdgeFastMCP's catch, which emits a
          // proper JSON-RPC error.
          // Throwing IS the protocol here: EdgeFastMCP's #handleToolsCall catch is the
          // only path that produces a JSON-RPC error response. Returning an Either
          // would be serialized as a successful result.
          // eslint-disable-next-line functype/prefer-either -- see note above
          if (typeof result !== "string" && result.isError === true) throw new Error(errorText(result))
          return result
        },
        name: tool.name,
        parameters: tool.parameters,
      } as EdgeTool<unknown>)
    },

    fetch: async (request: Request): Promise<Response> => app.fetch(request),

    getApp: (): Hono => app,

    // The stateless edge transport emits no connect/disconnect events.
    on: () => {},

    // EdgeFastMCP exposes no removal API; registration is one-way. The flag keeps
    // capability counts honest — a "removed" tool is still served, so it must
    // still be counted.
    removePrompt: () => unsupported("removePrompt"),
    removeResource: () => unsupported("removeResource"),
    removeTool: () => unsupported("removeTool"),
    supportsRemoval: false,

    // Edge runtimes are request-driven — there is nothing to start or stop.
    start: async () => {},
    stop: async () => {},
  }
}
