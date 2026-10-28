import { describe, expect, it } from "vitest"

import { requireAuth, requireScopes, type Tool } from "../../src/index.js"

type Session = { accessToken: string; scopes: ReadonlyArray<string> }

describe("requireAuth", () => {
  it("lets any session through, and nothing else", () => {
    expect(requireAuth({})).toBe(true)
    expect(requireAuth(undefined)).toBe(false)
    expect(requireAuth(null as never)).toBe(false)
  })
})

describe("requireScopes", () => {
  const mail = requireScopes("Mail.Read", "Mail.Send")

  it("needs every scope it names", () => {
    expect(mail({ scopes: ["User.Read", "Mail.Read", "Mail.Send"] })).toBe(true)
    expect(mail({ scopes: ["Mail.Read"] })).toBe(false)
  })

  it("reads scopes from an array or a Set, as FastMCP's did", () => {
    expect(mail({ scopes: new Set(["Mail.Read", "Mail.Send"]) })).toBe(true)
  })

  it("refuses a session with no scopes, scopes of another shape, or no session", () => {
    expect(mail({})).toBe(false)
    expect(mail({ scopes: "Mail.Read Mail.Send" })).toBe(false)
    expect(mail(undefined)).toBe(false)
  })

  it("with no scopes named, needs a session with a scopes field, as FastMCP's did", () => {
    expect(requireScopes()({ scopes: [] })).toBe(true)
    expect(requireScopes()({})).toBe(false)
    expect(requireScopes()(undefined)).toBe(false)
  })

  it("fits a typed tool's canAccess", () => {
    const tool: Pick<Tool<Session>, "canAccess"> = { canAccess: requireScopes("Mail.Send") }
    expect(tool.canAccess?.({ accessToken: "t", scopes: ["Mail.Send"] })).toBe(true)
    const any: Pick<Tool<Session>, "canAccess"> = { canAccess: requireAuth }
    expect(any.canAccess?.({ accessToken: "t", scopes: [] })).toBe(true)
  })
})
