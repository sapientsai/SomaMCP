import { afterEach, describe, expect, it, vi } from "vitest"

import { readClaims } from "../../../src/node/oauth/jwt.js"
import { secondsUntil } from "../../../src/node/oauth/records.js"
import { createMemoryStore } from "../../../src/node/oauth/stores/memory.js"
import type { TokenStore } from "../../../src/node/oauth/stores/types.js"
import {
  authorize,
  consentOf,
  createFakeProvider,
  createTestServer,
  type FakeProvider,
  issueTokens,
  json,
  left,
  pkcePair,
  providerCallback,
  redirectOf,
  register,
  right,
  signIn,
  spyStore,
  type TestServer,
  TOKEN,
  wire,
} from "./harness.js"

const servers: TestServer[] = []
const make = (...args: Parameters<typeof createTestServer>) => {
  const server = createTestServer(...args)
  servers.push(server)
  return server
}
afterEach(() => {
  servers.splice(0).forEach((s) => s.close())
  vi.useRealTimers()
})

const setup = (overrides: Parameters<typeof createTestServer>[1] = {}) => {
  const provider = createFakeProvider()
  const spy = spyStore(createMemoryStore())
  const server = make(provider, { encryptionKey: false, store: spy.store, ...overrides })
  return { provider, saves: spy.saves, server, store: spy.store }
}

const refreshWith = (server: TestServer, clientId: string, refreshToken: string, scope?: string) =>
  server.token({ clientId, grantType: "refresh_token", refreshToken, scope })

describe("redeeming an authorization code", () => {
  it("issues the server's own JWT pair, never the provider's tokens", async () => {
    const { server } = setup()
    const { client_id } = await register(server)
    const tokens = await issueTokens(server, client_id)
    expect(tokens).toMatchObject({ expires_in: 3599, scope: "User.Read Mail.Read", token_type: "Bearer" })
    expect(tokens.access_token).not.toBe("access-1")
    expect(tokens.refresh_token).not.toBe("refresh-1")
    expect(readClaims(tokens.access_token).orThrow()).toMatchObject({ client_id, scope: ["User.Read", "Mail.Read"] })
  })

  it("keeps the provider's tokens, and maps each JWT to them", async () => {
    const { saves, server } = setup()
    const { client_id } = await register(server)
    const tokens = await issueTokens(server, client_id)
    const access = String(readClaims(tokens.access_token).orThrow().jti)
    const refresh = String(readClaims(tokens.refresh_token ?? "").orThrow().jti)
    const upstream = saves.find((s) => s.key.startsWith("upstream:"))
    expect(upstream?.value).toMatchObject({ accessToken: "access-1", refreshToken: "refresh-1" })
    const key = upstream?.key.slice("upstream:".length)
    expect(saves.find((s) => s.key === `mapping:${access}`)?.value).toMatchObject({
      clientId: client_id,
      upstreamTokenKey: key,
    })
    expect(saves.find((s) => s.key === `mapping:${refresh}`)?.value).toMatchObject({ upstreamTokenKey: key })
  })

  it("resolves its access token to the provider's tokens, and nothing else", async () => {
    const { server, store } = setup()
    const { client_id } = await register(server)
    const tokens = await issueTokens(server, client_id)
    expect((await server.resolve(tokens.access_token)).orUndefined()?.accessToken).toBe("access-1")
    expect((await server.resolve("not-a-jwt")).isNone()).toBe(true)
    // Validly signed, but nothing in the store stands behind it.
    await store.delete(`mapping:${String(readClaims(tokens.access_token).orThrow().jti)}`)
    expect((await server.resolve(tokens.access_token)).isNone()).toBe(true)
  })

  it("refuses a client it does not know, or no client at all", async () => {
    const { server } = setup()
    expect(left(await server.token({ clientId: "", code: "c", grantType: "authorization_code" }))._tag).toBe(
      "UnknownClient",
    )
    expect(wire(await server.token({ clientId: "nobody", code: "c", grantType: "authorization_code" }))).toEqual({
      code: "invalid_client",
      description: "This client is not registered with the server.",
      status: 400,
    })
  })

  it("refuses an unknown code", async () => {
    const { server } = setup()
    const { client_id } = await register(server)
    expect(
      wire(
        await server.token({ clientId: client_id, code: "nope", codeVerifier: "v", grantType: "authorization_code" }),
      ),
    ).toMatchObject({
      code: "invalid_grant",
    })
  })

  it("redeems a code once, says so after, and keeps no tokens in what it leaves behind", async () => {
    const { server, store } = setup()
    const { client_id } = await register(server)
    const { code, verifier } = await signIn(server, client_id)
    const redeem = () =>
      server.token({ clientId: client_id, code, codeVerifier: verifier, grantType: "authorization_code" })
    expect((await redeem()).isRight()).toBe(true)
    expect(left(await redeem())).toEqual({ _tag: "InvalidGrant", reason: "The authorization code was already used." })
    expect(Object.keys((await store.get(`code:${code}`)) as object).sort()).toEqual(["expiresAt", "used"])
  })

  it("refuses a code issued to another client, and spends it", async () => {
    const { server } = setup()
    const { client_id } = await register(server)
    const other = (await register(server)).client_id
    const { code, verifier } = await signIn(server, client_id)
    expect(
      left(await server.token({ clientId: other, code, codeVerifier: verifier, grantType: "authorization_code" })),
    ).toMatchObject({
      reason: "The authorization code was issued to another client.",
    })
    expect(
      left(await server.token({ clientId: client_id, code, codeVerifier: verifier, grantType: "authorization_code" })),
    ).toMatchObject({
      reason: "The authorization code was already used.",
    })
  })

  describe("PKCE", () => {
    it("needs the verifier", async () => {
      const { server } = setup()
      const { client_id } = await register(server)
      const { code } = await signIn(server, client_id)
      expect(left(await server.token({ clientId: client_id, code, grantType: "authorization_code" }))._tag).toBe(
        "InvalidRequest",
      )
    })

    it("refuses the wrong verifier", async () => {
      const { server } = setup()
      const { client_id } = await register(server)
      const { code } = await signIn(server, client_id)
      expect(
        wire(
          await server.token({
            clientId: client_id,
            code,
            codeVerifier: pkcePair().verifier,
            grantType: "authorization_code",
          }),
        ),
      ).toMatchObject({ code: "invalid_grant", description: "The code_verifier does not match the code_challenge." })
    })

    const plainCode = async (server: TestServer, clientId: string) => {
      const screen = consentOf(
        right(await authorize(server, clientId, "plain-verifier-".repeat(4), { code_challenge_method: "plain" })),
      )
      const upstream = redirectOf(
        right(await server.decide(new URLSearchParams({ action: "approve", transaction_id: screen.transactionId }))),
      )
      return redirectOf(right(await server.callback(providerCallback(upstream)))).searchParams.get("code") ?? ""
    }

    it("redeems a plain code while plain is allowed", async () => {
      const { server } = setup()
      const { client_id } = await register(server)
      const code = await plainCode(server, client_id)
      expect(
        (
          await server.token({
            clientId: client_id,
            code,
            codeVerifier: "plain-verifier-".repeat(4),
            grantType: "authorization_code",
          })
        ).isRight(),
      ).toBe(true)
    })

    it("refuses a plain code issued before plain was turned off", async () => {
      const provider = createFakeProvider()
      const store = createMemoryStore()
      const before = make(provider, { store })
      const { client_id } = await register(before)
      const code = await plainCode(before, client_id)
      const after = make(provider, { allowPlainPkce: false, store })
      expect(
        left(
          await after.token({
            clientId: client_id,
            code,
            codeVerifier: "plain-verifier-".repeat(4),
            grantType: "authorization_code",
          }),
        )._tag,
      ).toBe("InvalidGrant")
    })

    it("refuses a code stored without a challenge", async () => {
      const { server, store } = setup()
      const { client_id } = await register(server)
      const { code, verifier } = await signIn(server, client_id)
      await store.save(`code:${code}`, { ...((await store.get(`code:${code}`)) as object), codeChallenge: "" }, 300)
      expect(
        left(
          await server.token({ clientId: client_id, code, codeVerifier: verifier, grantType: "authorization_code" }),
        ),
      ).toMatchObject({
        reason: "The authorization code was issued without PKCE.",
      })
    })
  })

  it("refuses a grant type it does not support", async () => {
    const { server } = setup()
    expect(wire(await server.token({ clientId: "c", grantType: "password" }))).toEqual({
      code: "unsupported_grant_type",
      description: 'The grant type "password" is not supported.',
      status: 400,
    })
  })
})

describe("secondsUntil, the ttl for a store", () => {
  it("rounds up, and never goes below one second", () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] })
    expect(secondsUntil(new Date(1_000_000 + 1_500))).toBe(2)
    expect(secondsUntil(new Date(1_000_000 + 10))).toBe(1)
    expect(secondsUntil(new Date(1_000_000 - 5_000))).toBe(1)
  })
})

describe("how long the provider's tokens are kept", () => {
  const upstreamTtl = async (
    response: Record<string, unknown>,
    overrides: Parameters<typeof createTestServer>[1] = {},
  ) => {
    const { provider, saves, server } = setup(overrides)
    provider.queue(json(response))
    const { client_id } = await register(server)
    const tokens = await issueTokens(server, client_id)
    return { saves, tokens, ttl: saves.find((s) => s.key.startsWith("upstream:"))?.ttl }
  }

  it("as long as the refresh token, usually the longer one", async () => {
    expect((await upstreamTtl({ access_token: "a", expires_in: 3600, refresh_token: "r" })).ttl).toBe(2_592_000)
  })

  it("as long as the access token when the refresh token is shorter (Keycloak)", async () => {
    expect(
      (await upstreamTtl({ access_token: "a", expires_in: 3600, refresh_expires_in: 300, refresh_token: "r" })).ttl,
    ).toBe(3600)
  })

  it("for the provider's refresh_expires_in when it sends one", async () => {
    expect(
      (await upstreamTtl({ access_token: "a", expires_in: 3600, refresh_expires_in: 86_400, refresh_token: "r" })).ttl,
    ).toBe(86_400)
  })

  it("for the access token alone without a refresh token, and then issues no refresh token", async () => {
    const { tokens, ttl } = await upstreamTtl({ access_token: "a", expires_in: 7200 })
    expect(ttl).toBe(7200)
    expect(tokens.refresh_token).toBeUndefined()
  })

  it("for the configured lifetimes when the provider gives none", async () => {
    const { tokens, ttl } = await upstreamTtl(
      { access_token: "a", refresh_token: "r" },
      { lifetimes: { accessToken: 900, refreshToken: 1800 } },
    )
    expect(tokens.expires_in).toBe(900)
    expect(ttl).toBe(1800)
  })

  it("and each JWT's mapping for that JWT's own lifetime", async () => {
    const { saves } = await upstreamTtl({
      access_token: "a",
      expires_in: 600,
      refresh_expires_in: 1200,
      refresh_token: "r",
    })
    expect(saves.filter((s) => s.key.startsWith("mapping:")).map((s) => s.ttl)).toEqual([600, 1200])
  })
})

describe("refreshing", () => {
  const signedIn = async (overrides: Parameters<typeof createTestServer>[1] = {}) => {
    const env = setup(overrides)
    const { client_id } = await register(env.server)
    const tokens = await issueTokens(env.server, client_id)
    return { ...env, clientId: client_id, tokens }
  }

  it("swaps the refresh token for a new pair, through the provider", async () => {
    const { clientId, provider, server, tokens } = await signedIn()
    const next = right(await refreshWith(server, clientId, tokens.refresh_token ?? ""))
    expect(provider.requests[1]?.body.get("grant_type")).toBe("refresh_token")
    expect(provider.requests[1]?.body.get("refresh_token")).toBe("refresh-1")
    expect(next.access_token).not.toBe(tokens.access_token)
    expect(next.refresh_token).not.toBe(tokens.refresh_token)
    expect((await server.resolve(next.access_token)).orUndefined()?.accessToken).toBe("access-2")
  })

  it("accepts a refresh token once", async () => {
    const { clientId, server, tokens } = await signedIn()
    expect((await refreshWith(server, clientId, tokens.refresh_token ?? "")).isRight()).toBe(true)
    expect(left(await refreshWith(server, clientId, tokens.refresh_token ?? ""))).toEqual({
      _tag: "InvalidGrant",
      reason: "The refresh token was already used or has expired.",
    })
  })

  it("lets exactly one of several concurrent refreshes through", async () => {
    const { clientId, server, tokens } = await signedIn()
    const results = await Promise.all(
      Array.from({ length: 6 }, () => refreshWith(server, clientId, tokens.refresh_token ?? "")),
    )
    expect(results.filter((r) => r.isRight())).toHaveLength(1)
  })

  it("refuses an invalid or expired refresh token", async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] })
    const { clientId, server, tokens } = await signedIn()
    expect(left(await refreshWith(server, clientId, "garbage"))._tag).toBe("InvalidGrant")
    vi.setSystemTime(Date.now() + 2_592_001 * 1000)
    expect(left(await refreshWith(server, clientId, tokens.refresh_token ?? ""))).toMatchObject({
      reason: "The refresh token is invalid or has expired.",
    })
  })

  it("refuses a valid refresh token whose mapping is gone", async () => {
    const { clientId, server, store, tokens } = await signedIn()
    await store.delete(`mapping:${String(readClaims(tokens.refresh_token ?? "").orThrow().jti)}`)
    expect(left(await refreshWith(server, clientId, tokens.refresh_token ?? ""))._tag).toBe("InvalidGrant")
  })

  it("refuses when the provider's tokens are gone, or carry no refresh token", async () => {
    const { clientId, saves, server, store, tokens } = await signedIn()
    const upstreamKey = saves.find((s) => s.key.startsWith("upstream:"))?.key ?? ""
    const stored = (await store.get(upstreamKey)) as Record<string, unknown>
    await store.save(upstreamKey, { ...stored, refreshToken: undefined }, 3600)
    expect(left(await refreshWith(server, clientId, tokens.refresh_token ?? ""))).toMatchObject({
      reason: "The provider issued no refresh token.",
    })
    await store.delete(upstreamKey)
    expect(left(await refreshWith(server, clientId, tokens.refresh_token ?? ""))).toMatchObject({
      reason: "The sign-in behind this refresh token has expired.",
    })
  })

  it("refuses a refresh token presented by another client, and leaves it usable", async () => {
    const { clientId, server, tokens } = await signedIn()
    expect(left(await refreshWith(server, "someone-else", tokens.refresh_token ?? ""))).toMatchObject({
      reason: "The refresh token was issued to another client.",
    })
    expect((await refreshWith(server, clientId, tokens.refresh_token ?? "")).isRight()).toBe(true)
  })

  it("relays the provider's refusal, and the refresh token still works afterwards", async () => {
    const { clientId, provider, server, tokens } = await signedIn()
    provider.queue(json({ error: "invalid_grant", error_description: "AADSTS70008: expired" }, 400))
    expect(wire(await refreshWith(server, clientId, tokens.refresh_token ?? ""))).toEqual({
      code: "invalid_grant",
      description: "AADSTS70008: expired",
      status: 400,
    })
    provider.queue(new Response("bad gateway", { status: 502 }))
    expect(wire(await refreshWith(server, clientId, tokens.refresh_token ?? ""))).toEqual({
      code: "server_error",
      description: "The provider answered HTTP 502.",
      status: 502,
    })
    expect((await refreshWith(server, clientId, tokens.refresh_token ?? "")).isRight()).toBe(true)
  })

  it("puts a failed refresh token back with the lifetime it had left, not a fresh one", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] })
    const { clientId, provider, saves, server, tokens } = await signedIn({ lifetimes: { refreshToken: 600 } })
    vi.setSystemTime(1_800_000_000_000 + 200_000)
    saves.length = 0
    provider.queue(json({ error: "temporarily_unavailable" }, 503))
    await refreshWith(server, clientId, tokens.refresh_token ?? "")
    expect(saves.filter((s) => s.key.startsWith("mapping:")).map((s) => s.ttl)).toEqual([400])
  })

  it("still reports the provider's refusal when putting the token back fails", async () => {
    const env = await signedIn()
    const errors: unknown[][] = []
    const failingStore: TokenStore = {
      ...env.store,
      save: (key, value, ttl) =>
        key.startsWith("mapping:") ? Promise.reject(new Error("store down")) : env.store.save(key, value, ttl),
    }
    const server = make(env.provider, {
      encryptionKey: false,
      logger: { error: (...a) => errors.push(a), warn: () => {} },
      store: failingStore,
    })
    env.provider.queue(json({ error: "invalid_grant", error_description: "revoked" }, 400))
    expect(wire(await refreshWith(server, env.clientId, env.tokens.refresh_token ?? ""))).toMatchObject({
      description: "revoked",
    })
    expect(String(errors[0]?.[0])).toContain("could not put back a refresh token")
  })

  it("keeps the provider's new refresh token when it rotates, and uses it next time", async () => {
    const { clientId, provider, server, tokens } = await signedIn()
    const second = right(await refreshWith(server, clientId, tokens.refresh_token ?? ""))
    right(await refreshWith(server, clientId, second.refresh_token ?? ""))
    expect(provider.requests.map((r) => r.body.get("refresh_token")).slice(1)).toEqual(["refresh-1", "refresh-2"])
  })

  it("keeps the old refresh token when the provider does not rotate it", async () => {
    const { clientId, provider, server, tokens } = await signedIn()
    provider.queue(json({ access_token: "access-unrotated", expires_in: 3600 }))
    const second = right(await refreshWith(server, clientId, tokens.refresh_token ?? ""))
    expect(second.refresh_token).toBeDefined()
    right(await refreshWith(server, clientId, second.refresh_token ?? ""))
    expect(provider.requests[2]?.body.get("refresh_token")).toBe("refresh-1")
  })

  it("keeps the granted scope when the provider leaves it out, and passes a requested one on, narrowed", async () => {
    const { clientId, provider, server, tokens } = await signedIn()
    provider.queue(json({ access_token: "a2", expires_in: 3600, refresh_token: "r2" }))
    const next = right(await refreshWith(server, clientId, tokens.refresh_token ?? "", "User.Read Mail.Send"))
    // The grant is User.Read Mail.Read: Mail.Send was never granted, and openid may be asked again.
    expect(provider.requests[1]?.body.get("scope")).toBe("User.Read openid")
    expect(next.scope).toBe("User.Read Mail.Read")
  })

  it("never asks for more on a refresh than the sign-in was granted, even if the server's list has it", async () => {
    const env = setup({ scopes: ["openid", "offline_access", "User.Read", "Mail.Send"] })
    const { client_id } = await register(env.server)
    env.provider.queue(json({ access_token: "a1", expires_in: 3600, refresh_token: "r1", scope: "User.Read" }))
    const tokens = await issueTokens(env.server, client_id)
    const first = right(await refreshWith(env.server, client_id, tokens.refresh_token ?? "", "Mail.Send"))
    // Mail.Send is on the server's list but was never granted, so no scope is sent.
    expect(env.provider.requests[1]?.body.has("scope")).toBe(false)
    right(await refreshWith(env.server, client_id, first.refresh_token ?? "", "Mail.Send User.Read"))
    expect(env.provider.requests[2]?.body.get("scope")).toBe("User.Read openid offline_access")
  })

  it("sends no scope on a refresh that asks for nothing on the server's list", async () => {
    const { clientId, provider, server, tokens } = await signedIn()
    right(await refreshWith(server, clientId, tokens.refresh_token ?? "", "Mail.Send Files.ReadWrite.All"))
    expect(provider.requests[1]?.body.has("scope")).toBe(false)
  })

  it("chains: each new refresh token works once, and each new access token resolves", async () => {
    const { clientId, server, tokens } = await signedIn()
    const second = right(await refreshWith(server, clientId, tokens.refresh_token ?? ""))
    const third = right(await refreshWith(server, clientId, second.refresh_token ?? ""))
    expect((await server.resolve(third.access_token)).orUndefined()?.accessToken).toBe("access-3")
    expect(left(await refreshWith(server, clientId, second.refresh_token ?? ""))._tag).toBe("InvalidGrant")
  })

  it("works on a store without an atomic take", async () => {
    const inner = createMemoryStore()
    const { take: _take, ...noTake } = inner
    const env = setup({ store: noTake })
    const { client_id } = await register(env.server)
    const tokens = await issueTokens(env.server, client_id)
    expect((await refreshWith(env.server, client_id, tokens.refresh_token ?? "")).isRight()).toBe(true)
    inner.close?.()
  })
})

describe("widenScopesOnRefresh", () => {
  const before = ["openid", "offline_access", "User.Read"]
  const after = [...before, "Contacts.ReadWrite"]

  /** Signed in while the list was `before`, then refreshed on a server whose list is `after`. */
  const signedInBeforeTheListGrew = async (
    overrides: Parameters<typeof createTestServer>[1] = {},
    firstScopes: ReadonlyArray<string> = before,
  ) => {
    const provider = createFakeProvider()
    const store = overrides.store ?? createMemoryStore()
    const warnings: unknown[][] = []
    const errors: unknown[][] = []
    const first = make(provider, { encryptionKey: false, scopes: firstScopes, store })
    const { client_id } = await register(first)
    provider.queue(json({ access_token: "a1", expires_in: 3600, refresh_token: "r1", scope: "User.Read" }))
    const tokens = await issueTokens(first, client_id)
    first.close()
    const settings = {
      encryptionKey: false as const,
      logger: { error: (...a: unknown[]) => errors.push(a), warn: (...a: unknown[]) => warnings.push(a) },
      scopes: after,
      store,
      ...overrides,
    }
    const server = make(provider, settings)
    /** The same store and keys again, with other settings: a restart. */
    const restart = (more: Parameters<typeof createTestServer>[1]) => make(provider, { ...settings, ...more })
    return { clientId: client_id, errors, provider, restart, server, store, tokens, warnings }
  }
  const consentMissing = () => json({ error: "invalid_grant", error_description: "AADSTS65001: consent required" }, 400)
  const scopesSent = (provider: FakeProvider) => provider.requests.slice(1).map((r) => r.body.get("scope"))

  it("is off by default: a refresh asks for the grant, as before", async () => {
    const { clientId, provider, server, tokens } = await signedInBeforeTheListGrew()
    right(await refreshWith(server, clientId, tokens.refresh_token ?? ""))
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1]?.body.has("scope")).toBe(false)
  })

  it("asks for the whole list when the grant lacks some, and keeps what the provider reports", async () => {
    const { clientId, provider, server, tokens } = await signedInBeforeTheListGrew({ widenScopesOnRefresh: true })
    provider.queue(
      json({ access_token: "a2", expires_in: 3600, refresh_token: "r2", scope: "User.Read Contacts.ReadWrite" }),
    )
    const next = right(await refreshWith(server, clientId, tokens.refresh_token ?? ""))
    expect(provider.requests[1]?.body.get("scope")).toBe("openid offline_access User.Read Contacts.ReadWrite")
    expect(next.scope).toBe("User.Read Contacts.ReadWrite")
    expect(readClaims(next.access_token).orThrow().scope).toEqual(["User.Read", "Contacts.ReadWrite"])
    // The grant now has the whole list, so the refresh after asks for it as before.
    provider.queue(
      json({ access_token: "a3", expires_in: 3600, refresh_token: "r3", scope: "User.Read Contacts.ReadWrite" }),
    )
    right(await refreshWith(server, clientId, next.refresh_token ?? ""))
    expect(provider.requests[2]?.body.has("scope")).toBe(false)
  })

  it("asks again for the grant when the provider refuses the whole list, so the refresh still works", async () => {
    const { clientId, provider, server, tokens, warnings } = await signedInBeforeTheListGrew({
      widenScopesOnRefresh: true,
    })
    provider.queue(json({ error: "invalid_grant", error_description: "AADSTS65001: consent required" }, 400))
    provider.queue(json({ access_token: "a2", expires_in: 3600, refresh_token: "r2", scope: "User.Read" }))
    const next = right(await refreshWith(server, clientId, tokens.refresh_token ?? ""))
    expect(provider.requests.slice(1).map((r) => r.body.get("scope"))).toEqual([after.join(" "), null])
    expect(provider.requests[2]?.body.get("refresh_token")).toBe("r1")
    expect(next.scope).toBe("User.Read")
    expect(String(warnings[0]?.[0])).toContain("refused the server's scopes")
  })

  it("does not ask that sign-in for the same list again for a day once refused", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] })
    const { clientId, provider, server, tokens, warnings } = await signedInBeforeTheListGrew({
      widenScopesOnRefresh: true,
    })
    provider.queue(consentMissing())
    const second = right(await refreshWith(server, clientId, tokens.refresh_token ?? ""))
    const third = right(await refreshWith(server, clientId, second.refresh_token ?? ""))
    expect(scopesSent(provider)).toEqual([after.join(" "), null, null])
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0]?.[0])).toContain("(invalid_grant: AADSTS65001: consent required)")
    expect(String(warnings[0]?.[0])).toContain("will not widen this sign-in again for a day")
    vi.setSystemTime(1_800_000_000_000 + 86_399 * 1000)
    const fourth = right(await refreshWith(server, clientId, third.refresh_token ?? ""))
    expect(scopesSent(provider)[3]).toBeNull()
    vi.setSystemTime(1_800_000_000_000 + 86_401 * 1000)
    right(await refreshWith(server, clientId, fourth.refresh_token ?? ""))
    expect(scopesSent(provider)[4]).toBe(after.join(" "))
  })

  it("asks again within the day when the list has changed since the refusal", async () => {
    const { clientId, provider, restart, server, tokens } = await signedInBeforeTheListGrew({
      widenScopesOnRefresh: true,
    })
    provider.queue(consentMissing())
    const second = right(await refreshWith(server, clientId, tokens.refresh_token ?? ""))
    const grown = [...after, "Tasks.ReadWrite"]
    right(await refreshWith(restart({ scopes: grown }), clientId, second.refresh_token ?? ""))
    expect(scopesSent(provider)).toEqual([after.join(" "), null, grown.join(" ")])
  })

  it("does not remember a refusal that says nothing about consent", async () => {
    const { clientId, provider, server, tokens } = await signedInBeforeTheListGrew({ widenScopesOnRefresh: true })
    provider.queue(json({ error: "temporarily_unavailable" }, 503))
    const second = right(await refreshWith(server, clientId, tokens.refresh_token ?? ""))
    right(await refreshWith(server, clientId, second.refresh_token ?? ""))
    expect(scopesSent(provider)).toEqual([after.join(" "), null, after.join(" ")])
  })

  it("never fails a refresh because a refusal could not be saved or read", async () => {
    const inner = createMemoryStore()
    const failing: TokenStore = {
      ...inner,
      get: (key) => (key.startsWith("widen-declined:") ? Promise.reject(new Error("store down")) : inner.get(key)),
      save: (key, value, ttl) =>
        key.startsWith("widen-declined:") ? Promise.reject(new Error("store down")) : inner.save(key, value, ttl),
    }
    const { clientId, errors, provider, server, tokens } = await signedInBeforeTheListGrew({
      store: failing,
      widenScopesOnRefresh: true,
    })
    provider.queue(consentMissing())
    expect((await refreshWith(server, clientId, tokens.refresh_token ?? "")).isRight()).toBe(true)
    expect(errors.map((e) => String(e[0]))).toEqual([
      "[somamcp/oauth] could not read a refused widening; asking anyway:",
      "[somamcp/oauth] could not save a refused widening:",
    ])
    inner.close?.()
  })

  it("checks acceptSignIn on the id token a widened refresh brings, and ends a session it refuses", async () => {
    const idToken = (claims: Record<string, unknown>) =>
      [{ alg: "none" }, claims].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".x"
    // Signed in without openid, so with no id token and nothing to check until the list grows.
    const { clientId, provider, server, tokens } = await signedInBeforeTheListGrew(
      { acceptSignIn: () => "Not on the list.", widenScopesOnRefresh: true },
      ["offline_access", "User.Read"],
    )
    provider.queue(json({ access_token: "a2", id_token: idToken({ email: "x@example.com" }), refresh_token: "r2" }))
    expect(wire(await refreshWith(server, clientId, tokens.refresh_token ?? ""))).toEqual({
      code: "invalid_grant",
      description: "Not on the list.",
      status: 400,
    })
    expect(left(await refreshWith(server, clientId, tokens.refresh_token ?? ""))).toMatchObject({
      reason: "The refresh token was already used or has expired.",
    })
  })

  it("relays the provider's refusal when it refuses the grant too", async () => {
    const { clientId, provider, server, tokens } = await signedInBeforeTheListGrew({ widenScopesOnRefresh: true })
    provider.queue(json({ error: "invalid_grant", error_description: "AADSTS65001: consent required" }, 400))
    provider.queue(json({ error: "invalid_grant", error_description: "AADSTS70008: expired" }, 400))
    expect(wire(await refreshWith(server, clientId, tokens.refresh_token ?? ""))).toEqual({
      code: "invalid_grant",
      description: "AADSTS70008: expired",
      status: 400,
    })
    expect(provider.requests).toHaveLength(3)
  })

  it("does not ask twice when the provider could not be reached, and leaves the refresh token usable", async () => {
    const { clientId, provider, server, tokens } = await signedInBeforeTheListGrew({ widenScopesOnRefresh: true })
    provider.queue(new Response("bad gateway", { status: 502 }))
    expect(wire(await refreshWith(server, clientId, tokens.refresh_token ?? "")).code).toBe("server_error")
    expect(provider.requests).toHaveLength(2)
    expect((await refreshWith(server, clientId, tokens.refresh_token ?? "")).isRight()).toBe(true)
  })

  it("never lets a client add to its grant: a refresh that names a scope is narrowed to the grant", async () => {
    const { clientId, provider, server, tokens } = await signedInBeforeTheListGrew({ widenScopesOnRefresh: true })
    right(await refreshWith(server, clientId, tokens.refresh_token ?? "", "User.Read Contacts.ReadWrite"))
    expect(provider.requests).toHaveLength(2)
    expect(provider.requests[1]?.body.get("scope")).toBe("User.Read openid offline_access")
  })

  it("does not widen for openid or offline_access alone, which providers often leave out of the grant", async () => {
    const { clientId, provider, server, tokens } = await signedInBeforeTheListGrew({
      scopes: before,
      widenScopesOnRefresh: true,
    })
    right(await refreshWith(server, clientId, tokens.refresh_token ?? ""))
    expect(provider.requests[1]?.body.has("scope")).toBe(false)
  })
})

describe("authenticating to the provider's token endpoint", () => {
  const firstRequest = async (provider: FakeProvider, server: TestServer) => {
    const { client_id } = await register(server)
    await issueTokens(server, client_id)
    return provider.requests[0]
  }

  it("uses HTTP Basic by default, with each part form-encoded (RFC 6749 §2.3.1)", async () => {
    const provider = createFakeProvider()
    const server = make(provider, {
      upstream: {
        authorizationEndpoint: "https://login.example/authorize",
        clientId: "id with space",
        clientSecret: "s3cr3t:&=~",
        name: "Example",
        tokenEndpoint: TOKEN,
      },
    })
    const request = await firstRequest(provider, server)
    expect(request?.url).toBe(TOKEN)
    expect(request?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from(`${encodeURIComponent("id with space")}:${encodeURIComponent("s3cr3t:&=~")}`).toString("base64")}`,
    )
    expect(request?.body.has("client_secret")).toBe(false)
  })

  it("sends the credentials in the body for client_secret_post", async () => {
    const provider = createFakeProvider()
    const server = make(provider, {
      upstream: {
        authorizationEndpoint: "https://login.example/authorize",
        clientAuthentication: "client_secret_post",
        clientId: "upstream-client",
        clientSecret: "upstream-secret",
        name: "Example",
        tokenEndpoint: TOKEN,
      },
    })
    const request = await firstRequest(provider, server)
    expect(request?.headers.has("authorization")).toBe(false)
    expect(request?.body.get("client_id")).toBe("upstream-client")
    expect(request?.body.get("client_secret")).toBe("upstream-secret")
  })

  it("authenticates the same way when refreshing", async () => {
    const provider = createFakeProvider()
    const server = make(provider)
    const { client_id } = await register(server)
    const tokens = await issueTokens(server, client_id)
    await refreshWith(server, client_id, tokens.refresh_token ?? "")
    expect(provider.requests[1]?.headers.get("authorization")).toMatch(/^Basic /)
  })
})

describe("each token's type (token_use)", () => {
  const signedIn = async () => {
    const env = setup()
    const { client_id } = await register(env.server)
    return { ...env, clientId: client_id, tokens: await issueTokens(env.server, client_id) }
  }

  it("marks the access token access and the refresh token refresh", async () => {
    const { tokens } = await signedIn()
    expect(readClaims(tokens.access_token).orThrow().token_use).toBe("access")
    expect(readClaims(tokens.refresh_token ?? "").orThrow().token_use).toBe("refresh")
  })

  it("refuses an access token as a refresh token, and leaves the real refresh token usable", async () => {
    const { clientId, provider, server, tokens } = await signedIn()
    expect(left(await refreshWith(server, clientId, tokens.access_token))._tag).toBe("InvalidGrant")
    // Refused before the provider was called or anything was spent.
    expect(provider.requests).toHaveLength(1)
    expect((await refreshWith(server, clientId, tokens.refresh_token ?? "")).isRight()).toBe(true)
  })

  it("does not resolve a refresh token as a bearer token", async () => {
    const { server, tokens } = await signedIn()
    expect((await server.resolve(tokens.refresh_token ?? "")).isNone()).toBe(true)
    expect((await server.resolve(tokens.access_token)).isSome()).toBe(true)
  })
})

describe("claims in the issued tokens", () => {
  const jwt = (claims: Record<string, unknown>) =>
    `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.x`
  const graphLike = { ipaddr: "203.0.113.7", name: "Avery Example", oid: "u-1", scp: "Mail.Read", upn: "a@x.test" }

  it("carry none of the provider's by default, even when its access token is a readable JWT", async () => {
    const { provider, server } = setup()
    provider.queue(json({ access_token: jwt(graphLike), expires_in: 3600, refresh_token: "r" }))
    const { client_id } = await register(server)
    const tokens = await issueTokens(server, client_id)
    expect(Object.keys(readClaims(tokens.access_token).orThrow())).toEqual([
      "aud",
      "client_id",
      "exp",
      "iat",
      "iss",
      "jti",
      "scope",
      "token_use",
    ])
  })

  it("carry them when claims are turned on, and never let one replace token_use", async () => {
    const { provider, server } = setup({ claims: true })
    provider.queue(json({ access_token: jwt({ ...graphLike, token_use: "refresh" }), expires_in: 3600 }))
    const { client_id } = await register(server)
    const claims = readClaims((await issueTokens(server, client_id)).access_token).orThrow()
    expect(claims).toMatchObject({ name: "Avery Example", oid: "u-1", token_use: "access" })
  })
})

describe("acceptSignIn on a refresh", () => {
  const idToken = (claims: Record<string, unknown>) =>
    [{ alg: "none" }, claims].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".x"
  const onlyOk = (claims: Readonly<Record<string, unknown>>) =>
    claims.email === "ok@example.com" ? undefined : "Not on the list."

  /** Signed in on one server, refreshed on another with the same store and keys: a restart with new settings. */
  const signedInThenRestarted = async (
    first: Parameters<typeof createTestServer>[1],
    second: Parameters<typeof createTestServer>[1],
    signInAnswer?: Response,
  ) => {
    const provider = createFakeProvider()
    const store = createMemoryStore()
    const before = make(provider, { encryptionKey: false, store, ...first })
    const { client_id } = await register(before)
    if (signInAnswer) provider.queue(signInAnswer)
    const tokens = await issueTokens(before, client_id)
    before.close()
    const after = make(provider, { encryptionKey: false, store, ...second })
    return { after, clientId: client_id, provider, tokens }
  }

  it("ends the session, with invalid_grant, once the rule refuses the account, and does not put the token back", async () => {
    const { after, clientId, tokens } = await signedInThenRestarted(
      {},
      { acceptSignIn: onlyOk },
      json({ access_token: "a", id_token: idToken({ email: "other@example.com" }), refresh_token: "r" }),
    )
    const refused = await refreshWith(after, clientId, tokens.refresh_token ?? "")
    expect(wire(refused)).toEqual({ code: "invalid_grant", description: "Not on the list.", status: 400 })
    expect(left(await refreshWith(after, clientId, tokens.refresh_token ?? ""))).toEqual({
      _tag: "InvalidGrant",
      reason: "The refresh token was already used or has expired.",
    })
    // Nothing from the refused refresh is kept; the access token already issued lasts its hour.
    expect((await after.resolve(tokens.access_token)).orUndefined()?.accessToken).toBe("a")
  })

  it("keeps refreshing an account the rule accepts", async () => {
    const { after, clientId, tokens } = await signedInThenRestarted(
      {},
      { acceptSignIn: onlyOk },
      json({ access_token: "a", id_token: idToken({ email: "ok@example.com" }), refresh_token: "r" }),
    )
    expect((await refreshWith(after, clientId, tokens.refresh_token ?? "")).isRight()).toBe(true)
  })

  it("judges the id token the refresh brought, when it brought one", async () => {
    const accept = vi.fn(onlyOk)
    const env = setup({ acceptSignIn: accept })
    const { client_id } = await register(env.server)
    env.provider.queue(json({ access_token: "a", id_token: idToken({ email: "ok@example.com" }), refresh_token: "r" }))
    const tokens = await issueTokens(env.server, client_id)
    env.provider.queue(
      json({ access_token: "b", id_token: idToken({ email: "moved@example.com" }), refresh_token: "s" }),
    )
    expect(wire(await refreshWith(env.server, client_id, tokens.refresh_token ?? "")).description).toBe(
      "Not on the list.",
    )
    expect(accept.mock.calls.map(([claims]) => claims.email)).toEqual(["ok@example.com", "moved@example.com"])
  })

  it("lets through a session signed in without an id token, so adding openid and a rule signs no one out", async () => {
    const accept = vi.fn(() => "Refuses everyone.")
    const { after, clientId, tokens } = await signedInThenRestarted(
      { scopes: ["User.Read"] },
      { acceptSignIn: accept, scopes: ["openid", "User.Read"] },
    )
    expect((await refreshWith(after, clientId, tokens.refresh_token ?? "")).isRight()).toBe(true)
    expect(accept).not.toHaveBeenCalled()
  })

  it("still puts the token back when the provider fails, with a rule set", async () => {
    const env = setup({ acceptSignIn: onlyOk })
    const { client_id } = await register(env.server)
    env.provider.queue(json({ access_token: "a", id_token: idToken({ email: "ok@example.com" }), refresh_token: "r" }))
    const tokens = await issueTokens(env.server, client_id)
    env.provider.queue(json({ error: "temporarily_unavailable" }, 503))
    expect((await refreshWith(env.server, client_id, tokens.refresh_token ?? "")).isLeft()).toBe(true)
    expect((await refreshWith(env.server, client_id, tokens.refresh_token ?? "")).isRight()).toBe(true)
  })
})

describe("how long a registered client is kept", () => {
  const NINETY_DAYS = 90 * 24 * 60 * 60
  const clientSaves = (saves: ReturnType<typeof setup>["saves"], clientId: string) =>
    saves.filter((s) => s.key === `client:${clientId}`).map((s) => s.ttl)

  it("90 days from registration by default", async () => {
    const { saves, server } = setup()
    const { client_id } = await register(server)
    expect(clientSaves(saves, client_id)).toEqual([NINETY_DAYS])
  })

  it("starts over at each completed sign-in and refresh", async () => {
    const { saves, server } = setup()
    const { client_id } = await register(server)
    const tokens = await issueTokens(server, client_id)
    // registration, then the code's redemption
    expect(clientSaves(saves, client_id)).toEqual([NINETY_DAYS, NINETY_DAYS])
    right(await refreshWith(server, client_id, tokens.refresh_token ?? ""))
    expect(clientSaves(saves, client_id)).toEqual([NINETY_DAYS, NINETY_DAYS, NINETY_DAYS])
  })

  it("not for an authorize alone, which anyone can send with a client's public id", async () => {
    const { saves, server } = setup()
    const { client_id } = await register(server)
    await authorize(server, client_id, pkcePair().challenge)
    await authorize(server, client_id, pkcePair().challenge, { redirect_uri: "https://elsewhere.example/cb" })
    expect(clientSaves(saves, client_id)).toEqual([NINETY_DAYS])
  })

  it("for lifetimes.client when set", async () => {
    const { saves, server } = setup({ lifetimes: { client: 3_600_000, refreshToken: 3_600 } })
    const { client_id } = await register(server)
    expect(clientSaves(saves, client_id)).toEqual([3_600_000])
  })

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["unset", undefined],
  ])("for the default when lifetimes.client is %s, never for ever", async (_name, client) => {
    const { saves, server } = setup({ lifetimes: { client } })
    const { client_id } = await register(server)
    expect(clientSaves(saves, client_id)).toEqual([NINETY_DAYS])
  })

  it("warns when it is shorter than the refresh token's lifetime", () => {
    const warn = vi.fn()
    setup({ lifetimes: { client: 60 }, logger: { error: () => {}, warn } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("lifetimes.client is shorter"))
  })

  it("forgets a client the store has dropped, while its refresh tokens keep working", async () => {
    const { server, store } = setup()
    const { client_id } = await register(server)
    const tokens = await issueTokens(server, client_id)
    await store.delete(`client:${client_id}`)
    expect(left(await authorize(server, client_id, pkcePair().challenge))).toEqual({
      _tag: "UnknownClient",
      clientId: client_id,
    })
    expect((await refreshWith(server, client_id, tokens.refresh_token ?? "")).isRight()).toBe(true)
    expect(await store.get(`client:${client_id}`)).toBeUndefined()
  })

  it("gives a client FastMCP saved with no expiry one on its next use", async () => {
    const { saves, server, store } = setup()
    await store.save("client:from-fastmcp", {
      callbackUrl: "https://claude.ai/api/mcp/auth_callback",
      clientId: "from-fastmcp",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      registeredAt: new Date().toISOString(),
    })
    await issueTokens(server, "from-fastmcp")
    expect(clientSaves(saves, "from-fastmcp")).toEqual([undefined, NINETY_DAYS])
  })

  it("never fails a refresh because the client could not be saved again", async () => {
    const env = setup()
    const { client_id } = await register(env.server)
    const tokens = await issueTokens(env.server, client_id)
    const save = env.store.save
    env.store.save = (key, value, ttl) =>
      key.startsWith("client:") ? Promise.reject(new Error("disk full")) : save(key, value, ttl)
    expect((await refreshWith(env.server, client_id, tokens.refresh_token ?? "")).isRight()).toBe(true)
  })
})
