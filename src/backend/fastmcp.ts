import {
  FastMCP,
  type FastMCPSessionAuth,
  type InputPrompt as FMCPPrompt,
  type InputPromptArgument as FMCPPromptArgument,
  type Resource as FMCPResource,
  type ServerOptions as FMCPServerOptions,
  ServerState,
  type Tool as FMCPTool,
  type ToolParameters as FMCPToolParameters,
} from "fastmcp"
import type { Hono } from "hono"

import type { ServerStatus, SessionAuth } from "../types/core.js"
import type { ServerConfig, TransportConfig } from "../types/server.js"
import type { BackendAdapter, BackendSession } from "./adapter.js"

// ── State Mapping ─────────────────────────────────────────────────────

const mapServerState = (state: ServerState): ServerStatus => {
  switch (state) {
    case ServerState.Running:
      return "running"
    case ServerState.Error:
      return "error"
    default:
      return "stopped"
  }
}

// ── Factory ───────────────────────────────────────────────────────────

export const createFastMCPBackend = <T extends SessionAuth = SessionAuth>(
  config: ServerConfig<T>,
  backendOptions?: Record<string, unknown>,
): BackendAdapter<T> => {
  type FT = T & FastMCPSessionAuth

  const serverOptions: FMCPServerOptions<FT> = {
    ...(backendOptions as Partial<FMCPServerOptions<FT>>),
    authenticate: config.authenticate as FMCPServerOptions<FT>["authenticate"],
    instructions: config.instructions,
    logger: config.logger,
    name: config.name,
    version: config.version,
  }

  const server = new FastMCP<FT>(serverOptions)

  return {
    get serverState() {
      return mapServerState(server.serverState)
    },

    get sessions(): ReadonlyArray<BackendSession<T>> {
      return server.sessions.map((s) => ({
        sessionId: s.sessionId,
      }))
    },

    addPrompt: (prompt) => {
      server.addPrompt(prompt as unknown as FMCPPrompt<FT, FMCPPromptArgument<FT>[]>)
    },

    addResource: (resource) => {
      server.addResource(resource as unknown as FMCPResource<FT>)
    },

    addResourceTemplate: (...args) => {
      server.addResourceTemplate(...(args as unknown as Parameters<FastMCP<FT>["addResourceTemplate"]>))
    },

    addTool: (tool) => {
      server.addTool(tool as unknown as FMCPTool<FT, FMCPToolParameters>)
    },

    getApp: (): Hono => server.getApp(),

    on: (event, handler) => {
      server.on(event, handler as Parameters<FastMCP<FT>["on"]>[1])
    },

    removePrompt: (name) => server.removePrompt(name),
    removeResource: (name) => server.removeResource(name),
    removeTool: (name) => server.removeTool(name),

    start: async (transport?: TransportConfig) => {
      if (!transport) {
        await server.start()
        return
      }
      if (transport.transportType === "httpStream") {
        // somamcp's HttpStreamConfig is a structural superset of FastMCP's
        // fastmcp-specific types (CorsOptions, EventStore) are kept out of the
        // public surface — cast to unknown at the boundary.
        type FastMCPHttpStream = NonNullable<Parameters<FastMCP<FT>["start"]>[0]>["httpStream"]
        await server.start({
          httpStream: transport.httpStream as unknown as FastMCPHttpStream,
          transportType: "httpStream",
        })
      } else {
        await server.start({ transportType: "stdio" })
      }
    },

    stop: () => server.stop(),
  }
}
