// Several instances behind a load balancer share one store, and any of them may get any
// step of a sign-in. These run every step on a different instance.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { createAuthorizationServer } from "../../../src/node/oauth/server.js"
import { createDiskStore } from "../../../src/node/oauth/stores/disk.js"
import { createMemoryStore } from "../../../src/node/oauth/stores/memory.js"
import type { TokenStore } from "../../../src/node/oauth/stores/types.js"
import {
  authorize,
  consentOf,
  createFakeProvider,
  createTestServer,
  left,
  pkcePair,
  providerCallback,
  quiet,
  redirectOf,
  register,
  right,
  signIn,
  type TestServer,
} from "./harness.js"

const servers: TestServer[] = []
const closers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  servers.splice(0).forEach((s) => s.close())
  await Promise.all(closers.splice(0).map((close) => close()))
  vi.useRealTimers()
})

const instances = (count: number, store: TokenStore) => {
  const provider = createFakeProvider()
  return Array.from({ length: count }, () => {
    const server = createTestServer(provider, { store })
    servers.push(server)
    return server
  })
}

describe.each([
  ["memory", () => Promise.resolve(createMemoryStore())],
  [
    "disk",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "somamcp-instances-"))
      const store = createDiskStore({ directory })
      closers.push(async () => {
        store.close?.()
        await rm(directory, { force: true, recursive: true })
      })
      return store
    },
  ],
])("instances sharing a %s store", (_kind, makeStore) => {
  it("find a client another instance registered", async () => {
    const [a, b] = instances(2, await makeStore()) as [TestServer, TestServer]
    const { client_id } = await register(a)
    expect(right(await authorize(b, client_id, pkcePair().challenge))._tag).toBe("Consent")
  })

  it("carry a sign-in through, a different instance for each step", async () => {
    const [registrar, authorizer, consenter, callback, tokens, resolver] = instances(
      6,
      await makeStore(),
    ) as TestServer[] as [TestServer, TestServer, TestServer, TestServer, TestServer, TestServer]
    const { client_id } = await register(registrar)
    const pkce = pkcePair()
    const screen = consentOf(right(await authorize(authorizer, client_id, pkce.challenge)))
    const upstream = redirectOf(
      right(await consenter.decide(new URLSearchParams({ action: "approve", transaction_id: screen.transactionId }))),
    )
    const code = redirectOf(right(await callback.callback(providerCallback(upstream)))).searchParams.get("code") ?? ""
    const issued = right(
      await tokens.token({ clientId: client_id, code, codeVerifier: pkce.verifier, grantType: "authorization_code" }),
    )
    expect((await resolver.resolve(issued.access_token)).orUndefined()?.accessToken).toBe("access-1")
  })

  it("redeem a code exactly once when two race for it", async () => {
    const [a, b] = instances(2, await makeStore()) as [TestServer, TestServer]
    const { client_id } = await register(a)
    const { code, verifier } = await signIn(a, client_id)
    const request = { clientId: client_id, code, codeVerifier: verifier, grantType: "authorization_code" }
    const results = await Promise.all([a.token(request), b.token(request), a.token(request), b.token(request)])
    expect(results.filter((r) => r.isRight())).toHaveLength(1)
  })

  it("tell the loser the code was already used, not that it is unknown", async () => {
    const [a, b] = instances(2, await makeStore()) as [TestServer, TestServer]
    const { client_id } = await register(a)
    const { code, verifier } = await signIn(a, client_id)
    right(await a.token({ clientId: client_id, code, codeVerifier: verifier, grantType: "authorization_code" }))
    expect(
      left(await b.token({ clientId: client_id, code, codeVerifier: verifier, grantType: "authorization_code" })),
    ).toMatchObject({
      reason: "The authorization code was already used.",
    })
  })

  it("complete a sign-in once, whichever instance the callback reaches", async () => {
    const [a, b] = instances(2, await makeStore()) as [TestServer, TestServer]
    const { client_id } = await register(a)
    const screen = consentOf(right(await authorize(a, client_id, pkcePair().challenge)))
    const upstream = redirectOf(
      right(await a.decide(new URLSearchParams({ action: "approve", transaction_id: screen.transactionId }))),
    )
    const outcomes = await Promise.all([a.callback(providerCallback(upstream)), b.callback(providerCallback(upstream))])
    expect(outcomes.filter((o) => o.isRight())).toHaveLength(1)
  })
})

describe("closing the server", () => {
  const withoutStore = () =>
    createAuthorizationServer({
      baseUrl: "https://mcp.test",
      jwtSigningKey: "k",
      logger: quiet,
      scopes: [],
      upstream: {
        authorizationEndpoint: "https://a.test",
        clientId: "c",
        clientSecret: "s",
        name: "A",
        tokenEndpoint: "https://t.test",
      },
    })

  it("stops its own timers and the store it made", () => {
    vi.useFakeTimers()
    const before = vi.getTimerCount()
    const server = withoutStore()
    // Its own cleanup timer, and the memory store's.
    expect(vi.getTimerCount()).toBe(before + 2)
    server.close()
    expect(vi.getTimerCount()).toBe(before)
  })

  it("leaves a store it was given running", () => {
    vi.useFakeTimers()
    const store = createMemoryStore()
    const close = vi.spyOn(store, "close")
    const server = createTestServer(createFakeProvider(), { store })
    server.close()
    expect(close).not.toHaveBeenCalled()
    store.close?.()
  })

  it("can be called twice", () => {
    const server = withoutStore()
    server.close()
    expect(() => server.close()).not.toThrow()
  })
})
