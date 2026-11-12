import { Option } from "functype"
import { describe, expect, it } from "vitest"

import { createClaimsCopier } from "../../../src/node/oauth/claims.js"
import { isAllowedRedirectUri, parseRedirectPatterns } from "../../../src/node/oauth/clients.js"
import { createFakeProvider, createTestServer, left, quiet, right } from "./harness.js"

const jwtWith = (claims: Record<string, unknown>): string =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".")

describe("copying upstream claims into issued tokens", () => {
  const warnings: string[] = []
  const copier = (policy: Parameters<typeof createClaimsCopier>[0]) =>
    createClaimsCopier(policy, {
      warn: (...args: unknown[]) => {
        warnings.push(String(args[0]))
      },
    })

  it("copies simple claims from the access token", () => {
    const copied = copier(true)({ accessToken: jwtWith({ name: "Ada", oid: "u-1", verified: true, age: 36 }) })
    expect(copied.orUndefined()).toEqual({ age: 36, name: "Ada", oid: "u-1", verified: true })
  })

  it("never lets a prefix rename a claim into one the server sets", () => {
    const copied = copier({ prefix: "j" })({ accessToken: jwtWith({ ti: "forged", name: "Ada" }) })
    expect(copied.orUndefined()).toEqual({ jname: "Ada" })
  })

  it("never copies the claims the server sets itself, scope included", () => {
    const copied = copier(true)({
      accessToken: jwtWith({
        aud: "x",
        client_id: "x",
        exp: 1,
        iat: 1,
        iss: "x",
        jti: "x",
        name: "Ada",
        nbf: 1,
        scope: "evil",
      }),
    })
    expect(copied.orUndefined()).toEqual({ name: "Ada" })
  })

  it("fills in from the ID token, with the access token winning a clash", () => {
    const copied = copier(true)({
      accessToken: jwtWith({ name: "from access" }),
      idToken: jwtWith({ email: "ada@example.test", name: "from id" }),
    })
    expect(copied.orUndefined()).toEqual({ email: "ada@example.test", name: "from access" })
    expect(Object.keys(copied.orThrow())).toEqual(["name", "email"])
  })

  it("follows allow, block and prefix", () => {
    const tokens = { accessToken: jwtWith({ a: 1, b: 2, c: 3 }) }
    expect(copier({ allow: ["a", "b"], block: ["b"] })(tokens).orUndefined()).toEqual({ a: 1 })
    expect(copier({ prefix: "upstream_" })(tokens).orUndefined()).toEqual({
      upstream_a: 1,
      upstream_b: 2,
      upstream_c: 3,
    })
  })

  it("skips oversized values, and objects unless allowed", () => {
    warnings.length = 0
    const tokens = { accessToken: jwtWith({ big: "x".repeat(2001), groups: ["a", "b"], ok: "y" }) }
    expect(copier(true)(tokens).orUndefined()).toEqual({ ok: "y" })
    expect(warnings).toHaveLength(2)
    expect(copier({ allowObjects: true })(tokens).orUndefined()).toEqual({ groups: ["a", "b"], ok: "y" })
  })

  it("reads only the tokens it is told to, and nothing when off", () => {
    const tokens = { accessToken: jwtWith({ a: 1 }), idToken: jwtWith({ b: 2 }) }
    expect(copier({ fromAccessToken: false })(tokens).orUndefined()).toEqual({ b: 2 })
    expect(copier({ fromIdToken: false })(tokens).orUndefined()).toEqual({ a: 1 })
    expect(copier(false)(tokens).isNone()).toBe(true)
  })

  it("ignores tokens that are not JWTs", () => {
    expect(copier(true)({ accessToken: "opaque-token" }).isNone()).toBe(true)
  })
})

describe("which redirect URIs a client may register", () => {
  const patternsOf = (patterns?: ReadonlyArray<string>) =>
    parseRedirectPatterns(Option(patterns)).fold(
      (error) => {
        throw error
      },
      (parsed) => parsed,
    )
  const allowed = (uri: string, patterns?: ReadonlyArray<string>) => isAllowedRedirectUri(uri, patternsOf(patterns))

  it("allows only loopback URIs when no patterns are configured", () => {
    expect(allowed("http://localhost:33418/callback")).toBe(true)
    expect(allowed("http://127.0.0.1:9000/cb")).toBe(true)
    expect(allowed("https://claude.ai/api/mcp/auth_callback")).toBe(false)
    expect(allowed("http://localhost.evil.example:80/cb")).toBe(false)
  })

  it("allows nothing with an empty list", () => {
    expect(allowed("http://localhost:9999/cb", [])).toBe(false)
    expect(allowed("https://evil.example/", [])).toBe(false)
  })

  it("matches scheme, host and port literally, and globs only the path: * for any run, ? for one character", () => {
    const patterns = ["https://claude.ai/*", "http://localhost:*/*", "https://app.example.test/cb?"]
    expect(allowed("https://claude.ai/api/mcp/auth_callback", patterns)).toBe(true)
    expect(allowed("http://localhost:4000/callback", patterns)).toBe(true)
    expect(allowed("https://app.example.test/cb1", patterns)).toBe(true)
    expect(allowed("https://app.example.test/cb12", patterns)).toBe(false)
    expect(allowed("https://claude.ai.evil.example/x", patterns)).toBe(false)
    expect(allowed("https://claude.ai:8443/x", patterns)).toBe(false)
    expect(allowed("http://claude.ai/x", patterns)).toBe(false)
  })

  it("reads a pattern with no path as any path on that origin", () => {
    expect(allowed("http://localhost:33418/callback", ["http://localhost:*"])).toBe(true)
    expect(allowed("https://claude.ai/a/b?c=d", ["https://claude.ai"])).toBe(true)
    expect(allowed("https://claude.ai.evil.example/", ["https://claude.ai"])).toBe(false)
  })

  it("compares the port the URI really uses, default ports included", () => {
    expect(allowed("https://claude.ai:443/cb", ["https://claude.ai/*"])).toBe(true)
    expect(allowed("http://localhost/cb", ["http://localhost:80/*"])).toBe(true)
    expect(allowed("http://[::1]:5000/cb", ["http://[::1]:*/*"])).toBe(true)
    expect(allowed("http://[::2]:5000/cb", ["http://[::1]:*/*"])).toBe(false)
  })

  it("compares hosts without regard to case", () => {
    expect(allowed("https://CLAUDE.ai/cb", ["https://claude.ai/*"])).toBe(true)
    expect(allowed("https://claude.ai/cb", ["https://Claude.AI/*"])).toBe(true)
  })

  it("treats regex characters in a path as themselves", () => {
    expect(allowed("https://claude.ai/aXb", ["https://claude.ai/a.b"])).toBe(false)
    expect(allowed("https://claude.ai/a+b", ["https://claude.ai/a+b"])).toBe(true)
    expect(allowed("https://claude.ai/aab", ["https://claude.ai/a+b"])).toBe(false)
  })

  it("rejects a URI that hides its real host behind a user name", () => {
    expect(allowed("http://localhost:1@evil.example/cb")).toBe(false)
    expect(allowed("https://claude.ai@evil.example/x", ["https://claude.ai/*"])).toBe(false)
  })

  it("rejects a URI with a fragment (RFC 6749 §3.1.2)", () => {
    expect(allowed("https://claude.ai/cb#frag", ["https://claude.ai/*"])).toBe(false)
  })

  it("rejects anything that is not an absolute URL", () => {
    expect(allowed("/relative", ["https://claude.ai/*"])).toBe(false)
    expect(allowed("not a url", ["https://claude.ai/*"])).toBe(false)
  })

  // Each of these let a client register a host an attacker runs (somamcp 2.6.0 matched `*` across `.` and `/`).
  it.each([
    "https://claude.ai*",
    "http://localhost*",
    "https://app.*.com/cb",
    "*",
    "*://claude.ai/*",
    "*claude.ai/*",
    "http*://claude.ai/*",
    "https://?*",
  ])("refuses the pattern %s when the server is created", (pattern) => {
    expect(() => createTestServer(createFakeProvider(), { allowedRedirectUriPatterns: [pattern] })).toThrow(
      /allowedRedirectUriPatterns/,
    )
  })

  it.each([
    ["http to a host other than loopback", "http://example.com/*"],
    ["a * port off loopback", "https://claude.ai:*/*"],
    ["a scheme other than http(s)", "myapp://callback"],
    ["a user name in the pattern", "https://claude.ai@evil.example/*"],
  ])("refuses %s when the server is created", (_why, pattern) => {
    expect(() => createTestServer(createFakeProvider(), { allowedRedirectUriPatterns: [pattern] })).toThrow(
      /allowedRedirectUriPatterns/,
    )
  })

  it("accepts the patterns real servers use", () => {
    const patterns = [
      "https://claude.ai/*",
      "https://claude.com/*",
      "http://localhost/*",
      "http://localhost:*/*",
      "http://127.0.0.1/*",
      "http://127.0.0.1:*/*",
    ]
    expect(() => createTestServer(createFakeProvider(), { allowedRedirectUriPatterns: patterns }).close()).not.toThrow()
  })
})

describe("dynamic client registration (RFC 7591)", () => {
  it("issues an id and a never-expiring secret, and echoes the metadata", async () => {
    const server = createTestServer(createFakeProvider())
    const registered = right(
      await server.register({
        client_name: "Claude",
        redirect_uris: ["https://claude.ai/a", "https://claude.ai/b"],
        token_endpoint_auth_method: "none",
      }),
    )
    expect(registered.client_id).toMatch(/^[0-9a-f]{32}$/)
    expect(registered.client_secret.length).toBeGreaterThan(30)
    expect(registered).toMatchObject({
      client_name: "Claude",
      client_secret_expires_at: 0,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["https://claude.ai/a", "https://claude.ai/b"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    })
    expect(registered.client_id_issued_at).toBeCloseTo(Date.now() / 1000, -1)
    server.close()
  })

  it("keeps every redirect URI, not just the first", async () => {
    const server = createTestServer(createFakeProvider())
    const { client_id } = right(
      await server.register({ redirect_uris: ["https://claude.ai/a", "https://claude.ai/b"] }),
    )
    const pkce = { code_challenge: "c".repeat(43), code_challenge_method: "S256", response_type: "code" }
    expect((await server.authorize({ client_id, redirect_uri: "https://claude.ai/b", ...pkce })).isRight()).toBe(true)
    server.close()
  })

  it("refuses a redirect URI outside the allow-list, and names it", async () => {
    const server = createTestServer(createFakeProvider())
    expect(left(await server.register({ redirect_uris: ["https://claude.ai/ok", "https://evil.example/cb"] }))).toEqual(
      {
        _tag: "RedirectUriNotAllowed",
        uri: "https://evil.example/cb",
      },
    )
    server.close()
  })

  it("refuses an attacker's own URI under the default allow-list", async () => {
    const server = createTestServer(createFakeProvider(), { allowedRedirectUriPatterns: undefined })
    expect(left(await server.register({ redirect_uris: ["https://evil.example/cb"] }))._tag).toBe(
      "RedirectUriNotAllowed",
    )
    server.close()
  })

  it("refuses metadata without redirect URIs, or that is malformed", async () => {
    const server = createTestServer(createFakeProvider())
    expect(left(await server.register({ client_name: "x" }))).toMatchObject({
      _tag: "InvalidClientMetadata",
      reason: "redirect_uris must list at least one URI.",
    })
    expect(left(await server.register({ redirect_uris: [] }))._tag).toBe("InvalidClientMetadata")
    expect(left(await server.register({ client_name: 7, redirect_uris: ["https://claude.ai/x"] }))).toMatchObject({
      reason: "The client metadata is not valid.",
    })
    expect(left(await server.register("not an object"))._tag).toBe("InvalidClientMetadata")
    server.close()
  })

  it("does not remember a client the store failed to save", async () => {
    const provider = createFakeProvider()
    const failing = {
      cleanup: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      get: () => Promise.resolve(undefined),
      save: () => Promise.reject(new Error("store unavailable")),
    }
    const server = createTestServer(provider, { encryptionKey: false, logger: quiet, store: failing })
    await expect(server.register({ redirect_uris: ["https://claude.ai/x"] })).rejects.toThrow("store unavailable")
    server.close()
  })
})
