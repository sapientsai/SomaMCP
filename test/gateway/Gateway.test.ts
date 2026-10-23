import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { createSdkBackend } from "../../src/backend/sdk/index.js"
import { createGateway } from "../../src/gateway/Gateway.js"
import { createProxiedTools } from "../../src/gateway/toolProxy.js"
import { createServerCore } from "../../src/Server.js"
import { NoopTelemetry } from "../../src/telemetry/NoopTelemetry.js"
import { fetchInto, MCP_URL } from "../backend/sdk-clients.js"

describe("Gateway", () => {
  it("starts in disconnected state", () => {
    const gateway = createGateway({ id: "test", url: "http://localhost:9999/mcp" }, NoopTelemetry)

    expect(gateway.status).toBe("disconnected")
    expect(gateway.tools).toHaveLength(0)
  })

  it("uses config.name or falls back to id", () => {
    const withName = createGateway({ id: "test", name: "My Gateway", url: "http://localhost:9999/mcp" }, NoopTelemetry)
    expect(withName.name).toBe("My Gateway")

    const withoutName = createGateway({ id: "test-2", url: "http://localhost:9999/mcp" }, NoopTelemetry)
    expect(withoutName.name).toBe("test-2")
  })

  it("returns info with correct structure", () => {
    const gateway = createGateway({ id: "s1", name: "Remote", url: "http://localhost:3001/mcp" }, NoopTelemetry)

    const info = gateway.info
    expect(info.id).toBe("s1")
    expect(info.name).toBe("Remote")
    expect(info.status).toBe("disconnected")
    expect(info.url).toBe("http://localhost:3001/mcp")
    expect(info.remoteTools).toHaveLength(0)
  })

  it("handles connection error gracefully", async () => {
    const events: unknown[] = []
    const telemetry = {
      recordEvent: (e: unknown) => events.push(e),
    }

    const gateway = createGateway({ id: "fail", reconnect: false, url: "http://localhost:1/mcp" }, telemetry)

    await gateway.connect()

    expect(gateway.status).toBe("error")
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "gateway.error" })
  })

  it("throws when calling tool while disconnected", async () => {
    const gateway = createGateway({ id: "test", url: "http://localhost:9999/mcp" }, NoopTelemetry)

    await expect(gateway.callTool("some-tool")).rejects.toThrow("not connected")
  })

  it("disconnect cleans up state", async () => {
    const events: unknown[] = []
    const telemetry = {
      recordEvent: (e: unknown) => events.push(e),
    }

    const gateway = createGateway({ id: "dc", url: "http://localhost:9999/mcp" }, telemetry)

    await gateway.disconnect()

    expect(gateway.status).toBe("disconnected")
    expect(gateway.tools).toHaveLength(0)
  })
})

describe("Gateway against real servers", () => {
  /** A somamcp server on the SDK 2.x backend, which offers 2026-07-28. */
  const modernServer = () => {
    const server = createServerCore({
      backend: createSdkBackend,
      enableIntrospection: false,
      name: "modern",
      version: "1.0.0",
    })
    server.addTool({
      description: "Echo",
      execute: async ({ text }) => `modern:${text}`,
      name: "echo",
      parameters: z.object({ text: z.string() }),
    })
    return server
  }

  /** An SDK 1.x server that only speaks the 2025 handshake. */
  const legacyServer = {
    fetch: async (request: Request): Promise<Response> => {
      const server = new McpServer({ name: "legacy", version: "1.0.0" })
      server.registerTool("echo", { description: "Echo", inputSchema: { text: z.string() } }, async ({ text }) => ({
        content: [{ text: `legacy:${text}`, type: "text" as const }],
      }))
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
      await server.connect(transport)
      return transport.handleRequest(request)
    },
  }

  /** An SDK 1.x server with sessions, FastMCP's default: one transport per Mcp-Session-Id. */
  const sessionfulLegacyServer = () => {
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()
    return {
      fetch: async (request: Request): Promise<Response> => {
        const existing = sessions.get(request.headers.get("mcp-session-id") ?? "")
        if (existing) return existing.handleRequest(request)
        const server = new McpServer({ name: "sessionful", version: "1.0.0" })
        server.registerTool("echo", { description: "Echo", inputSchema: { text: z.string() } }, async ({ text }) => ({
          content: [{ text: `sessionful:${text}`, type: "text" as const }],
        }))
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, transport)
          },
          sessionIdGenerator: () => crypto.randomUUID(),
        })
        await server.connect(transport)
        return transport.handleRequest(request)
      },
    }
  }

  /** Answers the server/discover probe with a 500, as FastMCP on mcp-proxy 6.7.0–6.7.11 did. */
  const failsTheProbe = (server: { fetch: (request: Request) => Promise<Response> }) => ({
    fetch: async (request: Request): Promise<Response> => {
      const body = (await request.clone().json()) as { method?: string }
      return body.method === "server/discover" ? new Response("boom", { status: 500 }) : server.fetch(request)
    },
  })

  it.each([
    ["2026-07-28", modernServer(), "2026-07-28", "modern:hi"],
    ["2025-only", legacyServer, "2025", "legacy:hi"],
    ["sessionful 2025-only", sessionfulLegacyServer(), "2025", "sessionful:hi"],
  ] as const)("connects to a %s server, lists and calls its tools", async (_label, server, era, expected) => {
    const gateway = createGateway(
      { fetch: fetchInto(server), id: "remote", reconnect: false, url: MCP_URL.href },
      NoopTelemetry,
    )

    await gateway.connect()

    expect(gateway.status).toBe("connected")
    expect(gateway.info.protocolVersion?.startsWith(era)).toBe(true)
    expect(gateway.tools.map((tool) => tool.name)).toEqual(["echo"])
    expect(await gateway.callTool("echo", { text: "hi" })).toMatchObject({
      content: [{ text: expected, type: "text" }],
    })

    await gateway.disconnect()
    expect(gateway.info.protocolVersion).toBeUndefined()
  })

  it("cannot reach a server that answers the probe with a 5xx in auto mode", async () => {
    const gateway = createGateway(
      { fetch: fetchInto(failsTheProbe(sessionfulLegacyServer())), id: "remote", reconnect: false, url: MCP_URL.href },
      NoopTelemetry,
    )
    await gateway.connect()
    expect(gateway.status).toBe("error")
  })

  it("reaches it with versionNegotiation: legacy, which skips the probe", async () => {
    const gateway = createGateway(
      {
        fetch: fetchInto(failsTheProbe(sessionfulLegacyServer())),
        id: "remote",
        reconnect: false,
        url: MCP_URL.href,
        versionNegotiation: "legacy",
      },
      NoopTelemetry,
    )
    await gateway.connect()
    expect(gateway.status).toBe("connected")
    expect(await gateway.callTool("echo", { text: "hi" })).toMatchObject({ content: [{ text: "sessionful:hi" }] })
    await gateway.disconnect()
  })

  it("serves remote tools through proxied tools", async () => {
    const gateway = createGateway(
      { fetch: fetchInto(modernServer()), id: "remote", reconnect: false, url: MCP_URL.href },
      NoopTelemetry,
    )
    await gateway.connect()

    const [proxied] = createProxiedTools(gateway)
    expect(proxied?.name).toBe("remote_echo")
    const result = await proxied?.execute({ text: "hi" }, {} as never)
    expect(String(result)).toContain("modern:hi")

    await gateway.disconnect()
  })
})
