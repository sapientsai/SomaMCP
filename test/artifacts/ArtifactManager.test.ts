import { Hono } from "hono"
import { describe, expect, it } from "vitest"

import { registerArtifacts } from "../../src/artifacts/ArtifactManager.js"
import type { ArtifactConfig } from "../../src/artifacts/types.js"

describe("ArtifactManager", () => {
  it("registers a static artifact", async () => {
    const app = new Hono()
    const artifact: ArtifactConfig = {
      content: "<h1>Hello</h1>",
      contentType: "text/html",
      path: "/hello",
      type: "static",
    }

    registerArtifacts(app, [artifact])

    const res = await app.request("/hello")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("<h1>Hello</h1>")
    expect(res.headers.get("content-type")).toContain("text/html")
  })

  it("registers a dynamic artifact", async () => {
    const app = new Hono()
    const artifact: ArtifactConfig = {
      handler: () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        }),
      path: "/api/status",
      type: "dynamic",
    }

    registerArtifacts(app, [artifact])

    const res = await app.request("/api/status")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
  })

  it("protected artifact returns 401 without authenticate", async () => {
    const app = new Hono()
    const artifact: ArtifactConfig = {
      content: "secret",
      contentType: "text/plain",
      path: "/secret",
      protected: true,
      type: "static",
    }

    registerArtifacts(app, [artifact])

    const res = await app.request("/secret")
    expect(res.status).toBe(401)
  })

  it("protected artifact passes when authenticate resolves", async () => {
    const app = new Hono()
    const artifact: ArtifactConfig = {
      content: "secret",
      contentType: "text/plain",
      path: "/secret",
      protected: true,
      type: "static",
    }

    registerArtifacts(app, [artifact], async () => ({ user: "alice" }))

    const res = await app.request("/secret")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("secret")
  })

  it("protected artifact returns 401 when authenticate rejects", async () => {
    const app = new Hono()
    const artifact: ArtifactConfig = {
      content: "secret",
      contentType: "text/plain",
      path: "/secret",
      protected: true,
      type: "static",
    }

    registerArtifacts(app, [artifact], async () => {
      throw new Error("bad token")
    })

    const res = await app.request("/secret")
    expect(res.status).toBe(401)
  })

  it("unprotected artifact ignores authenticate function", async () => {
    const app = new Hono()
    const artifact: ArtifactConfig = {
      content: "public",
      contentType: "text/plain",
      path: "/public",
      type: "static",
    }

    registerArtifacts(app, [artifact], async () => {
      throw new Error("would reject")
    })

    const res = await app.request("/public")
    expect(res.status).toBe(200)
  })

  it("registers multiple artifacts", async () => {
    const app = new Hono()
    const artifacts: ArtifactConfig[] = [
      {
        content: "page1",
        contentType: "text/plain",
        path: "/page1",
        type: "static",
      },
      {
        content: "page2",
        contentType: "text/plain",
        path: "/page2",
        type: "static",
      },
    ]

    registerArtifacts(app, artifacts)

    const res1 = await app.request("/page1")
    expect(await res1.text()).toBe("page1")

    const res2 = await app.request("/page2")
    expect(await res2.text()).toBe("page2")
  })
})
