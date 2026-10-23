// The SDK backend's Node transports: a real listening port, and stdio over a linked transport pair.
import { Client as ModernClient } from "@modelcontextprotocol/client"
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { getRandomPort } from "get-port-please"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { createServer } from "../../src/node/index.js"
import type { SomaServerInstance } from "../../src/types.js"
import type { HttpStreamConfig } from "../../src/types/server.js"
import { connectLegacy, connectModern } from "./sdk-clients.js"

/** Real network fetch, so the clients go over the socket rather than into server.fetch. */
const network = { fetch: (request: Request) => fetch(request) }

const running: SomaServerInstance[] = []
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.stop()))
})

const makeServer = (backendOptions?: Record<string, unknown>) => {
  const server = createServer({ backendOptions, name: "node", version: "1.0.0" })
  server.addTool({
    execute: (args) => Promise.resolve(`echo: ${args.text}`),
    name: "echo",
    parameters: z.object({ text: z.string() }),
  })
  return server
}

const listen = async (http: Partial<HttpStreamConfig> = {}) => {
  const port = await getRandomPort()
  const server = makeServer()
  await server.start({ httpStream: { host: "127.0.0.1", port, ...http }, transportType: "httpStream" })
  running.push(server)
  return { server, url: new URL(`http://127.0.0.1:${port}${http.endpoint ?? "/mcp"}`) }
}

describe("createNodeBackend", () => {
  describe("httpStream", () => {
    it("serves a 2026-07-28 client and a 2025 client on one port", async () => {
      const { url } = await listen()
      const modern = await connectModern(network, url)
      const legacy = await connectLegacy(network, url)
      expect(JSON.stringify(await modern.callTool({ arguments: { text: "a" }, name: "echo" }))).toContain("echo: a")
      expect(JSON.stringify(await legacy.callTool({ arguments: { text: "b" }, name: "echo" }))).toContain("echo: b")
    })

    it("serves somamcp's health route on the same port", async () => {
      const { url } = await listen()
      const res = await fetch(new URL("/health", url))
      expect(res.status).toBe(200)
    })

    it("honours a custom endpoint", async () => {
      const { url } = await listen({ endpoint: "/rpc" })
      expect(url.pathname).toBe("/rpc")
      expect((await (await connectModern(network, url)).listTools()).tools.map((t) => t.name)).toContain("echo")
    })

    it("answers CORS preflight when cors is on", async () => {
      const { url } = await listen({ cors: true })
      const res = await fetch(url, {
        headers: { "access-control-request-method": "POST", origin: "https://example.com" },
        method: "OPTIONS",
      })
      expect(res.status).toBeLessThan(300)
      expect(res.headers.get("access-control-allow-origin")).toBe("*")
    })

    it("reports running, then stopped after stop()", async () => {
      const { server } = await listen()
      expect(server.getHealth().status).toBe("running")
      await server.stop()
      running.splice(running.indexOf(server), 1)
      expect(server.getHealth().status).toBe("stopped")
    })

    it("warns that stateful sessions are not supported", async () => {
      const warn = vi.fn()
      const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), warn }
      const server = createServer({ logger, name: "warn", version: "1.0.0" })
      await server.start({
        httpStream: { host: "127.0.0.1", port: await getRandomPort(), stateless: false },
        transportType: "httpStream",
      })
      running.push(server)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("stateful sessions are not supported"))
    })

    it("ignores a second start() while listening", async () => {
      const warn = vi.fn()
      const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), warn }
      const server = createServer({ logger, name: "twice", version: "1.0.0" })
      const http = { host: "127.0.0.1", port: await getRandomPort() }
      await server.start({ httpStream: http, transportType: "httpStream" })
      running.push(server)
      await server.start({ httpStream: http, transportType: "httpStream" })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("already listening"))
      expect(server.getHealth().status).toBe("running")
    })

    it("restarts after stop()", async () => {
      const port = await getRandomPort()
      const http = { host: "127.0.0.1", port }
      const server = makeServer()
      await server.start({ httpStream: http, transportType: "httpStream" })
      await server.stop()
      await server.start({ httpStream: http, transportType: "httpStream" })
      running.push(server)
      const client = await connectModern(network, new URL(`http://127.0.0.1:${port}/mcp`))
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("echo")
    })

    it("stop() does not wait for an in-flight streamed call", async () => {
      const port = await getRandomPort()
      const server = createServer({
        name: "slow",
        streamKeepalive: { enabled: true, intervalMs: 50 },
        version: "1.0.0",
      })
      server.addTool({
        execute: () => new Promise((resolve) => setTimeout(() => resolve("late"), 5_000)),
        name: "slow",
        parameters: z.object({}),
      })
      await server.start({ httpStream: { host: "127.0.0.1", port }, transportType: "httpStream" })
      const client = await connectModern(network, new URL(`http://127.0.0.1:${port}/mcp`))
      void client.callTool({ arguments: {}, name: "slow" }).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 200))
      const started = performance.now()
      await server.stop()
      expect(performance.now() - started).toBeLessThan(1_000)
    })

    it("binds to localhost when no host is given, as somamcp 1.x did", async () => {
      const port = await getRandomPort()
      const server = makeServer()
      await server.start({ httpStream: { port }, transportType: "httpStream" })
      running.push(server)
      expect((await fetch(`http://localhost:${port}/health`)).status).toBe(200)
    })

    it("rejects start() when the port is taken", async () => {
      const { url } = await listen()
      const second = makeServer()
      await expect(
        second.start({ httpStream: { host: "127.0.0.1", port: Number(url.port) }, transportType: "httpStream" }),
      ).rejects.toThrow()
      expect(second.getHealth().status).toBe("error")
    })
    it("hands authenticate the web Request on protected routes too", async () => {
      const seen: unknown[] = []
      const port = await getRandomPort()
      const server = createServer({
        authenticate: (request) => {
          seen.push(request)
          return Promise.resolve({ user: "u" })
        },
        name: "auth",
        version: "1.0.0",
      })
      server.addRoute({ handler: (c) => c.text("ok"), method: "GET", path: "/private", protected: true })
      await server.start({ httpStream: { host: "127.0.0.1", port }, transportType: "httpStream" })
      running.push(server)

      expect((await fetch(`http://127.0.0.1:${port}/private`)).status).toBe(200)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toBeInstanceOf(Request)
    })
  })

  describe("stdio", () => {
    const startStdio = async () => {
      const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
      const server = makeServer({ stdioTransport: serverEnd })
      await server.start({ transportType: "stdio" })
      running.push(server)
      return clientEnd
    }

    it("serves an auto-negotiating SDK 2.x client", async () => {
      const client = new ModernClient(
        { name: "stdio-modern", version: "1.0.0" },
        { versionNegotiation: { mode: "auto" } },
      )
      await client.connect(await startStdio())
      expect(JSON.stringify(await client.callTool({ arguments: { text: "s" }, name: "echo" }))).toContain("echo: s")
    })

    it("serves stdio on a bare start(), as somamcp 1.x did", async () => {
      const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
      const server = makeServer({ stdioTransport: serverEnd })
      await server.start()
      running.push(server)
      const client = new LegacyClient({ name: "bare-start", version: "1.0.0" })
      await client.connect(clientEnd as unknown as Parameters<LegacyClient["connect"]>[0])
      expect(JSON.stringify(await client.callTool({ arguments: { text: "b" }, name: "echo" }))).toContain("echo: b")
    })

    it("hides canAccess-gated tools when stdio authentication fails", async () => {
      const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
      const server = createServer({
        authenticate: () => Promise.reject(new Error("no credentials on stdio")),
        backendOptions: { stdioTransport: serverEnd },
        logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn() },
        name: "stdio-auth",
        version: "1.0.0",
      })
      server.addTool({
        canAccess: (auth) => (auth as { role: string }).role === "admin",
        execute: () => Promise.resolve("secret"),
        name: "gated",
        parameters: z.object({}),
      })
      server.addTool({ execute: () => Promise.resolve("ok"), name: "open", parameters: z.object({}) })
      await server.start({ transportType: "stdio" })
      running.push(server)
      const client = new ModernClient({ name: "s", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } })
      await client.connect(clientEnd)
      const names = (await client.listTools()).tools.map((t) => t.name)
      expect(names).toContain("open")
      expect(names).not.toContain("gated")
    })

    it("serves an SDK 1.x client with the 2025 handshake", async () => {
      const client = new LegacyClient({ name: "stdio-legacy", version: "1.0.0" })
      await client.connect((await startStdio()) as unknown as Parameters<LegacyClient["connect"]>[0])
      expect(JSON.stringify(await client.callTool({ arguments: { text: "t" }, name: "echo" }))).toContain("echo: t")
    })
  })
})
