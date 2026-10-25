import * as crypto from "node:crypto"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createJwtSigner, readClaims } from "../../../src/node/oauth/jwt.js"
import { createPkcePair, isPkceMethod, s256, verifiesChallenge } from "../../../src/node/oauth/pkce.js"
import { randomHex, randomToken, sameSecret } from "../../../src/node/oauth/secrets.js"

// Wrapped so the tests can see that secret comparisons go through it (CWE-208).
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>()
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) }
})
const timingSafeEqual = vi.mocked(crypto.timingSafeEqual)
beforeEach(() => {
  timingSafeEqual.mockClear()
})
afterEach(() => vi.useRealTimers())

describe("sameSecret", () => {
  it("matches equal strings, including two empty ones", () => {
    expect(sameSecret("abc", "abc")).toBe(true)
    expect(sameSecret("", "")).toBe(true)
  })

  it("rejects a difference anywhere, the first byte included", () => {
    expect(sameSecret("abc", "abd")).toBe(false)
    expect(sameSecret("xbc", "abc")).toBe(false)
    expect(sameSecret("", "a")).toBe(false)
  })

  it("compares multi-byte characters by their bytes", () => {
    expect(sameSecret("café", "café")).toBe(true)
    expect(sameSecret("café", "cafe")).toBe(false)
  })

  it("compares equal-length secrets in constant time, and answers a length mismatch at once", () => {
    sameSecret("aaaa", "aaab")
    expect(timingSafeEqual).toHaveBeenCalledTimes(1)
    expect(sameSecret("short", "much longer")).toBe(false)
    expect(timingSafeEqual).toHaveBeenCalledTimes(1)
  })
})

describe("random values", () => {
  it("are fresh each time, in the expected alphabets", () => {
    expect(randomToken()).not.toBe(randomToken())
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe("PKCE (RFC 7636)", () => {
  // RFC 7636 Appendix B.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

  it("computes the S256 challenge of the RFC's example", () => {
    expect(s256(verifier)).toBe(challenge)
  })

  it("makes a 128-character verifier of unreserved characters, with its challenge", () => {
    const pair = createPkcePair()
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{128}$/)
    expect(pair.challenge).toBe(s256(pair.verifier))
    expect(createPkcePair().verifier).not.toBe(pair.verifier)
  })

  it("accepts the right verifier for S256 and for plain", () => {
    expect(verifiesChallenge(verifier, challenge, "S256")).toBe(true)
    expect(verifiesChallenge("plain-verifier", "plain-verifier", "plain")).toBe(true)
  })

  it("rejects a wrong verifier, of the same length or not, without throwing", () => {
    expect(verifiesChallenge(`${verifier.slice(0, -1)}x`, challenge, "S256")).toBe(false)
    expect(verifiesChallenge("plain-verifiex", "plain-verifier", "plain")).toBe(false)
    expect(verifiesChallenge("short", "plain-verifier", "plain")).toBe(false)
    expect(verifiesChallenge(verifier, `${challenge}x`, "S256")).toBe(false)
  })

  it("rejects empty values and unknown methods", () => {
    expect(verifiesChallenge("", challenge, "S256")).toBe(false)
    expect(verifiesChallenge(verifier, "", "S256")).toBe(false)
    expect(verifiesChallenge(verifier, verifier, "S512")).toBe(false)
    expect(isPkceMethod("S256") && isPkceMethod("plain") && !isPkceMethod("s256")).toBe(true)
  })

  it("compares in constant time on both methods", () => {
    verifiesChallenge(verifier, challenge, "S256")
    verifiesChallenge("abc", "abd", "plain")
    expect(timingSafeEqual).toHaveBeenCalledTimes(2)
  })
})

describe("the JWT signer", () => {
  const ISSUER = "https://mcp.test"
  const signer = createJwtSigner(ISSUER, "signing-secret")
  const issue = (lifetime = 3600, extraClaims?: Record<string, unknown>) =>
    signer.issue({ clientId: "client-1", extraClaims, lifetime, scope: ["User.Read", "Mail.Read"] })

  it("issues an RFC 7519 JWT: three base64url parts, an HS256 header, and the server's claims", () => {
    vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ["Date"] })
    const { jti, token } = issue(600)
    const parts = token.split(".")
    expect(parts).toHaveLength(3)
    parts.forEach((part) => expect(part).toMatch(/^[A-Za-z0-9_-]+$/))
    expect(JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" })
    expect(readClaims(token).orUndefined()).toEqual({
      aud: ISSUER,
      client_id: "client-1",
      exp: 1_700_000_600,
      iat: 1_700_000_000,
      iss: ISSUER,
      jti,
      scope: ["User.Read", "Mail.Read"],
    })
  })

  it("gives every token its own id", () => {
    expect(issue().jti).not.toBe(issue().jti)
  })

  it("verifies its own tokens and returns their claims", () => {
    const { jti, token } = issue()
    expect(signer.verify(token).orThrow()).toMatchObject({ client_id: "client-1", jti })
  })

  it("adds extra claims after its own, and verifies them", () => {
    const { token } = issue(3600, { name: "Ada", oid: "user-1" })
    expect(Object.keys(readClaims(token).orThrow())).toEqual([
      "aud",
      "client_id",
      "exp",
      "iat",
      "iss",
      "jti",
      "scope",
      "name",
      "oid",
    ])
    expect(signer.verify(token).isRight()).toBe(true)
  })

  it("rejects a token signed with another secret", () => {
    const other = createJwtSigner(ISSUER, "another-secret").issue({ clientId: "c", lifetime: 60, scope: [] })
    expect(
      signer.verify(other.token).fold(
        (why) => why,
        () => "ok",
      ),
    ).toBe("bad signature")
  })

  it("rejects a tampered payload, and forged signatures of any length", () => {
    const [header, payload, signature] = issue().token.split(".") as [string, string, string]
    const tampered = Buffer.from(
      JSON.stringify({ ...(readClaims(`${header}.${payload}.${signature}`).orThrow() as object), client_id: "evil" }),
    ).toString("base64url")
    expect(signer.verify(`${header}.${tampered}.${signature}`).isLeft()).toBe(true)
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`
    expect(signer.verify(`${header}.${payload}.${flipped}`).isLeft()).toBe(true)
    expect(signer.verify(`${header}.${payload}.${signature}extra`).isLeft()).toBe(true)
  })

  it("compares signatures in constant time, and answers a wrong length at once", () => {
    const [header, payload, signature] = issue().token.split(".") as [string, string, string]
    timingSafeEqual.mockClear()
    signer.verify(`${header}.${payload}.${signature}`)
    expect(timingSafeEqual).toHaveBeenCalledTimes(1)
    signer.verify(`${header}.${payload}.short`)
    expect(timingSafeEqual).toHaveBeenCalledTimes(1)
  })

  it("rejects an expired token", () => {
    vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ["Date"] })
    const { token } = issue(60)
    vi.setSystemTime(1_700_000_060_000)
    expect(
      signer.verify(token).fold(
        (why) => why,
        () => "ok",
      ),
    ).toBe("expired")
  })

  it("rejects a token from another issuer or for another audience", () => {
    const elsewhere = createJwtSigner("https://other.test", "signing-secret").issue({
      clientId: "c",
      lifetime: 60,
      scope: [],
    })
    expect(
      signer.verify(elsewhere.token).fold(
        (why) => why,
        () => "ok",
      ),
    ).toBe("wrong issuer")
  })

  it("rejects a header that names another algorithm, even with a valid signature", () => {
    const { token } = issue()
    const [, payload] = token.split(".") as [string, string]
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
    const resigned = crypto.createHmac("sha256", "signing-secret").update(`${none}.${payload}`).digest("base64url")
    expect(
      signer.verify(`${none}.${payload}.${resigned}`).fold(
        (why) => why,
        () => "ok",
      ),
    ).toBe("unsupported algorithm")
  })

  it("rejects malformed tokens without throwing", () => {
    ;["", "a.b", "a.b.c.d", "not a token", `${Buffer.from("[]").toString("base64url")}.x.y`].forEach((token) =>
      expect(signer.verify(token).isLeft()).toBe(true),
    )
  })

  it("rejects a validly signed payload that is not an object", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
    const payload = Buffer.from("42").toString("base64url")
    const sig = crypto.createHmac("sha256", "signing-secret").update(`${header}.${payload}`).digest("base64url")
    expect(
      signer.verify(`${header}.${payload}.${sig}`).fold(
        (why) => why,
        () => "ok",
      ),
    ).toBe("unreadable claims")
  })
})
