// An auth provider's wildcard routes and challenge follow the MCP endpoint that start() sets.
import { getRandomPort } from "get-port-please"
import { afterEach, describe, expect, it } from "vitest"

import { createServer } from "../../src/node/index.js"
import type { AuthChallenge, AuthProvider } from "../../src/types/auth.js"
import type { SomaServerInstance } from "../../src/types.js"

const running: SomaServerInstance[] = []
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.stop()))
})

const provider: AuthProvider = {
  authenticate: () => Promise.resolve(undefined),
  challenge: ({ endpoint }: AuthChallenge) => new Response(endpoint, { status: 401 }),
  routes: (endpoint) => [
    {
      handler: (c) => (c.req.path === `/.well-known/test${endpoint()}` ? c.text(endpoint()) : c.notFound()),
      method: "GET",
      path: "/.well-known/test/*",
    },
  ],
}

describe("auth provider on a port", () => {
  it("follows an endpoint start() moves", async () => {
    const port = await getRandomPort()
    const server = createServer({ auth: provider, enableDashboard: false, name: "node-auth", version: "1.0.0" })
    await server.start({ httpStream: { endpoint: "/rpc", host: "127.0.0.1", port }, transportType: "httpStream" })
    running.push(server)
    const base = `http://127.0.0.1:${port}`
    expect(await (await fetch(`${base}/.well-known/test/rpc`)).text()).toBe("/rpc")
    expect((await fetch(`${base}/.well-known/test/mcp`)).status).toBe(404)
    const rejected = await fetch(`${base}/rpc`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    })
    expect(rejected.status).toBe(401)
    expect(await rejected.text()).toBe("/rpc")
  })
})
