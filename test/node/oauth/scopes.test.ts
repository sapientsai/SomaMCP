import { describe, expect, it } from "vitest"

import { narrowScope, splitScope } from "../../../src/node/oauth/scopes.js"
import { usableAs } from "../../../src/node/oauth/jwt.js"

describe("narrowScope", () => {
  const allowed = ["openid", "offline_access", "User.Read", "Mail.Read", "Mail.Send"]

  it("keeps what the client asked for that is on the list, in the list's order, plus openid and offline_access", () => {
    expect(narrowScope(["Mail.Send", "User.Read"], allowed).orUndefined()).toEqual([
      "openid",
      "offline_access",
      "User.Read",
      "Mail.Send",
    ])
  })

  it("drops what is not on the list", () => {
    expect(narrowScope(["Mail.Read", "Files.ReadWrite.All", "Sites.FullControl.All"], allowed).orUndefined()).toEqual([
      "openid",
      "offline_access",
      "Mail.Read",
    ])
  })

  it("is none when nothing asked for is on the list, or the list is empty", () => {
    expect(narrowScope(["Files.ReadWrite.All"], allowed).isNone()).toBe(true)
    expect(narrowScope([], allowed).isNone()).toBe(true)
    expect(narrowScope(["User.Read"], []).isNone()).toBe(true)
  })

  it("adds openid and offline_access only when the list has them", () => {
    expect(narrowScope(["User.Read"], ["User.Read", "Mail.Read"]).orUndefined()).toEqual(["User.Read"])
  })

  it("splits a scope parameter on spaces, without empty parts", () => {
    expect(splitScope("  openid  User.Read ")).toEqual(["openid", "User.Read"])
  })
})

describe("usableAs", () => {
  const claims = (token_use?: unknown) => ({
    aud: "a",
    client_id: "c",
    exp: 1,
    iat: 0,
    iss: "a",
    jti: "j",
    scope: [],
    ...(token_use === undefined ? {} : { token_use }),
  })

  it("lets a typed token be used only as its own type", () => {
    expect(usableAs("access")(claims("access"))).toBe(true)
    expect(usableAs("refresh")(claims("access"))).toBe(false)
    expect(usableAs("refresh")(claims("refresh"))).toBe(true)
    expect(usableAs("access")(claims("refresh"))).toBe(false)
  })

  it("lets an untyped token (fastmcp's) be used as either, and an unknown type as neither", () => {
    expect([usableAs("access")(claims()), usableAs("refresh")(claims())]).toEqual([true, true])
    expect([usableAs("access")(claims("id")), usableAs("refresh")(claims("id"))]).toEqual([false, false])
  })
})
