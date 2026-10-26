import { afterEach, describe, expect, it, vi } from "vitest"

import { s256 } from "../../../src/node/oauth/pkce.js"
import { createMemoryStore } from "../../../src/node/oauth/stores/memory.js"
import {
  authorize,
  AUTHORIZE,
  BASE,
  CALLBACK,
  consentOf,
  createFakeProvider,
  createTestServer,
  json,
  left,
  pkcePair,
  providerCallback,
  redirectOf,
  register,
  right,
  signIn,
  type TestServer,
} from "./harness.js"

const servers: TestServer[] = []
const make = (...args: Parameters<typeof createTestServer>) => {
  const server = createTestServer(...args)
  servers.push(server)
  return server
}
afterEach(() => servers.splice(0).forEach((s) => s.close()))

const approve = async (server: TestServer, transactionId: string) =>
  redirectOf(right(await server.decide(new URLSearchParams({ action: "approve", transaction_id: transactionId }))))

describe("/oauth/authorize", () => {
  it("shows the consent page with the client's name, where it returns to, the provider and the scopes", async () => {
    const server = make(createFakeProvider())
    const { client_id } = await register(server)
    const screen = consentOf(right(await authorize(server, client_id, pkcePair().challenge)))
    expect(screen).toMatchObject({
      action: `${BASE}/oauth/consent`,
      provider: "Example",
      returnsTo: "claude.ai",
      scope: ["openid", "User.Read"],
    })
    expect(screen.clientName.orUndefined()).toBe("Claude")
    expect(screen.transactionId).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it("treats a name of only spaces as no name, and trims the rest", async () => {
    const server = make(createFakeProvider())
    const nameOf = async (client_name: string) => {
      const { client_id } = right(await server.register({ client_name, redirect_uris: [CALLBACK] }))
      return consentOf(right(await authorize(server, client_id, pkcePair().challenge))).clientName.orUndefined()
    }
    expect(await nameOf("   ")).toBeUndefined()
    expect(await nameOf("  Claude ")).toBe("Claude")
  })

  it("asks for the scopes the client requested, when it requests any", async () => {
    const server = make(createFakeProvider())
    const { client_id } = await register(server)
    const screen = consentOf(
      right(await authorize(server, client_id, pkcePair().challenge, { scope: "Mail.Read  Files.Read" })),
    )
    expect(screen.scope).toEqual(["Mail.Read", "Files.Read"])
  })

  it("goes straight to the provider when consent is not required, and the sign-in completes", async () => {
    const server = make(createFakeProvider(), { consentRequired: false })
    const { client_id } = await register(server)
    const pkce = pkcePair()
    const upstream = redirectOf(right(await authorize(server, client_id, pkce.challenge)))
    expect(`${upstream.origin}${upstream.pathname}`).toBe(AUTHORIZE)
    const code = redirectOf(right(await server.callback(providerCallback(upstream)))).searchParams.get("code") ?? ""
    const tokens = await server.token({
      clientId: client_id,
      code,
      codeVerifier: pkce.verifier,
      grantType: "authorization_code",
    })
    expect(tokens.isRight()).toBe(true)
  })

  describe("before the client and its redirect URI are verified, errors are shown, never redirected", () => {
    it("needs a client_id and a redirect_uri", async () => {
      const server = make(createFakeProvider())
      expect(left(await server.authorize({ redirect_uri: CALLBACK }))._tag).toBe("InvalidRequest")
      expect(left(await server.authorize({ client_id: "x" }))._tag).toBe("InvalidRequest")
    })

    it("rejects a client_id this server never issued, even before any client registers", async () => {
      const server = make(createFakeProvider())
      expect(left(await authorize(server, "made-up", pkcePair().challenge))).toEqual({
        _tag: "UnknownClient",
        clientId: "made-up",
      })
    })

    it("rejects a redirect URI the client did not register, compared exactly", async () => {
      const server = make(createFakeProvider())
      const { client_id } = await register(server)
      for (const redirect_uri of [
        "https://evil.example/steal",
        `${CALLBACK}/`,
        "https://CLAUDE.ai/api/mcp/auth_callback",
        `${CALLBACK}?x=1`,
      ])
        expect(left(await authorize(server, client_id, pkcePair().challenge, { redirect_uri }))._tag).toBe(
          "InvalidRequest",
        )
    })

    it("does not hand an attacker a code, whatever the link", async () => {
      const provider = createFakeProvider()
      const server = make(provider)
      const { client_id } = await register(server)
      const attack = await authorize(server, client_id, pkcePair().challenge, {
        redirect_uri: "https://evil.example/cb",
        response_type: "code",
      })
      expect(attack.isLeft()).toBe(true)
      expect(provider.requests).toHaveLength(0)
    })
  })

  describe("once verified, errors go back to the client (RFC 6749 §4.1.2.1)", () => {
    const errorRedirect = async (server: TestServer, params: Record<string, string | undefined>) => {
      const { client_id } = await register(server)
      const back = redirectOf(right(await authorize(server, client_id, pkcePair().challenge, params)))
      expect(`${back.origin}${back.pathname}`).toBe(CALLBACK)
      return back.searchParams
    }

    it("for a response type other than code", async () => {
      const params = await errorRedirect(make(createFakeProvider()), { response_type: "token" })
      expect(params.get("error")).toBe("unsupported_response_type")
      expect(params.get("state")).toBe("client-state")
      expect(params.get("iss")).toBe(BASE)
    })

    it("for a request without PKCE", async () => {
      const params = await errorRedirect(make(createFakeProvider()), { code_challenge: undefined })
      expect(params.get("error")).toBe("invalid_request")
      expect(params.get("error_description")).toContain("PKCE is required")
    })

    it("for an unknown PKCE method", async () => {
      expect((await errorRedirect(make(createFakeProvider()), { code_challenge_method: "S512" })).get("error")).toBe(
        "invalid_request",
      )
    })

    it("for PKCE plain when it is turned off", async () => {
      const params = await errorRedirect(make(createFakeProvider(), { allowPlainPkce: false }), {
        code_challenge_method: "plain",
      })
      expect(params.get("error_description")).toContain('"plain" is not allowed')
    })

    it("without a state when the client sent none", async () => {
      const params = await errorRedirect(make(createFakeProvider()), { response_type: "token", state: undefined })
      expect(params.has("state")).toBe(false)
    })
  })

  describe("PKCE", () => {
    it("accepts plain by default, and a challenge without a method as plain (RFC 7636 §4.3)", async () => {
      const server = make(createFakeProvider())
      const { client_id } = await register(server)
      expect(right(await authorize(server, client_id, "p".repeat(43), { code_challenge_method: "plain" }))._tag).toBe(
        "Consent",
      )
      expect(right(await authorize(server, client_id, "p".repeat(43), { code_challenge_method: undefined }))._tag).toBe(
        "Consent",
      )
    })

    it("still accepts S256 with plain turned off", async () => {
      const server = make(createFakeProvider(), { allowPlainPkce: false })
      const { client_id } = await register(server)
      expect(right(await authorize(server, client_id, pkcePair().challenge))._tag).toBe("Consent")
    })

    it("advertises plain only while it is allowed", () => {
      expect(make(createFakeProvider()).metadata().code_challenge_methods_supported).toEqual(["S256", "plain"])
      expect(make(createFakeProvider(), { allowPlainPkce: false }).metadata().code_challenge_methods_supported).toEqual(
        ["S256"],
      )
    })
  })
})

describe("the consent decision", () => {
  it("checks the answer before it looks anything up", async () => {
    const store = createMemoryStore()
    const get = vi.spyOn(store, "get")
    const server = make(createFakeProvider(), { store })
    expect(left(await server.decide(new URLSearchParams({ action: "maybe", transaction_id: "x" })))).toMatchObject({
      _tag: "InvalidRequest",
    })
    expect(get).not.toHaveBeenCalled()
  })

  it("needs a transaction it knows", async () => {
    const server = make(createFakeProvider())
    expect(left(await server.decide(new URLSearchParams({ action: "approve" })))._tag).toBe("InvalidRequest")
    expect(left(await server.decide(new URLSearchParams({ action: "approve", transaction_id: "gone" })))._tag).toBe(
      "InvalidRequest",
    )
  })

  it("on approve, sends the user to the provider with the server's own PKCE challenge", async () => {
    const server = make(createFakeProvider())
    const { client_id } = await register(server)
    const screen = consentOf(right(await authorize(server, client_id, pkcePair().challenge)))
    const upstream = await approve(server, screen.transactionId)
    expect(`${upstream.origin}${upstream.pathname}`).toBe(AUTHORIZE)
    expect(Object.fromEntries(upstream.searchParams)).toEqual({
      client_id: "upstream-client",
      code_challenge: expect.any(String),
      code_challenge_method: "S256",
      redirect_uri: `${BASE}/oauth/callback`,
      response_type: "code",
      scope: "openid User.Read",
      state: screen.transactionId,
    })
  })

  it("on deny, sends the user back to the client with access_denied, its state and iss", async () => {
    const server = make(createFakeProvider())
    const { client_id } = await register(server)
    const screen = consentOf(right(await authorize(server, client_id, pkcePair().challenge)))
    const back = redirectOf(
      right(await server.decide(new URLSearchParams({ action: "deny", transaction_id: screen.transactionId }))),
    )
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK)
    expect(back.searchParams.get("error")).toBe("access_denied")
    expect(back.searchParams.get("state")).toBe("client-state")
    expect(back.searchParams.get("iss")).toBe(BASE)
    // A denied request is gone: it cannot be approved afterwards.
    expect(
      left(await server.decide(new URLSearchParams({ action: "approve", transaction_id: screen.transactionId })))._tag,
    ).toBe("InvalidRequest")
  })

  it("does not redirect a denial to a callback the stored request was tampered to name", async () => {
    const store = createMemoryStore()
    const server = make(createFakeProvider(), { encryptionKey: false, store })
    const { client_id } = await register(server)
    const screen = consentOf(right(await authorize(server, client_id, pkcePair().challenge)))
    const key = `transaction:${screen.transactionId}`
    await store.save(key, { ...((await store.get(key)) as object), clientCallbackUrl: "https://evil.example/cb" }, 600)
    const denied = await server.decide(new URLSearchParams({ action: "deny", transaction_id: screen.transactionId }))
    expect(left(denied)._tag).toBe("InvalidRequest")
  })
})

describe("/oauth/callback", () => {
  it("exchanges the provider's code with the server's verifier and hands the client its own code", async () => {
    const provider = createFakeProvider()
    const store = createMemoryStore()
    const server = make(provider, { encryptionKey: false, store })
    const { client_id } = await register(server)
    const { back, upstreamUrl } = await signIn(server, client_id)
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK)
    expect(back.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(back.searchParams.get("state")).toBe("client-state")
    expect(back.searchParams.get("iss")).toBe(BASE)
    const sent = provider.requests[0]
    expect(sent?.body.get("code")).toBe("upstream-code")
    expect(sent?.body.get("redirect_uri")).toBe(`${BASE}/oauth/callback`)
    expect(s256(sent?.body.get("code_verifier") ?? "")).toBe(upstreamUrl.searchParams.get("code_challenge"))
  })

  it("completes a sign-in once: a second callback with the same state is refused", async () => {
    const server = make(createFakeProvider())
    const { client_id } = await register(server)
    const { upstreamUrl } = await signIn(server, client_id)
    expect(left(await server.callback(providerCallback(upstreamUrl)))._tag).toBe("InvalidRequest")
  })

  it("refuses a callback without a state, or with one it does not know", async () => {
    const server = make(createFakeProvider())
    expect(left(await server.callback(new URL(`${BASE}/oauth/callback?code=x`)))._tag).toBe("InvalidRequest")
    expect(left(await server.callback(new URL(`${BASE}/oauth/callback?code=x&state=unknown`)))._tag).toBe(
      "InvalidRequest",
    )
  })

  it("refuses a sign-in that reached the provider without being approved on the consent page", async () => {
    const provider = createFakeProvider()
    const server = make(provider)
    const { client_id } = await register(server)
    const screen = consentOf(right(await authorize(server, client_id, pkcePair().challenge)))
    // A client that read the transaction id off the page and sent the user to the provider itself.
    const bypass = await server.callback(new URL(`${BASE}/oauth/callback?code=c&state=${screen.transactionId}`))
    expect(left(bypass)).toMatchObject({ _tag: "InvalidRequest" })
    expect(provider.requests).toHaveLength(0)
  })

  it("refuses to redirect to a callback the client no longer lists", async () => {
    const store = createMemoryStore()
    const server = make(createFakeProvider(), { encryptionKey: false, store })
    const { client_id } = await register(server)
    const screen = consentOf(right(await authorize(server, client_id, pkcePair().challenge)))
    const upstream = await approve(server, screen.transactionId)
    const key = `transaction:${screen.transactionId}`
    await store.save(key, { ...((await store.get(key)) as object), clientCallbackUrl: "https://evil.example/cb" }, 600)
    expect(left(await server.callback(providerCallback(upstream)))._tag).toBe("InvalidRequest")
  })

  it("relays the provider's error, such as the user cancelling, back to the client", async () => {
    const server = make(createFakeProvider())
    const { client_id } = await register(server)
    const screen = consentOf(right(await authorize(server, client_id, pkcePair().challenge)))
    const upstream = await approve(server, screen.transactionId)
    const back = redirectOf(
      right(
        await server.callback(
          providerCallback(upstream, { error: "access_denied", error_description: "AADSTS65004: User declined." }),
        ),
      ),
    )
    expect(back.searchParams.get("error")).toBe("access_denied")
    expect(back.searchParams.get("error_description")).toBe("AADSTS65004: User declined.")
    expect(back.searchParams.get("state")).toBe("client-state")
  })

  it("tells the client when the code exchange fails", async () => {
    const provider = createFakeProvider()
    const server = make(provider)
    const { client_id } = await register(server)
    const screen = consentOf(right(await authorize(server, client_id, pkcePair().challenge)))
    const upstream = await approve(server, screen.transactionId)
    provider.queue(json({ error: "invalid_grant", error_description: "AADSTS54005: code already redeemed" }, 400))
    const back = redirectOf(right(await server.callback(providerCallback(upstream))))
    expect(back.searchParams.get("error")).toBe("invalid_grant")
    expect(back.searchParams.get("error_description")).toBe("AADSTS54005: code already redeemed")
  })

  it("tells the client server_error when the provider sends neither a code nor an error", async () => {
    const server = make(createFakeProvider())
    const { client_id } = await register(server)
    const screen = consentOf(right(await authorize(server, client_id, pkcePair().challenge)))
    const upstream = await approve(server, screen.transactionId)
    const back = redirectOf(right(await server.callback(providerCallback(upstream, {}))))
    expect(back.searchParams.get("error")).toBe("server_error")
  })
})

describe("acceptSignIn", () => {
  const idToken = (claims: Record<string, unknown>) =>
    [{ alg: "none" }, claims].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".x"

  it("sees the id token's claims, and its reason goes back to the client as access_denied", async () => {
    const provider = createFakeProvider()
    const accept = vi.fn((claims: Readonly<Record<string, unknown>>) =>
      claims.email === "ok@example.com" ? undefined : "Not on the list.",
    )
    const server = make(provider, { acceptSignIn: accept })
    const { client_id } = await register(server)
    provider.queue(json({ access_token: "a", id_token: idToken({ email: "ok@example.com" }) }))
    expect((await signIn(server, client_id)).back.searchParams.get("code")).not.toBeNull()
    provider.queue(json({ access_token: "a", id_token: idToken({ email: "other@example.com" }) }))
    const refused = (await signIn(server, client_id)).back
    expect(refused.searchParams.get("error")).toBe("access_denied")
    expect(refused.searchParams.get("error_description")).toBe("Not on the list.")
    expect(accept.mock.calls.map(([claims]) => claims.email)).toEqual(["ok@example.com", "other@example.com"])
  })

  it("needs an id token when the server's scopes include openid, and not otherwise", async () => {
    const accept = vi.fn(() => undefined)
    const withOpenid = make(createFakeProvider(), { acceptSignIn: accept })
    const a = await register(withOpenid)
    expect((await signIn(withOpenid, a.client_id)).back.searchParams.get("error")).toBe("access_denied")
    const without = make(createFakeProvider(), { acceptSignIn: accept, scopes: ["User.Read"] })
    const b = await register(without)
    expect((await signIn(without, b.client_id)).back.searchParams.get("code")).not.toBeNull()
    expect(accept).not.toHaveBeenCalled()
  })
})

describe("iss on redirects (RFC 9207)", () => {
  it("is advertised and sent by default", async () => {
    const server = make(createFakeProvider())
    expect(server.metadata().authorization_response_iss_parameter_supported).toBe(true)
    const { client_id } = await register(server)
    expect((await signIn(server, client_id)).back.searchParams.get("iss")).toBe(BASE)
  })

  it("is neither advertised nor sent when turned off", async () => {
    const server = make(createFakeProvider(), { authorizationResponseIss: false })
    expect("authorization_response_iss_parameter_supported" in server.metadata()).toBe(false)
    const { client_id } = await register(server)
    const { back } = await signIn(server, client_id)
    expect(back.searchParams.has("iss")).toBe(false)
    const screen = consentOf(right(await authorize(server, client_id, pkcePair().challenge)))
    const denied = redirectOf(
      right(await server.decide(new URLSearchParams({ action: "deny", transaction_id: screen.transactionId }))),
    )
    expect(denied.searchParams.has("iss")).toBe(false)
  })
})

describe("extra parameters on the provider's sign-in URL", () => {
  const upstreamFor = async (extraAuthorizationParams?: Record<string, string>) => {
    const server = make(createFakeProvider(), {
      upstream: {
        authorizationEndpoint: AUTHORIZE,
        clientId: "upstream-client",
        clientSecret: "upstream-secret",
        extraAuthorizationParams,
        name: "Example",
        tokenEndpoint: "https://login.example/token",
      },
    })
    const { client_id } = await register(server)
    const screen = consentOf(right(await authorize(server, client_id, pkcePair().challenge)))
    return approve(server, screen.transactionId)
  }

  it("are added", async () => {
    const url = await upstreamFor({ domain_hint: "contoso.com", prompt: "select_account" })
    expect(url.searchParams.get("prompt")).toBe("select_account")
    expect(url.searchParams.get("domain_hint")).toBe("contoso.com")
  })

  it("leave the URL as it was when there are none", async () => {
    expect([...(await upstreamFor()).searchParams.keys()].sort()).toEqual([
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
    ])
  })

  it("cannot replace the OAuth parameters, the server's PKCE challenge included", async () => {
    const url = await upstreamFor({
      client_id: "evil",
      code_challenge: "attacker-chosen",
      code_challenge_method: "plain",
      redirect_uri: "https://evil.example/cb",
      response_type: "token",
      scope: "everything",
      state: "forged",
    })
    expect(url.searchParams.get("client_id")).toBe("upstream-client")
    expect(url.searchParams.get("code_challenge")).not.toBe("attacker-chosen")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}/oauth/callback`)
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("scope")).toBe("openid User.Read")
    expect(url.searchParams.get("state")).not.toBe("forged")
  })
})
