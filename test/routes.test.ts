import { describe, expect, it } from "vitest"

import { createServer } from "../src/index.js"
import { MCP_URL, rawRequest } from "./backend/sdk-clients.js"

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

  it.each([
    ["resolves to undefined", () => Promise.resolve(undefined)],
    [
      "throws synchronously",
      () => {
        throw new Error("bad")
      },
    ],
  ] as const)("protected route returns 401 when authenticate %s", async (_label, authenticate) => {
    const server = createServer({ ...baseConfig, authenticate: authenticate as never })
    server.addRoute({ handler: (c) => c.text("secret"), method: "GET", path: "/secret", protected: true })
    expect((await server.getApp().request("/secret")).status).toBe(401)
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

  describe("when authenticate rejects with a Response", () => {
    // A header and a body, so a match proves it is this Response, not a 403 that happens to agree.
    const banned = () => new Response("go away", { headers: { "x-reason": "banned" }, status: 403 })
    const isBanned = async (res: Response) => {
      expect(res.status).toBe(403)
      expect(res.headers.get("x-reason")).toBe("banned")
      expect(await res.text()).toBe("go away")
    }

    it("serves it as-is, even when the route has onUnauthorized", async () => {
      const server = createServer({ ...baseConfig, authenticate: () => Promise.reject(banned()) })
      server.addRoute({
        handler: (c) => c.text("secret"),
        method: "POST",
        onUnauthorized: (c) => c.json({ error: "custom" }, 401),
        path: "/upload",
        protected: true,
      })
      await isBanned(await server.getApp().request("/upload", { method: "POST" }))
    })

    it("serves one thrown synchronously too", async () => {
      const authenticate = () => {
        throw banned()
      }
      const server = createServer({ ...baseConfig, authenticate: authenticate as never })
      server.addRoute({ handler: (c) => c.text("secret"), method: "GET", path: "/secret", protected: true })
      await isBanned(await server.getApp().request("/secret"))
    })

    it("uses onUnauthorized for any other rejection", async () => {
      const server = createServer({ ...baseConfig, authenticate: () => Promise.reject(new Error("bad token")) })
      server.addRoute({
        handler: (c) => c.text("secret"),
        method: "GET",
        onUnauthorized: (c) => c.json({ error: "custom" }, 401),
        path: "/secret",
        protected: true,
      })
      const res = await server.getApp().request("/secret")
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: "custom" })
    })

    it("gets the same answer from /mcp, /health/detail and a protected route", async () => {
      const server = createServer({ ...baseConfig, authenticate: () => Promise.reject(banned()) })
      server.addRoute({ handler: (c) => c.text("secret"), method: "GET", path: "/secret", protected: true })
      await isBanned(await server.fetch(rawRequest("tools/list")))
      await isBanned(await server.fetch(new Request(new URL("/health/detail", MCP_URL))))
      await isBanned(await server.fetch(new Request(new URL("/secret", MCP_URL))))
    })
  })
})
