// The package's entry points: what the main entry's start() can do, and that
// somamcp/node and somamcp/edge share the main entry's values rather than copies.
import { describe, expect, it } from "vitest"

import * as edge from "../src/edge.js"
import * as main from "../src/index.js"
import * as node from "../src/node/index.js"

describe("main entry (WinterTC)", () => {
  it("starts without a transport, listening on nothing", async () => {
    const server = main.createServer({ name: "w", version: "1.0.0" })
    await server.start()
    expect(server.serverState).toBe("running")
    expect((await server.fetch(new Request("http://w/health"))).status).toBe(200)
    await server.stop()
  })

  it.each([
    [{ transportType: "stdio" }, "stdio"],
    [{ httpStream: { port: 1 }, transportType: "httpStream" }, "httpStream"],
  ] as const)("rejects start() with a %s transport, pointing at somamcp/node", async (transport, name) => {
    const server = main.createServer({ name: "w", version: "1.0.0" })
    await expect(server.start(transport)).rejects.toThrow(`start({ transportType: "${name}" }) needs Node`)
    await expect(server.start(transport)).rejects.toThrow("somamcp/node")
  })
})

describe("somamcp/node", () => {
  it("re-exports the main entry's values, not copies", () => {
    expect(node.UserError).toBe(main.UserError)
    expect(node.createSdkBackend).toBe(main.createSdkBackend)
    expect(node.getRequestHeader).toBe(main.getRequestHeader)
  })

  it("replaces createServer and the content helpers with Node versions", () => {
    expect(node.createServer).not.toBe(main.createServer)
    expect(node.imageContent).not.toBe(main.imageContent)
    expect(typeof node.createNodeBackend).toBe("function")
    expect(typeof node.createJsonFileTelemetry).toBe("function")
  })
})

describe("somamcp/edge", () => {
  it("is an alias of the main entry", () => {
    expect(Object.keys(edge).sort()).toEqual(Object.keys(main).sort())
    expect(edge.createServer).toBe(main.createServer)
  })

  it("no longer exports the FastMCP edge backend", () => {
    expect("createEdgeBackend" in edge).toBe(false)
    expect("createFastMCPBackend" in main).toBe(false)
  })
})
