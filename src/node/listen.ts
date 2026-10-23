// The SDK backend's Node transports, which `somamcp/node` plugs in. Only that
// entry reaches this module, so the main entry never imports `node:*`.
import { createServer as createHttpsServer } from "node:https"

import { serve } from "@hono/node-server"
import type { McpServerFactory, Transport } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import type { Hono } from "hono"

import type { Listener, SdkTransports } from "../backend/sdk/transports.js"
import type { HttpStreamConfig } from "../types/server.js"

/** Serve the Hono app (MCP endpoint, artifacts and routes) on a port. Resolves once listening. */
export const listenHttp = (app: Hono, config: HttpStreamConfig): Promise<Listener> => {
  const createServer = config.sslCert && config.sslKey ? createHttpsServer : undefined

  return new Promise<Listener>((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        // Bind to loopback unless a host is given explicitly, as somamcp 1.x did.
        hostname: config.host ?? "localhost",
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
              // Idle keep-alive sockets would otherwise hold close() open until they time out.
              if ("closeAllConnections" in server) server.closeAllConnections()
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
export const listenStdio = (factory: McpServerFactory, transport?: Transport): Promise<Listener> =>
  // Inside then(), so a synchronous throw still rejects start().
  Promise.resolve().then(() => {
    const handle = serveStdio(factory, transport ? { transport } : {})
    return { close: () => handle.close() }
  })

export const NODE_TRANSPORTS: SdkTransports = { http: listenHttp, stdio: listenStdio }
