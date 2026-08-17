import type { DirectLogger } from "functype-log"
import type { Hono } from "hono"

import type { ArtifactConfig } from "./artifacts/types.js"
import type { BackendFactory, BackendSession } from "./backend/adapter.js"
import type { BuildInfo, RuntimeInfo } from "./buildInfo.js"
import type { GatewayConfig, GatewayManagerInstance } from "./gateway/types.js"
import type { TelemetryCollector, ToolCaptureConfig } from "./telemetry/TelemetryCollector.js"
import type { Prompt, PromptArgument, Resource, SchemaParams, ServerStatus, SessionAuth, Tool } from "./types/core.js"
import type { RouteConfig } from "./types/routes.js"
import type { ServerConfig, TransportConfig } from "./types/server.js"

export type SomaServerOptions<T extends SessionAuth = SessionAuth> = ServerConfig<T> & {
  artifacts?: ArtifactConfig[]
  /**
   * Backend implementation. Defaults to `createFastMCPBackend` (Node).
   * Pass `createEdgeBackend` from `somamcp/edge` to target Cloudflare Workers,
   * Deno Deploy, or Bun.
   */
  backend?: BackendFactory<T>
  backendOptions?: Record<string, unknown>
  build?: BuildInfo
  enableDashboard?: boolean
  enableHealthEndpoint?: boolean
  enableInfoEndpoint?: boolean
  enableIntrospection?: boolean
  gateways?: GatewayConfig[]
  healthDetailPath?: string
  healthPath?: string
  infoPath?: string
  introspectionPrefix?: string
  logLayer?: DirectLogger
  telemetry?: TelemetryCollector
}

export type ServerHealth = {
  activeSessions: number
  gateways: {
    connected: number
    total: number
  }
  name: string
  startedAt: number
  status: ServerStatus
  uptime: number
}

export type ServerCapabilities = {
  prompts: ReadonlyArray<{ description?: string; name: string }>
  resources: ReadonlyArray<{ description?: string; name: string; uri: string }>
  tools: ReadonlyArray<{ description?: string; name: string }>
}

export type CapabilitiesSummary = {
  prompts: number
  resources: number
  tools: number
}

export type ServerInfo = {
  build: BuildInfo
  capabilities: CapabilitiesSummary
  name: string
  runtime: RuntimeInfo
  version: string
}

export type ToolOptions<T extends SessionAuth = SessionAuth, P extends SchemaParams = SchemaParams> = Tool<T, P> & {
  captureConfig?: ToolCaptureConfig
}

export type SomaServerInstance<T extends SessionAuth = SessionAuth> = {
  readonly name: string
  readonly serverState: ServerStatus
  readonly sessions: ReadonlyArray<BackendSession<T>>
  addPrompt: <Args extends PromptArgument<T>[]>(prompt: Prompt<T, Args>) => void
  addPrompts: <Args extends PromptArgument<T>[]>(prompts: Prompt<T, Args>[]) => void
  addResource: (resource: Resource<T>) => void
  addResources: (resources: Resource<T>[]) => void
  addResourceTemplate: (...args: ReadonlyArray<unknown>) => void
  addRoute: (route: RouteConfig) => void
  addTool: <P extends SchemaParams>(tool: Tool<T, P>) => void
  addTools: <P extends SchemaParams>(tools: Tool<T, P>[]) => void
  /**
   * Web-standard request handler covering both MCP calls and registered
   * artifacts/routes. This is the entry point for edge runtimes:
   * `export default { fetch: (req) => server.fetch(req) }`.
   */
  fetch: (request: Request) => Promise<Response>
  getApp: () => Hono
  getCapabilities: () => ServerCapabilities
  getGatewayManager: () => GatewayManagerInstance
  getHealth: () => ServerHealth
  getInfo: () => ServerInfo
  removePrompt: (name: string) => void
  removeResource: (name: string) => void
  removeTool: (name: string) => void
  start: (options?: TransportConfig) => Promise<void>
  stop: () => Promise<void>
}
