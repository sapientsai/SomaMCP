import type { FetchLike, Tool as MCPTool } from "@modelcontextprotocol/client"
import type { Option } from "functype"

export type GatewayConfig = {
  /**
   * Replaces the global `fetch` for every request to the remote server, e.g. a
   * Workers service binding's `fetch`, or one that adds credentials.
   */
  fetch?: FetchLike
  id: string
  name?: string
  proxyTools?: boolean
  reconnect?: boolean
  reconnectIntervalMs?: number
  toolPrefix?: string
  url: string
}

export type GatewayStatus = "connected" | "connecting" | "disconnected" | "error"

export type GatewayInfo = {
  id: string
  name: string
  /** Protocol revision negotiated with the remote server; absent until connected. */
  protocolVersion?: string
  remoteTools: ReadonlyArray<{ description?: string; name: string }>
  status: GatewayStatus
  url: string
}

export type GatewayInstance = {
  readonly config: GatewayConfig
  readonly info: GatewayInfo
  readonly name: string
  readonly status: GatewayStatus
  readonly tools: ReadonlyArray<MCPTool>
  callTool: (name: string, args?: Record<string, unknown>) => Promise<unknown>
  connect: () => Promise<void>
  disconnect: () => Promise<void>
}

export type GatewayManagerInstance = {
  readonly connectedCount: number
  readonly totalCount: number
  add: (config: GatewayConfig) => GatewayInstance
  connectAll: () => Promise<void>
  disconnectAll: () => Promise<void>
  get: (id: string) => Option<GatewayInstance>
  getAll: () => ReadonlyArray<GatewayInstance>
  getInfoAll: () => ReadonlyArray<GatewayInfo>
}
