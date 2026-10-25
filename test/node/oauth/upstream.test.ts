import { describe, expect, it, vi } from "vitest"

import { toWireError } from "../../../src/node/oauth/errors.js"
import { createUpstream, parseTokenResponse } from "../../../src/node/oauth/upstream.js"
import { json, quiet, TOKEN } from "./harness.js"

const form = (fields: Record<string, string>, contentType = "application/x-www-form-urlencoded") =>
  new Response(new URLSearchParams(fields).toString(), { headers: { "content-type": contentType } })

const parsed = async (response: Response) => (await parseTokenResponse(response)).orUndefined()

describe("reading a provider's token response", () => {
  it("reads JSON, every field included", async () => {
    expect(
      await parsed(
        json({
          access_token: "a",
          expires_in: 3600,
          id_token: "i",
          refresh_expires_in: 7200,
          refresh_token: "r",
          scope: "x y",
          token_type: "Bearer",
        }),
      ),
    ).toEqual({
      access_token: "a",
      expires_in: 3600,
      id_token: "i",
      refresh_expires_in: 7200,
      refresh_token: "r",
      scope: "x y",
      token_type: "Bearer",
    })
  })

  it("reads JSON with only an access token", async () => {
    expect(await parsed(json({ access_token: "a" }))).toEqual({ access_token: "a" })
  })

  it("reads a form-encoded response (GitHub), numbers included", async () => {
    expect(
      await parsed(
        form({ access_token: "a", expires_in: "28800", id_token: "i", scope: "repo", token_type: "bearer" }),
      ),
    ).toEqual({
      access_token: "a",
      expires_in: 28800,
      id_token: "i",
      scope: "repo",
      token_type: "bearer",
    })
  })

  it("reads a form-encoded response without optional fields, and treats an empty scope as none", async () => {
    expect(await parsed(form({ access_token: "a", scope: "" }))).toEqual({ access_token: "a" })
  })

  it("matches the content type whatever its case or parameters", async () => {
    expect(await parsed(form({ access_token: "a" }, "Application/X-WWW-Form-Urlencoded; charset=utf-8"))).toEqual({
      access_token: "a",
    })
    expect(await parsed(json({ access_token: "a" }, 200, "application/json; charset=utf-8"))).toEqual({
      access_token: "a",
    })
  })

  it("reads JSON when there is no content type", async () => {
    expect(await parsed(new Response(JSON.stringify({ access_token: "a" })))).toEqual({ access_token: "a" })
  })

  it.each([
    ["no access token, as JSON", json({ token_type: "Bearer" })],
    ["no access token, form-encoded", form({ token_type: "bearer" })],
    ["an access token that is not a string", json({ access_token: 42 })],
    ["an empty access token", json({ access_token: "" })],
    ["a negative expires_in", json({ access_token: "a", expires_in: -1 })],
    ["a zero expires_in", json({ access_token: "a", expires_in: 0 })],
    ["a fractional expires_in", json({ access_token: "a", expires_in: 1.5 })],
    ["a non-numeric expires_in, form-encoded", form({ access_token: "a", expires_in: "soon" })],
    ["a body that is not JSON", new Response("<html>", { headers: { "content-type": "text/html" } })],
  ])("refuses %s", async (_name, response) => {
    expect((await parseTokenResponse(response)).isNone()).toBe(true)
  })
})

describe("calling the provider's token endpoint", () => {
  const upstream = (fetch: (url: string, init: RequestInit) => Promise<Response>, timeoutMs?: number) =>
    createUpstream(
      {
        authorizationEndpoint: "https://login.example/authorize",
        clientId: "id",
        clientSecret: "secret",
        name: "Example",
        timeoutMs,
        tokenEndpoint: TOKEN,
      },
      { defaultAccessTokenLifetime: 3600, fetch, logger: quiet },
    )
  const exchange = (fetch: (url: string, init: RequestInit) => Promise<Response>, timeoutMs?: number) =>
    upstream(fetch, timeoutMs).exchangeCode({
      code: "c",
      redirectUri: "https://mcp.test/oauth/callback",
      scope: ["s"],
      verifier: "v",
    })

  it("turns a token response into the tokens it keeps, with defaults for what is missing", async () => {
    const tokens = (await exchange(() => Promise.resolve(json({ access_token: "a" })))).orThrow()
    expect(tokens).toMatchObject({ accessToken: "a", expiresIn: 3600, scope: ["s"], tokenType: "Bearer" })
    expect(tokens.issuedAt).toBeInstanceOf(Date)
    expect(tokens.refreshToken).toBeUndefined()
  })

  it("relays the provider's OAuth error as it came", async () => {
    const result = await exchange(() =>
      Promise.resolve(json({ error: "invalid_grant", error_description: "AADSTS9002313: Invalid request" }, 400)),
    )
    const error = result.fold(
      (e) => toWireError(e),
      () => undefined,
    )
    expect(error?.code).toBe("invalid_grant")
    expect(error?.description.orUndefined()).toBe("AADSTS9002313: Invalid request")
    expect(error?.status).toBe(400)
  })

  it("reports an error body it cannot read as a provider failure, not a crash", async () => {
    const result = await exchange(() => Promise.resolve(new Response("upstream exploded", { status: 503 })))
    const error = result.fold(
      (e) => toWireError(e),
      () => undefined,
    )
    expect(error?.code).toBe("server_error")
    expect(error?.description.orUndefined()).toBe("The provider answered HTTP 503.")
    expect(error?.status).toBe(502)
  })

  it("reports an unreadable success the same way", async () => {
    const result = await exchange(() => Promise.resolve(json({ nope: true })))
    expect(
      result.fold(
        (e) => e._tag,
        () => "ok",
      ),
    ).toBe("ProviderUnavailable")
  })

  it("gives every call a timeout signal, and reports a timeout as such", async () => {
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
        }),
    )
    const result = await exchange(fetch, 20)
    expect(fetch.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal)
    expect(
      result.fold(
        (e) => e,
        () => undefined,
      ),
    ).toEqual({
      _tag: "ProviderUnavailable",
      reason: "The provider did not answer in time.",
    })
  })

  it("reports a network failure as the provider being unreachable", async () => {
    const result = await exchange(() => Promise.reject(new TypeError("fetch failed")))
    expect(
      result.fold(
        (e) => e,
        () => undefined,
      ),
    ).toEqual({
      _tag: "ProviderUnavailable",
      reason: "The provider could not be reached.",
    })
  })

  it("asks for JSON, and posts a form", async () => {
    const fetch = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(json({ access_token: "a" })))
    await exchange(fetch)
    const headers = new Headers(fetch.mock.calls[0]?.[1].headers)
    expect(headers.get("accept")).toBe("application/json")
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded")
    expect(fetch.mock.calls[0]?.[1].method).toBe("POST")
  })
})
