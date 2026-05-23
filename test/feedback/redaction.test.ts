import { describe, expect, it } from "vitest"

import { redact } from "../../src/feedback/redaction.js"

describe("redact", () => {
  it("returns input unchanged when nothing matches", () => {
    const result = redact("Hello world, this is fine.")
    expect(result.redacted).toBe(false)
    expect(result.text).toBe("Hello world, this is fine.")
    expect(result.matches).toEqual([])
  })

  it("redacts GitHub PATs", () => {
    const fakeToken = `ghp_${"x".repeat(36)}`
    const result = redact(`token is ${fakeToken} ok`)
    expect(result.redacted).toBe(true)
    expect(result.text).toContain("[REDACTED]")
    expect(result.text).not.toContain(fakeToken)
    expect(result.matches.find((m) => m.name === "github_pat")?.count).toBe(1)
  })

  it("redacts AWS access keys", () => {
    const result = redact("key=AKIAIOSFODNN7EXAMPLE done")
    expect(result.redacted).toBe(true)
    expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE")
    expect(result.matches.find((m) => m.name === "aws_access_key")?.count).toBe(1)
  })

  it("redacts Stripe keys", () => {
    const fakeStripe = `sk_live_${"x".repeat(24)}`
    const result = redact(`use ${fakeStripe} for charges`)
    expect(result.redacted).toBe(true)
    expect(result.text).not.toContain(fakeStripe)
  })

  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_part_here"
    const result = redact(`token=${jwt}`)
    expect(result.redacted).toBe(true)
    expect(result.text).not.toContain(jwt)
  })

  it("redacts email addresses", () => {
    const result = redact("contact user@example.com about it")
    expect(result.redacted).toBe(true)
    expect(result.text).not.toContain("user@example.com")
    expect(result.matches.find((m) => m.name === "email")?.count).toBe(1)
  })

  it("redacts private IPv4 addresses", () => {
    const result = redact("server at 10.0.1.42 is down; also 192.168.1.1")
    expect(result.redacted).toBe(true)
    expect(result.text).not.toContain("10.0.1.42")
    expect(result.text).not.toContain("192.168.1.1")
    expect(result.matches.find((m) => m.name === "private_ipv4")?.count).toBe(2)
  })

  it("redacts internal URLs", () => {
    const result = redact("see https://api.internal/users/me")
    expect(result.redacted).toBe(true)
    expect(result.text).not.toContain("api.internal")
  })

  it("redacts bearer tokens", () => {
    const result = redact("Authorization: Bearer abcdefghijklmnop1234567890")
    expect(result.redacted).toBe(true)
    expect(result.text).not.toContain("abcdefghijklmnop1234567890")
  })

  it("redacts multiple distinct patterns at once", () => {
    const fakeToken = `ghp_${"x".repeat(36)}`
    const result = redact(`user@example.com hit ${fakeToken} at 10.0.0.5`)
    expect(result.matches.length).toBeGreaterThanOrEqual(3)
  })

  it("accepts custom patterns", () => {
    const customPattern = {
      description: "Customer ID",
      name: "customer_id",
      pattern: /\bCUST-\d{6}\b/g,
    }
    const result = redact("CUST-123456 reported the bug", [customPattern])
    expect(result.redacted).toBe(true)
    expect(result.text).not.toContain("CUST-123456")
    expect(result.matches.find((m) => m.name === "customer_id")?.count).toBe(1)
  })
})
