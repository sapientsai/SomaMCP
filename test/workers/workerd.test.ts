// The main entry inside workerd, Cloudflare's Workers runtime, with no
// nodejs_compat flag: a Node API or global anywhere on the request path fails here
// at load or at call time, which the Node test suite cannot see.
//
// @cloudflare/vitest-pool-workers would run tests inside workerd, but it supports
// vitest 4 only, so this bundles a Worker and drives it from Node through Miniflare.
import { fileURLToPath } from "node:url"

import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  connectLegacy,
  connectModern,
  type Fetchable,
  MCP_URL,
  rawRequest,
  withHeader,
} from "../backend/sdk-clients.js"

const SRC = fileURLToPath(new URL("../../src", import.meta.url))
const ENTRY = fileURLToPath(new URL("./worker.ts", import.meta.url))

type CallResult = {
  content: Array<{ data?: string; mimeType?: string; text?: string; type: string }>
  isError?: boolean
}

const bundleWorker = async (): Promise<string> => {
  const result = await build({
    alias: { "@": SRC },
    bundle: true,
    // What wrangler resolves for a Worker: the SDK's _shims export picks its workerd stub.
    conditions: ["workerd", "worker", "browser"],
    entryPoints: [ENTRY],
    format: "esm",
    logLevel: "silent",
    mainFields: ["module", "main"],
    // "neutral" knows no Node built-ins, so importing one fails the build outright.
    platform: "neutral",
    target: "es2022",
    write: false,
  })
  return result.outputFiles[0]?.text ?? ""
}

let script = ""
let mf: Miniflare

/** Route a client's requests into the Worker; Miniflare's Response becomes a global one. */
const worker: Fetchable = {
  fetch: async (request) => {
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
    const response = await mf.dispatchFetch(request.url, {
      body,
      headers: Object.fromEntries(request.headers),
      method: request.method,
    })
    return new Response(response.body as ReadableStream | null, {
      headers: Object.fromEntries(response.headers),
      status: response.status,
    })
  },
}
const authed = withHeader(worker, "x-api-key", "k")

beforeAll(async () => {
  script = await bundleWorker()
  mf = new Miniflare({ compatibilityDate: "2026-07-01", compatibilityFlags: [], modules: true, script })
  await mf.ready
}, 120_000)

afterAll(async () => {
  await mf?.dispose()
})

describe("main entry in workerd (no nodejs_compat)", () => {
  it("bundles with no Node built-ins", () => {
    expect(script.length).toBeGreaterThan(0)
    expect(script).not.toMatch(/from\s*["']node:/)
  })

  it("serves /health", async () => {
    const res = await worker.fetch(new Request("http://w/health"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: "worker", status: "running" })
  })

  it("rejects MCP calls without the key", async () => {
    expect((await worker.fetch(rawRequest("server/discover", {}, { modern: true }))).status).toBe(401)
  })

  it.each(["server/discover", "tools/list"])("answers a raw enveloped 2026-07-28 %s with 200", async (method) => {
    expect((await authed.fetch(rawRequest(method, {}, { modern: true }))).status).toBe(200)
  })

  it.each(["2025-11-25", "2025-06-18", "2025-03-26"])(
    "answers a raw %s initialize with 200",
    async (protocolVersion) => {
      const res = await authed.fetch(
        rawRequest("initialize", { capabilities: {}, clientInfo: { name: "raw", version: "1" }, protocolVersion }),
      )
      expect(res.status).toBe(200)
    },
  )

  describe("2026-07-28 client", () => {
    it("lists and calls tools, with the session from authenticate", async () => {
      const client = await connectModern(authed, MCP_URL)
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["echo", "pixel", "fail", "whoami", "info"]),
      )
      const echo = (await client.callTool({ arguments: { text: "hi" }, name: "echo" })) as CallResult
      expect(echo.content[0]?.text).toBe("echo: hi")
      const whoami = (await client.callTool({ arguments: {}, name: "whoami" })) as CallResult
      expect(whoami.content[0]?.text).toBe("user: u")
    })

    it("encodes image content without Buffer", async () => {
      const client = await connectModern(authed, MCP_URL)
      const pixel = (await client.callTool({ arguments: {}, name: "pixel" })) as CallResult
      expect(pixel.content[1]).toEqual({ data: "AQID", mimeType: "image/png", type: "image" })
    })

    it("turns a UserError into an isError result", async () => {
      const client = await connectModern(authed, MCP_URL)
      const fail = (await client.callTool({ arguments: {}, name: "fail" })) as CallResult
      expect(fail.isError).toBe(true)
      expect(JSON.stringify(fail.content)).toContain("nope")
    })

    it("reads a resource", async () => {
      const client = await connectModern(authed, MCP_URL)
      const read = await client.readResource({ uri: "memo://a" })
      expect(read.contents[0]).toMatchObject({ text: "hello from workerd", uri: "memo://a" })
    })

    it("reports the edge runtime from the info tool", async () => {
      const client = await connectModern(authed, MCP_URL)
      const info = (await client.callTool({ arguments: {}, name: "info" })) as CallResult
      expect(JSON.parse(info.content[0]?.text ?? "{}")).toMatchObject({ runtime: { runtime: "edge" } })
    })
  })

  describe("2025 client", () => {
    it("lists and calls tools", async () => {
      const client = await connectLegacy(authed, MCP_URL)
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("echo")
      const echo = (await client.callTool({ arguments: { text: "old" }, name: "echo" })) as CallResult
      expect(echo.content[0]?.text).toBe("echo: old")
    })
  })
})
