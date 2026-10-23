import type { McpServerFactory, Transport } from "@modelcontextprotocol/server"
import type { Hono } from "hono"

import type { HttpStreamConfig } from "../../types/server.js"

export type Listener = { close: () => Promise<void> }

/**
 * The Node-only ways to serve the SDK backend: a port and stdio. `somamcp/node`
 * supplies them. The main entry has none, so it serves through `fetch` alone and
 * stays free of Node APIs.
 */
export type SdkTransports = {
  /** Serve the Hono app (MCP endpoint, artifacts and routes) on a port. Resolves once listening. */
  http: (app: Hono, config: HttpStreamConfig) => Promise<Listener>
  /** Serve MCP over stdin/stdout, or over `transport` when given. */
  stdio: (factory: McpServerFactory, transport?: Transport) => Promise<Listener>
}
