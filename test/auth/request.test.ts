import { describe, expect, it } from "vitest"

import { getRequestHeader } from "../../src/auth/index.js"

describe("getRequestHeader", () => {
  it("returns the header from a Hono/Fetch Request (Headers.get)", () => {
    const req = new Request("http://x", { headers: { Authorization: "Bearer abc" } })
    expect(getRequestHeader(req, "authorization")).toBe("Bearer abc")
    expect(getRequestHeader(req, "Authorization")).toBe("Bearer abc") // case-insensitive
  })

  it("returns the header from an http.IncomingMessage-shaped object (lowercased keys)", () => {
    const req = { headers: { authorization: "Bearer xyz" } }
    expect(getRequestHeader(req, "authorization")).toBe("Bearer xyz")
    expect(getRequestHeader(req, "Authorization")).toBe("Bearer xyz")
  })

  it("returns the header when the object has original-case keys", () => {
    const req = { headers: { Authorization: "Bearer literal" } }
    expect(getRequestHeader(req, "Authorization")).toBe("Bearer literal")
  })

  it("returns the first entry when the header is an array", () => {
    const req = { headers: { "x-forwarded-for": ["1.1.1.1", "2.2.2.2"] } }
    expect(getRequestHeader(req, "x-forwarded-for")).toBe("1.1.1.1")
  })

  it("returns undefined for a missing header", () => {
    const req = new Request("http://x")
    expect(getRequestHeader(req, "authorization")).toBeUndefined()
    expect(getRequestHeader({ headers: {} }, "authorization")).toBeUndefined()
  })

  it("returns undefined for null / non-request inputs", () => {
    expect(getRequestHeader(null, "authorization")).toBeUndefined()
    expect(getRequestHeader(undefined, "authorization")).toBeUndefined()
    expect(getRequestHeader({}, "authorization")).toBeUndefined()
    expect(getRequestHeader("nope", "authorization")).toBeUndefined()
  })
})
