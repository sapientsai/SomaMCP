// Over HTTP, a server advertises a capability only when something of that kind is registered, so
// a client doesn't spend a request per session listing prompts or resources the server never has.
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { createServer } from "../../src/index.js"
import { ERAS, rawRequest } from "./sdk-clients.js"

const toolsOnly = () => {
  const server = createServer({ enableDashboard: false, name: "caps", version: "1.0.0" })
  server.addTool({ execute: () => Promise.resolve("ok"), name: "echo", parameters: z.object({}) })
  return server
}

const withPrompt = () => {
  const server = toolsOnly()
  server.addPrompt({ load: () => Promise.resolve("hi"), name: "greet" })
  return server
}

const withResource = () => {
  const server = toolsOnly()
  server.addResource({ load: () => Promise.resolve({ text: "x" }), name: "memo", uri: "memo://a" })
  return server
}

const withTemplate = () => {
  const server = toolsOnly()
  server.addResourceTemplate({
    arguments: [{ name: "id" }],
    load: (args) => Promise.resolve({ text: String(args.id) }),
    name: "note",
    uriTemplate: "note://{id}",
  })
  return server
}

describe.each(ERAS)("capabilities a %s client sees", (_era, connect) => {
  it("are tools and logging alone on a server with only tools", async () => {
    const client = await connect(toolsOnly())
    expect(Object.keys(client.getServerCapabilities() ?? {}).sort()).toEqual(["logging", "tools"])
    await client.close()
  })

  it("include prompts and completions once a prompt is registered", async () => {
    const client = await connect(withPrompt())
    expect(client.getServerCapabilities()).toMatchObject({ completions: {}, prompts: {} })
    expect(client.getServerCapabilities()).not.toHaveProperty("resources")
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["greet"])
    await client.close()
  })

  it("include resources, and not completions, for a plain resource", async () => {
    const client = await connect(withResource())
    expect(client.getServerCapabilities()).toHaveProperty("resources")
    expect(client.getServerCapabilities()).not.toHaveProperty("completions")
    expect(client.getServerCapabilities()).not.toHaveProperty("prompts")
    await client.close()
  })

  it("include resources and completions for a resource template", async () => {
    const client = await connect(withTemplate())
    expect(client.getServerCapabilities()).toMatchObject({ completions: {}, resources: {} })
    await client.close()
  })
})

describe("methods for a capability the server doesn't advertise", () => {
  it.each(["prompts/list", "resources/list", "resources/templates/list"])(
    "answer %s with method not found",
    async (method) => {
      const res = await toolsOnly().fetch(rawRequest(method, {}, { modern: true }))
      expect(await res.text()).toContain("-32601")
    },
  )

  it("pick up a prompt registered after an earlier request", async () => {
    const server = toolsOnly()
    expect(await (await server.fetch(rawRequest("prompts/list", {}, { modern: true }))).text()).toContain("-32601")
    server.addPrompt({ load: () => Promise.resolve("hi"), name: "late" })
    expect(await (await server.fetch(rawRequest("prompts/list", {}, { modern: true }))).text()).toContain('"late"')
  })
})
