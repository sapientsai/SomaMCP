// Gateways live behind `somamcp/gateway`, so a server without them never bundles the MCP client.
import { describe, expect, it } from "vitest"

import { createGatewayManager } from "../../src/gateway/index.js"
import { createServer } from "../../src/index.js"
import { createServer as createNodeServer } from "../../src/node/index.js"

const remote = { id: "remote", url: "http://localhost:9999/mcp" }

describe("gateways on the main entry", () => {
  it("need the manager from somamcp/gateway, and say so when the server is created", () => {
    expect(() => createServer({ gateways: [remote], name: "s", version: "1.0.0" })).toThrow(
      /gateways need `gatewayManager: createGatewayManager` from "somamcp\/gateway"/,
    )
  })

  it("work with it", () => {
    const server = createServer({
      gatewayManager: createGatewayManager,
      gateways: [remote],
      name: "s",
      version: "1.0.0",
    })
    expect(server.getHealth().gateways).toEqual({ connected: 0, total: 1 })
  })

  it("are not needed for a server without them", () => {
    const server = createServer({ name: "s", version: "1.0.0" })
    expect(server.getHealth().gateways).toEqual({ connected: 0, total: 0 })
    expect(server.getGatewayManager().getAll()).toEqual([])
  })

  it("count an empty list as none", () => {
    expect(() => createServer({ gateways: [], name: "s", version: "1.0.0" })).not.toThrow()
  })
})

describe("gateways on somamcp/node", () => {
  it("work without the import, as before", () => {
    const server = createNodeServer({ gateways: [remote], name: "s", version: "1.0.0" })
    expect(server.getHealth().gateways).toEqual({ connected: 0, total: 1 })
  })
})
