// `instructions` as a function of the session: per caller, in both protocol eras, over fetch.
import { Option } from "functype"
import { describe, expect, it, vi } from "vitest"

import { createServer, getRequestHeader } from "../../src/index.js"
import { connectLegacy, connectModern, ERAS, type Fetchable, rawRequest, withHeader } from "./sdk-clients.js"

type Viewer = { user: string }

const authenticate = (request: Request | undefined): Promise<Viewer> =>
  Option(getRequestHeader(request, "x-user")).fold(
    () => Promise.reject(new Error("no user")),
    (user) => Promise.resolve({ user }),
  )

const serverWith = (instructions: Parameters<typeof createServer<Viewer>>[0]["instructions"], auth = true) =>
  createServer<Viewer>({
    ...(auth ? { authenticate } : {}),
    enableDashboard: false,
    instructions,
    name: "instructions",
    version: "1.0.0",
  })

const as = (server: Fetchable, user: string): Fetchable => withHeader(server, "x-user", user)

describe("instructions", () => {
  describe.each(ERAS)("%s client", (_era, connect) => {
    it("keeps a plain string as it was", async () => {
      const client = await connect(as(serverWith("Be brief."), "ana"))
      expect(client.getInstructions()).toBe("Be brief.")
      await client.close()
    })

    it("gives each session its own instructions, sync or async", async () => {
      for (const instructions of [
        (viewer: Viewer | undefined) => `Rules for ${viewer?.user}.`,
        (viewer: Viewer | undefined) => Promise.resolve(`Rules for ${viewer?.user}.`),
      ]) {
        const server = serverWith(instructions)
        const ana = await connect(as(server, "ana"))
        const ben = await connect(as(server, "ben"))
        expect(ana.getInstructions()).toBe("Rules for ana.")
        expect(ben.getInstructions()).toBe("Rules for ben.")
        await Promise.all([ana.close(), ben.close()])
      }
    })

    it("gives the function undefined when the server has no authenticate", async () => {
      const instructions = vi.fn((viewer: Viewer | undefined) => `viewer: ${String(viewer)}`)
      const client = await connect(serverWith(instructions, false))
      expect(client.getInstructions()).toBe("viewer: undefined")
      expect(instructions).toHaveBeenCalledWith(undefined)
      await client.close()
    })

    it("fails the connection, rather than serving no instructions, when the function throws or rejects", async () => {
      for (const instructions of [
        () => {
          throw new Error("conventions unavailable")
        },
        () => Promise.reject(new Error("conventions unavailable")),
      ]) {
        await expect(connect(as(serverWith(instructions), "ana"))).rejects.toThrow()
      }
    })

    it("serves an empty string as no instructions", async () => {
      const client = await connect(
        as(
          serverWith(() => ""),
          "ana",
        ),
      )
      expect(client.getInstructions()).toBeUndefined()
      await client.close()
    })
  })

  describe("2026-07-28 clients", () => {
    it("are asked for instructions only on server/discover, so a tool call never runs the function", async () => {
      const instructions = vi.fn((viewer: Viewer | undefined) => `Rules for ${viewer?.user}.`)
      const server = as(serverWith(instructions), "ana")
      const client = await connectModern(server)
      const afterConnect = instructions.mock.calls.length
      await client.listTools()
      await client.listTools()
      expect(afterConnect).toBeGreaterThan(0)
      expect(instructions.mock.calls.length).toBe(afterConnect)
      await client.close()
    })

    it("still answer a tool call when the function would fail", async () => {
      const server = as(
        serverWith(() => Promise.reject(new Error("conventions unavailable"))),
        "ana",
      )
      const res = await server.fetch(rawRequest("tools/list", {}, { modern: true }))
      expect(res.status).toBe(200)
    })

    it("answer server/discover with a 500 when the function fails", async () => {
      const server = as(
        serverWith(() => Promise.reject(new Error("conventions unavailable"))),
        "ana",
      )
      const res = await server.fetch(rawRequest("server/discover", {}, { modern: true }))
      expect(res.status).toBe(500)
    })
  })

  describe("2025 clients", () => {
    it("run the function on every request, because the method is only in the body", async () => {
      const instructions = vi.fn((viewer: Viewer | undefined) => `Rules for ${viewer?.user}.`)
      const client = await connectLegacy(as(serverWith(instructions), "ana"))
      const afterConnect = instructions.mock.calls.length
      await client.listTools()
      expect(instructions.mock.calls.length).toBe(afterConnect + 1)
      await client.close()
    })
  })
})
