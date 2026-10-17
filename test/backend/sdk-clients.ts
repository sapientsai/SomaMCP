// Real MCP clients for the SDK backend tests: SDK 2.x (2026-07-28 era) and SDK 1.x (2025 handshake).
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client"
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

export type Fetchable = { fetch: (request: Request) => Promise<Response> }

export const MCP_URL = new URL("http://sdk.test/mcp")

/** Routes a client's HTTP calls straight into a server's fetch handler, no port needed. */
export const fetchInto =
  (server: Fetchable) =>
  (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    server.fetch(new Request(input, init))

/** Adds a header to every request before it reaches the server. */
export const withHeader = (server: Fetchable, name: string, value: string): Fetchable => ({
  fetch: (request) => {
    const headers = new Headers(request.headers)
    headers.set(name, value)
    return server.fetch(new Request(request, { headers }))
  },
})

export const connectModern = async (server: Fetchable, url: URL = MCP_URL): Promise<ModernClient> => {
  const client = new ModernClient(
    { name: "modern", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  )
  await client.connect(new ModernTransport(url, { fetch: fetchInto(server) }))
  return client
}

export const connectAuto = async (server: Fetchable, url: URL = MCP_URL): Promise<ModernClient> => {
  const client = new ModernClient({ name: "auto", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } })
  await client.connect(new ModernTransport(url, { fetch: fetchInto(server) }))
  return client
}

export const connectLegacy = async (server: Fetchable, url: URL = MCP_URL): Promise<LegacyClient> => {
  const client = new LegacyClient({ name: "legacy", version: "1.0.0" })
  await client.connect(new LegacyTransport(url, { fetch: fetchInto(server) }))
  return client
}

/** The two client generations behind one interface the tests can loop over. */
export const ERAS = [
  ["2026-07-28", connectModern],
  ["2025 handshake", connectLegacy],
] as const

const ENVELOPE = {
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1.0.0" },
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
}

/** A hand-built JSON-RPC POST. Modern requests also carry the envelope and the routing headers 2026-07-28 requires. */
export const rawRequest = (
  method: string,
  params: Record<string, unknown> = {},
  options: { headers?: Record<string, string>; modern?: boolean; url?: URL } = {},
): Request => {
  const modern = options.modern ?? false
  const name: Record<string, string> = typeof params.name === "string" ? { "mcp-name": params.name } : {}
  return new Request(options.url ?? MCP_URL, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method,
      params: modern
        ? { ...params, _meta: { ...ENVELOPE, ...(params._meta as Record<string, unknown> | undefined) } }
        : params,
    }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(modern ? { "mcp-method": method, "mcp-protocol-version": "2026-07-28", ...name } : {}),
      ...options.headers,
    },
    method: "POST",
  })
}
