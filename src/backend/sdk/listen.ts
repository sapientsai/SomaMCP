// Node-only transports for the SDK backend. Everything Node-specific is loaded
// with a dynamic import inside these functions, so importing the backend never
// pulls `node:*` into a Workers bundle; only calling `start()` does.
import type { McpServerFactory, Transport } from "@modelcontextprotocol/server"
import type { Hono } from "hono"

import type { HttpStreamConfig } from "../../types/server.js"

export type Listener = { close: () => Promise<void> }

/** Serve the Hono app (MCP endpoint, artifacts and routes) on a port. Resolves once listening. */
export const listenHttp = async (app: Hono, config: HttpStreamConfig): Promise<Listener> => {
  const { serve } = await import("@hono/node-server")
  const tls = config.sslCert && config.sslKey
  const createServer = tls ? (await import("node:https")).createServer : undefined

  return new Promise<Listener>((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname: config.host,
        port: config.port,
        ...(createServer
          ? { createServer, serverOptions: { ca: config.sslCa, cert: config.sslCert, key: config.sslKey } }
          : {}),
      },
      () =>
        resolve({
          close: () =>
            new Promise<void>((done, fail) => {
              server.close((error) => (error ? fail(error) : done()))
            }),
        }),
    )
    server.once("error", reject)
  })
}

/**
 * Serve MCP over the process's stdin/stdout, or over `transport` when given. Both
 * protocol eras are served; one server is pinned per connection.
 */
export const listenStdio = async (factory: McpServerFactory, transport?: Transport): Promise<Listener> => {
  const { serveStdio } = await import("@modelcontextprotocol/server/stdio")
  const handle = serveStdio(factory, transport ? { transport } : {})
  return { close: () => handle.close() }
}
