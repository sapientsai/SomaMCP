import { Hono } from "hono"
import { describe, expect, it } from "vitest"

import { registerArtifacts } from "../../src/artifacts/ArtifactManager.js"
import { createHealthArtifact, DEFAULT_HEALTH_PATH } from "../../src/artifacts/HealthArtifact.js"
import { createServer } from "../../src/Server.js"
import type { ServerHealth } from "../../src/types.js"

const stoppedHealth: ServerHealth = {
  activeSessions: 0,
  gateways: { connected: 0, total: 0 },
  name: "test",
  startedAt: 0,
  status: "stopped",
  uptime: 0,
}

const runningHealth: ServerHealth = {
  activeSessions: 2,
  gateways: { connected: 1, total: 2 },
  name: "test",
  startedAt: 1000,
  status: "running",
  uptime: 5000,
}

describe("HealthArtifact", () => {
  it("returns ServerHealth JSON at the default path with 200 when running", async () => {
    const app = new Hono()
    registerArtifacts(app, [createHealthArtifact(() => runningHealth)])

    const res = await app.request(DEFAULT_HEALTH_PATH)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(await res.json()).toEqual(runningHealth)
  })

  it("returns 503 when status is not running", async () => {
    const app = new Hono()
    registerArtifacts(app, [createHealthArtifact(() => stoppedHealth)])

    const res = await app.request(DEFAULT_HEALTH_PATH)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(stoppedHealth)
  })

  it("honors a custom path", async () => {
    const app = new Hono()
    registerArtifacts(app, [createHealthArtifact(() => runningHealth, "/healthz")])

    const res = await app.request("/healthz")
    expect(res.status).toBe(200)
    const notFound = await app.request(DEFAULT_HEALTH_PATH)
    expect(notFound.status).toBe(404)
  })
})

describe("Server health endpoint integration", () => {
  it("registers /health by default with live ServerHealth", async () => {
    const server = createServer({
      enableDashboard: false,
      enableIntrospection: false,
      name: "health-int",
      version: "1.0.0",
    })

    const res = await server.getApp().request("/health")
    expect(res.status).toBe(503)
    const body = (await res.json()) as ServerHealth
    expect(body.name).toBe("health-int")
    expect(body.status).toBe("stopped")
  })

  it("disables /health when enableHealthEndpoint is false", async () => {
    const server = createServer({
      enableDashboard: false,
      enableHealthEndpoint: false,
      enableIntrospection: false,
      name: "no-health",
      version: "1.0.0",
    })

    const res = await server.getApp().request("/health")
    expect(res.status).toBe(404)
  })

  it("honors a custom healthPath", async () => {
    const server = createServer({
      enableDashboard: false,
      enableIntrospection: false,
      healthPath: "/healthz",
      name: "custom-path",
      version: "1.0.0",
    })

    const res = await server.getApp().request("/healthz")
    expect(res.status).toBe(503)
  })
})
