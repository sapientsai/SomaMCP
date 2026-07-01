import { describe, expect, it } from "vitest"

import { createServer } from "../src/Server.js"

const baseConfig = {
  enableDashboard: false,
  enableIntrospection: false,
  name: "route-server",
  version: "1.0.0",
} as const

describe("addRoute", () => {
  it("registers an unprotected GET route", async () => {
    const server = createServer({ ...baseConfig })
    server.addRoute({
      handler: (c) => c.json({ ok: true }),
      method: "GET",
      path: "/hello",
    })

    const res = await server.getApp().request("/hello")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("registers a route with an array of methods", async () => {
    const server = createServer({ ...baseConfig })
    server.addRoute({
      handler: (c) => c.text(`hit ${c.req.method}`),
      method: ["POST", "PUT"],
      path: "/upload",
    })

    const app = server.getApp()
    const post = await app.request("/upload", { method: "POST" })
    expect(post.status).toBe(200)
    expect(await post.text()).toBe("hit POST")

    const put = await app.request("/upload", { method: "PUT" })
    expect(put.status).toBe(200)
    expect(await put.text()).toBe("hit PUT")

    const get = await app.request("/upload", { method: "GET" })
    expect(get.status).toBe(404)
  })

  it("protected route returns 401 without server-level authenticate", async () => {
    const server = createServer({ ...baseConfig })
    server.addRoute({
      handler: (c) => c.text("secret"),
      method: "POST",
      path: "/upload",
      protected: true,
    })

    const res = await server.getApp().request("/upload", { method: "POST" })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "Unauthorized" })
  })

  it("protected route reaches the handler when authenticate resolves", async () => {
    const server = createServer({
      ...baseConfig,
      authenticate: async () => ({ user: "alice" }),
    })
    server.addRoute({
      handler: (c) => c.text("ok"),
      method: "POST",
      path: "/upload",
      protected: true,
    })

    const res = await server.getApp().request("/upload", { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
  })

  it("protected route returns 401 when authenticate throws", async () => {
    const server = createServer({
      ...baseConfig,
      authenticate: async () => {
        throw new Error("bad token")
      },
    })
    server.addRoute({
      handler: (c) => c.text("secret"),
      method: "POST",
      path: "/upload",
      protected: true,
    })

    const res = await server.getApp().request("/upload", { method: "POST" })
    expect(res.status).toBe(401)
  })

  it("honors onUnauthorized to customize the 401 shape", async () => {
    const server = createServer({ ...baseConfig })
    server.addRoute({
      handler: (c) => c.text("secret"),
      method: "POST",
      onUnauthorized: (c) =>
        c.json({ error: "missing_token", hint: "provide bearer" }, 403, { "WWW-Authenticate": "Bearer" }),
      path: "/upload",
      protected: true,
    })

    const res = await server.getApp().request("/upload", { method: "POST" })
    expect(res.status).toBe(403)
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer")
    expect(await res.json()).toEqual({ error: "missing_token", hint: "provide bearer" })
  })

  it("unprotected route ignores authenticate", async () => {
    const server = createServer({
      ...baseConfig,
      authenticate: async () => {
        throw new Error("would reject")
      },
    })
    server.addRoute({
      handler: (c) => c.text("public"),
      method: "GET",
      path: "/public",
    })

    const res = await server.getApp().request("/public")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("public")
  })
})
