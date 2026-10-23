import { createMcpHandler, type McpHttpHandler, type Transport } from "@modelcontextprotocol/server"
import { Map, Option, Ref, Try, Tuple } from "functype"
import { type Context as HonoContext, Hono, type MiddlewareHandler } from "hono"
import { cors } from "hono/cors"

import type { Resource, ResourceTemplate, ServerStatus, SessionAuth } from "../../types/core.js"
import type { HttpStreamConfig, ServerConfig, TransportConfig } from "../../types/server.js"
import type { BackendAdapter, BackendSession } from "../adapter.js"
import { type AnyPrompt, type AnyTool, buildServer, type Registry } from "./handlers.js"
import { hasJsonSchema } from "./mapping.js"
import type { Listener, SdkTransports } from "./transports.js"

export type SdkBackendOptions = {
  /** MCP endpoint path when serving through `fetch`. `start({ httpStream: { endpoint } })` overrides it. Defaults to "/mcp". */
  mcpPath?: string
  /**
   * Node only (`somamcp/node`): transport for `start({ transportType: "stdio" })` in place of the process's
   * stdin/stdout, e.g. a `StdioServerTransport` over a Unix socket.
   */
  stdioTransport?: Transport
}

const DEFAULT_MCP_PATH = "/mcp"
/** somamcp 1.x's default keepalive interval, kept so `streamKeepalive` means what it did. */
const DEFAULT_KEEPALIVE_MS = 20_000
const SESSION_KEY = "somamcp/session"

const nodeOnly = (transportType: TransportConfig["transportType"]): Promise<never> =>
  Promise.reject(
    new Error(
      `start({ transportType: "${transportType}" }) needs Node: use the createServer exported by somamcp/node, or serve requests with server.fetch().`,
    ),
  )

/**
 * The SDK backend, with `transports` deciding what `start()` can listen on: none
 * for the main entry (WinterTC APIs only), a port and stdio for `somamcp/node`.
 */
export const buildSdkBackend = <T extends SessionAuth = SessionAuth>(
  transports: Option<SdkTransports>,
  config: ServerConfig<T>,
  backendOptions?: Record<string, unknown>,
): BackendAdapter<T> => {
  const logger = Option(config.logger)
  const warn = (message: string): void => logger.forEach((l) => l.warn(`[somamcp/sdk] ${message}`))

  const tools = Ref(Map.empty<string, AnyTool<T>>())
  const resources = Ref(Map.empty<string, Resource<T>>())
  const templates = Ref(Map.empty<string, ResourceTemplate<T>>())
  const prompts = Ref(Map.empty<string, AnyPrompt<T>>())
  const registry: Registry<T> = {
    prompts: () => prompts.get(),
    resources: () => resources.get(),
    templates: () => templates.get(),
    tools: () => tools.get(),
  }

  /** Register under `name`, replacing any entry with the same name. */
  const put = <V>(store: Ref<Map<string, V>>, name: string, value: V): void => {
    store.set(store.get().add(Tuple<[string, V]>([name, value])))
  }
  const drop = <V>(store: Ref<Map<string, V>>, name: string): void => {
    store.set(store.get().remove(name))
  }
  const identity = {
    authRequired: config.authenticate !== undefined,
    instructions: config.instructions,
    name: config.name,
    version: config.version,
  }

  const keepAliveMs = Option(config.streamKeepalive)
    .filter((k) => k.enabled === true)
    .map((k) => k.intervalMs ?? DEFAULT_KEEPALIVE_MS)

  // In "auto" mode the SDK only streams once a notification precedes the result, and
  // keepalive frames only flow on a stream. A long, silent tool call would then get no
  // keepalive at all, which is the case streamKeepalive exists for. So when it is on,
  // always stream.
  const defaultResponseMode = keepAliveMs.fold<"auto" | "sse">(
    () => "auto",
    () => "sse",
  )

  // The session reaches the per-request factory through `authInfo`, which the SDK
  // hands over unchanged in both eras. Keying by the Request object does not work:
  // the 2025-era leg gives the factory a different Request than the one we saw.
  const createHandler = (responseMode: "auto" | "json" | "sse"): McpHttpHandler =>
    createMcpHandler(
      ({ authInfo }) =>
        buildServer(
          registry,
          identity,
          Option(authInfo).flatMap((a) => Option(a.extra?.[SESSION_KEY] as T)),
        ),
      {
        keepAliveMs: keepAliveMs.orUndefined(),
        onerror: (error) => logger.forEach((l) => l.error("[somamcp/sdk]", error)),
        responseMode,
      },
    )

  const responseMode = Ref<"auto" | "json" | "sse">(defaultResponseMode)
  const handler = Ref(createHandler(responseMode.get()))
  const mcpPath = Ref(
    Option(backendOptions as SdkBackendOptions)
      .flatMap((o) => Option(o.mcpPath))
      .orElse(DEFAULT_MCP_PATH),
  )
  const corsMiddleware = Ref<Option<MiddlewareHandler>>(Option.none())
  const listener = Ref<Option<Listener>>(Option.none())
  // "running" from construction: a backend that can answer `fetch` is serving. start()
  // adds a listener; stop() is what takes it out of service.
  const state = Ref<ServerStatus>("running")

  /** A rejected `authenticate` may carry a Response (somamcp 1.x's convention, from FastMCP); serve it as-is. */
  const unauthorized = (c: HonoContext, reason: unknown): Response =>
    reason instanceof Response ? reason : c.json({ error: "Unauthorized" }, 401)

  /**
   * `authenticate`, with somamcp 1.x's failure semantics: a synchronous throw
   * counts as a rejection, and a nullish result counts as a failed authentication
   * (the idiomatic way to signal one).
   */
  const authenticateRequest = (
    authenticate: NonNullable<ServerConfig<T>["authenticate"]>,
    request: Option<Request>,
  ): Promise<T> =>
    Promise.resolve()
      .then(() => authenticate(request.orUndefined()))
      .then((auth) =>
        Option(auth).fold(
          () => Promise.reject(new Error("Authentication required")),
          (session) => Promise.resolve(session),
        ),
      )

  const serveMcp = async (c: HonoContext): Promise<Response> => {
    const request = c.req.raw
    if (!config.authenticate) return handler.get().fetch(request)
    // Not Try.fromPromise: it would wrap a rejected Response, which must reach the client as-is.
    return authenticateRequest(config.authenticate, Option(request)).then(
      (session) =>
        handler.get().fetch(request, {
          authInfo: { clientId: "", extra: { [SESSION_KEY]: session }, scopes: [], token: "" },
        }),
      (reason: unknown) => unauthorized(c, reason),
    )
  }

  const app = new Hono()
  // Registered first so it sees requests before artifacts and routes; it only
  // claims the MCP path, which is read per request so `start()` can move it.
  app.use("*", async (c, next) => {
    if (c.req.path !== mcpPath.get()) return next()
    return corsMiddleware.get().fold(
      () => serveMcp(c),
      async (middleware) => {
        const preflight = await middleware(c, async () => {
          c.res = await serveMcp(c)
        })
        return preflight ?? c.res
      },
    )
  })

  const applyHttpConfig = (http: HttpStreamConfig): void => {
    Option(http.endpoint).forEach((endpoint) => mcpPath.set(endpoint))
    Option(http.cors)
      .filter((value) => value !== false)
      .forEach((value) => corsMiddleware.set(Option(cors(value === true ? {} : (value as Parameters<typeof cors>[0])))))
    if (http.enableJsonResponse === true) {
      if (keepAliveMs.isSome())
        warn("enableJsonResponse disables streamKeepalive: JSON responses cannot carry keepalive frames.")
      responseMode.set("json")
      handler.set(createHandler("json"))
    }
    if (http.stateless === false) warn("stateful sessions are not supported by the SDK backend; serving statelessly.")
  }

  const startStdio = async (serve: SdkTransports): Promise<Listener> => {
    // stdio has no request to authenticate. As in somamcp 1.x, call authenticate
    // once with no request and serve without a session if it fails; tools gated
    // by canAccess are then hidden.
    const session = config.authenticate
      ? (await Try.fromPromise(authenticateRequest(config.authenticate, Option.none()))).fold(
          (error) => {
            logger.forEach((l) => l.error("[somamcp/sdk] authentication failed for stdio transport:", error.message))
            return Option.none<T>()
          },
          (auth) => Option(auth),
        )
      : Option.none<T>()
    const transport = Option(backendOptions as SdkBackendOptions)
      .flatMap((o) => Option(o.stdioTransport))
      .orUndefined()
    return serve.stdio(() => buildServer(registry, identity, session), transport)
  }

  const startHttp = (serve: SdkTransports, http: HttpStreamConfig): Promise<Listener> => {
    applyHttpConfig(http)
    return serve.http(app, http)
  }

  /**
   * What `start(transport)` listens on. Without Node transports, a bare `start()`
   * listens on nothing (it still marks the server started and connects gateways);
   * asking for a port or stdio rejects. With them, a bare `start()` means stdio,
   * as it did in somamcp 1.x.
   */
  const openListener = (transport?: TransportConfig): Promise<Option<Listener>> =>
    transports.fold(
      () => (transport ? nodeOnly(transport.transportType) : Promise.resolve(Option.none<Listener>())),
      (serve) =>
        (transport?.transportType === "httpStream" ? startHttp(serve, transport.httpStream) : startStdio(serve)).then(
          (opened) => Option(opened),
        ),
    )

  return {
    get serverState(): ServerStatus {
      return state.get()
    },

    get sessions(): ReadonlyArray<BackendSession<T>> {
      return []
    },

    addPrompt: (prompt) => {
      put(prompts, prompt.name, prompt as unknown as AnyPrompt<T>)
    },
    addResource: (resource) => {
      put(resources, resource.name, resource)
    },
    addResourceTemplate: (template) => {
      put(templates, template.name, template)
    },
    addTool: (tool) => {
      if (tool.parameters && !hasJsonSchema(tool.parameters)) {
        warn(
          `tool "${tool.name}": its schema has no ~standard.jsonSchema, so clients see an empty argument list. Use zod 4, ArkType, or Valibot with @valibot/to-json-schema.`,
        )
      }
      put(tools, tool.name, tool as unknown as AnyTool<T>)
    },

    fetch: async (request: Request): Promise<Response> => app.fetch(request),
    getApp: (): Hono => app,

    // Stateless serving has no connections to report.
    on: () => {},

    removePrompt: (name) => {
      drop(prompts, name)
    },
    removeResource: (name) => {
      drop(resources, name)
    },
    removeTool: (name) => {
      drop(tools, name)
    },

    start: async (transport?: TransportConfig) => {
      if (listener.get().isSome()) {
        warn("start() called while already listening; ignoring. Call stop() first to restart.")
        return
      }
      const started = await Try.fromPromise(openListener(transport))
      if (started.isFailure()) state.set("error")
      // Rethrows the original error on failure, so a bad port still rejects start().
      listener.set(started.orThrow())
      state.set("running")
    },

    stop: async () => {
      // Handler first: closing it aborts in-flight exchanges, which would otherwise
      // hold the listener's close open until a long streamed call finished.
      await handler.get().close()
      await listener.get().fold(
        async () => {},
        (l) => l.close(),
      )
      listener.set(Option.none())
      // A closed handler answers every request with an error; give start() a fresh one.
      handler.set(createHandler(responseMode.get()))
      state.set("stopped")
    },
  }
}

/**
 * Backend built on the official MCP TypeScript SDK 2.x (`@modelcontextprotocol/server`).
 *
 * One endpoint serves both protocol eras: the `2026-07-28` revision that current
 * Claude clients request first, and 2025-era clients (`initialize`). Serving is
 * stateless: every request gets a fresh SDK server built from somamcp's registry,
 * so there are no sessions, `connect`/`disconnect` never fire, and a 2025 client's
 * GET or DELETE is answered `405`.
 *
 * This is the WinterTC build: it serves through `fetch()` on any runtime with
 * web-standard `Request`/`Response`, and `start()` with a transport rejects. For a
 * port or stdio, use `createNodeBackend` from `somamcp/node`.
 */
export const createSdkBackend = <T extends SessionAuth = SessionAuth>(
  config: ServerConfig<T>,
  backendOptions?: Record<string, unknown>,
): BackendAdapter<T> => buildSdkBackend(Option.none(), config, backendOptions)
