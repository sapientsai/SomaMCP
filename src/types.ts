import type {
  FastMCP,
  FastMCPSession,
  FastMCPSessionAuth,
  InputPrompt,
  InputPromptArgument,
  Resource,
  ServerOptions,
  ServerState,
  Tool,
  ToolParameters,
} from "fastmcp"
import type { Hono } from "hono"
import type { ILogLayer } from "loglayer"

import type { ArtifactConfig } from "./artifacts/types.js"
import type { GatewayConfig, GatewayManagerInstance } from "./gateway/types.js"
import type { TelemetryCollector } from "./telemetry/TelemetryCollector.js"

export type CellOptions<T extends FastMCPSessionAuth = FastMCPSessionAuth> = ServerOptions<T> & {
  artifacts?: ArtifactConfig[]
  enableDashboard?: boolean
  enableIntrospection?: boolean
  gateways?: GatewayConfig[]
  logLayer?: ILogLayer
  telemetry?: TelemetryCollector
}

export type CellHealth = {
  activeSessions: number
  name: string
  startedAt: number
  status: "running" | "stopped" | "error"
  gateways: {
    connected: number
    total: number
  }
  uptime: number
}

export type CellCapabilities = {
  prompts: ReadonlyArray<{ description?: string; name: string }>
  resources: ReadonlyArray<{ description?: string; name: string; uri: string }>
  tools: ReadonlyArray<{ description?: string; name: string }>
}

export type CellTool<
  T extends FastMCPSessionAuth = FastMCPSessionAuth,
  P extends ToolParameters = ToolParameters,
> = Tool<T, P>

export type CellInstance<T extends FastMCPSessionAuth = FastMCPSessionAuth> = {
  readonly name: string
  readonly serverState: ServerState
  readonly sessions: FastMCPSession<T>[]
  addPrompt: <Args extends InputPromptArgument<T>[]>(prompt: InputPrompt<T, Args>) => void
  addPrompts: <Args extends InputPromptArgument<T>[]>(prompts: InputPrompt<T, Args>[]) => void
  addResource: (resource: Resource<T>) => void
  addResources: (resources: Resource<T>[]) => void
  addResourceTemplate: (...args: Parameters<FastMCP<T>["addResourceTemplate"]>) => void
  addTool: <P extends ToolParameters>(tool: Tool<T, P>) => void
  addTools: <P extends ToolParameters>(tools: Tool<T, P>[]) => void
  getApp: () => Hono
  getCapabilities: () => CellCapabilities
  getGatewayManager: () => GatewayManagerInstance
  getHealth: () => CellHealth
  removePrompt: (name: string) => void
  removeResource: (name: string) => void
  removeTool: (name: string) => void
  start: (options?: Parameters<FastMCP<T>["start"]>[0]) => Promise<void>
  stop: () => Promise<void>
}
