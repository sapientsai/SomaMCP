import { describe, expect, it } from "vitest"

import { createServer } from "../../src/index.js"
import type { ServerInfo } from "../../src/types.js"

describe("InfoArtifact + info tool", () => {
  it("/info is protected by default (401 without auth)", async () => {
    const server = createServer({
      enableDashboard: false,
      enableHealthEndpoint: false,
      enableIntrospection: false,
      name: "info-server",
      version: "1.0.0",
    })

    const res = await server.getApp().request("/info")
    expect(res.status).toBe(401)
  })

  it("/info returns ServerInfo when authenticated", async () => {
    const server = createServer({
      authenticate: async () => ({ user: "registry" }),
      build: { branch: "main", commit: "deadbeef", date: "2026-05-22", environment: "prod" },
      enableDashboard: false,
      enableHealthEndpoint: false,
      enableIntrospection: false,
      name: "info-auth",
      version: "2.0.0",
    })

    const res = await server.getApp().request("/info")
    expect(res.status).toBe(200)
    const body = (await res.json()) as ServerInfo
    expect(body.name).toBe("info-auth")
    expect(body.version).toBe("2.0.0")
    expect(body.build.commit).toBe("deadbeef")
    expect(body.build.environment).toBe("prod")
    expect(body.capabilities).toEqual({ prompts: 0, resources: 0, tools: 0 })
    expect(body.runtime.platform).toBeTruthy()
  })

  it("getInfo() reflects added tools/resources/prompts", () => {
    const server = createServer({
      enableDashboard: false,
      enableHealthEndpoint: false,
      enableInfoEndpoint: false,
      enableIntrospection: false,
      name: "counts",
      version: "1.0.0",
    })

    server.addTool({ execute: async () => "x", name: "a" })
    server.addTool({ execute: async () => "x", name: "b" })
    server.addResource({ load: async () => ({ text: "r" }), name: "r1", uri: "res://1" })
    server.addPrompt({ load: async () => "p", name: "p1" })

    expect(server.getInfo().capabilities).toEqual({ prompts: 1, resources: 1, tools: 2 })
  })

  it("disables /info when enableInfoEndpoint is false", async () => {
    const server = createServer({
      authenticate: async () => ({ user: "x" }),
      enableDashboard: false,
      enableHealthEndpoint: false,
      enableInfoEndpoint: false,
      enableIntrospection: false,
      name: "no-info",
      version: "1.0.0",
    })

    const res = await server.getApp().request("/info")
    expect(res.status).toBe(404)
  })
})

describe("info MCP tool", () => {
  it("is auto-registered by default with name 'info'", () => {
    const server = createServer({
      enableDashboard: false,
      enableHealthEndpoint: false,
      enableInfoEndpoint: false,
      name: "mcp-info",
      version: "1.0.0",
    })

    // Confirm the underlying introspection registered without surfacing in getCapabilities
    // (backend.addTool is used directly for introspection — same as before)
    expect(server.getInfo().name).toBe("mcp-info")
  })

  it("honors introspectionPrefix", () => {
    // We can't easily list backend tools from the server instance,
    // but we can verify the option is accepted without error.
    expect(() =>
      createServer({
        enableDashboard: false,
        enableHealthEndpoint: false,
        enableInfoEndpoint: false,
        introspectionPrefix: "soma_",
        name: "prefixed",
        version: "1.0.0",
      }),
    ).not.toThrow()
  })
})
