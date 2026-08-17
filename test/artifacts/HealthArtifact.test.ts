import { Hono } from "hono"
import { describe, expect, it } from "vitest"

import { registerArtifacts } from "../../src/artifacts/ArtifactManager.js"
import {
  createHealthArtifact,
  createHealthDetailArtifact,
  DEFAULT_HEALTH_DETAIL_PATH,
  DEFAULT_HEALTH_PATH,
} from "../../src/artifacts/HealthArtifact.js"
import { createServer } from "../../src/index.js"
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

describe("HealthArtifact (public)", () => {
  it("returns minimal {name, status} JSON with 200 when running", async () => {
    const app = new Hono()
    registerArtifacts(app, [createHealthArtifact(() => runningHealth)])

    const res = await app.request(DEFAULT_HEALTH_PATH)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    const body = await res.json()
    expect(body).toEqual({ name: "test", status: "running" })
    // Does NOT leak sessions or gateways
    expect(body).not.toHaveProperty("activeSessions")
    expect(body).not.toHaveProperty("gateways")
  })

  it("returns 503 when status is not running", async () => {
    const app = new Hono()
    registerArtifacts(app, [createHealthArtifact(() => stoppedHealth)])

    const res = await app.request(DEFAULT_HEALTH_PATH)
    expect(res.status).toBe(503)
  })
})

describe("HealthDetailArtifact (protected)", () => {
  it("requires auth and returns 401 when no authenticate function", async () => {
    const app = new Hono()
    registerArtifacts(app, [createHealthDetailArtifact(() => runningHealth)])

    const res = await app.request(DEFAULT_HEALTH_DETAIL_PATH)
    expect(res.status).toBe(401)
  })

  it("returns full ServerHealth when authenticated", async () => {
    const app = new Hono()
    const authenticate = async () => ({ user: "admin" })
    registerArtifacts(app, [createHealthDetailArtifact(() => runningHealth)], authenticate)

    const res = await app.request(DEFAULT_HEALTH_DETAIL_PATH)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(runningHealth)
  })

  it("returns 401 when authenticate throws", async () => {
    const app = new Hono()
    const authenticate = async () => {
      throw new Error("nope")
    }
    registerArtifacts(app, [createHealthDetailArtifact(() => runningHealth)], authenticate)

    const res = await app.request(DEFAULT_HEALTH_DETAIL_PATH)
    expect(res.status).toBe(401)
  })
})

describe("Server health endpoint integration", () => {
  it("registers public /health and protected /health/detail by default", async () => {
    const server = createServer({
      enableDashboard: false,
      enableInfoEndpoint: false,
      enableIntrospection: false,
      name: "health-int",
      version: "1.0.0",
    })

    const pub = await server.getApp().request("/health")
    expect(pub.status).toBe(503)
    const pubBody = (await pub.json()) as { name: string; status: string }
    expect(pubBody.name).toBe("health-int")
    expect(pubBody.status).toBe("stopped")
    expect(pubBody).not.toHaveProperty("activeSessions")

    const detail = await server.getApp().request("/health/detail")
    expect(detail.status).toBe(401)
  })

  it("/health/detail returns full ServerHealth when authenticated", async () => {
    const server = createServer({
      authenticate: async () => ({ user: "ops" }),
      enableDashboard: false,
      enableInfoEndpoint: false,
      enableIntrospection: false,
      name: "auth-int",
      version: "1.0.0",
    })

    const res = await server.getApp().request("/health/detail")
    expect(res.status).toBe(503)
    const body = (await res.json()) as ServerHealth
    expect(body.activeSessions).toBe(0)
    expect(body.gateways).toEqual({ connected: 0, total: 0 })
  })

  it("disables /health when enableHealthEndpoint is false", async () => {
    const server = createServer({
      enableDashboard: false,
      enableHealthEndpoint: false,
      enableInfoEndpoint: false,
      enableIntrospection: false,
      name: "no-health",
      version: "1.0.0",
    })

    const res = await server.getApp().request("/health")
    expect(res.status).toBe(404)
  })
})
