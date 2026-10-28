// What the authorization server keeps in its store, and under which keys.
//
// This is a compatibility contract. The keys and record shapes match what FastMCP 4.22.10
// stores, so a store it wrote reads here and the reverse, and a server moved off FastMCP
// keeps every user signed in. test/node/oauth-compat.test.ts and
// test/fixtures/fastmcp-4.22.10-oauth/xcheck.mjs hold it in place: change a field name or a
// prefix here and they fail.
import { Option } from "functype"
import { z } from "zod"

import type { TokenStore } from "./stores/types.js"

const KEY = {
  client: "client:",
  code: "code:",
  grant: "mapping:",
  pending: "transaction:",
  upstream: "upstream:",
} as const

/** A `Date` in memory; on disk, the ISO string `JSON.stringify` made of it. */
const date = z.coerce.date()

const clientSchema = z.object({
  callbackUrl: z.string(),
  clientId: z.string(),
  clientSecret: z.string().optional(),
  /** Only on clients FastMCP resolved from a metadata document; such a record lapses. */
  expiresAt: date.optional(),
  metadata: z
    .object({
      client_name: z.string().optional(),
      client_uri: z.string().optional(),
      contacts: z.array(z.string()).optional(),
      jwks: z.record(z.string(), z.unknown()).optional(),
      jwks_uri: z.string().optional(),
      logo_uri: z.string().optional(),
      policy_uri: z.string().optional(),
      scope: z.string().optional(),
      software_id: z.string().optional(),
      software_version: z.string().optional(),
      tos_uri: z.string().optional(),
    })
    .optional(),
  redirectUris: z.array(z.string()),
  registeredAt: date,
  source: z.literal("cimd").optional(),
})

const upstreamTokensSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
  idToken: z.string().optional(),
  issuedAt: date,
  refreshExpiresIn: z.number().optional(),
  refreshToken: z.string().optional(),
  scope: z.array(z.string()),
  tokenType: z.string(),
})

/** An authorization request between `/oauth/authorize` and the upstream callback. */
const pendingSchema = z.object({
  clientCallbackUrl: z.string(),
  clientCodeChallenge: z.string(),
  clientCodeChallengeMethod: z.string(),
  clientId: z.string(),
  consentGiven: z.boolean().optional(),
  createdAt: date,
  expiresAt: date,
  id: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** The PKCE pair the server itself uses with the upstream provider. */
  proxyCodeChallenge: z.string(),
  proxyCodeVerifier: z.string(),
  scope: z.array(z.string()),
  state: z.string(),
})

const codeSchema = z.object({
  clientId: z.string(),
  code: z.string(),
  codeChallenge: z.string(),
  codeChallengeMethod: z.string(),
  createdAt: date,
  expiresAt: date,
  transactionId: z.string(),
  upstreamTokens: upstreamTokensSchema,
  used: z.boolean().optional(),
})

/** The marker under a redeemed code's key, so `redeem` can tell a replay from a typo. */
const spentSchema = z.object({ expiresAt: date, used: z.literal(true) })

/** Ties one of the server's JWTs, by its `jti`, to the upstream tokens it stands for. */
const grantSchema = z.object({
  clientId: z.string(),
  createdAt: date,
  expiresAt: date,
  jti: z.string(),
  scope: z.array(z.string()),
  upstreamTokenKey: z.string(),
})

export type RegisteredClient = z.infer<typeof clientSchema>
export type UpstreamTokens = z.infer<typeof upstreamTokensSchema>
export type PendingAuthorization = z.infer<typeof pendingSchema>
export type AuthorizationCode = z.infer<typeof codeSchema>
export type TokenGrant = z.infer<typeof grantSchema>

export type Redemption =
  { readonly _tag: "Active"; readonly code: AuthorizationCode } | { readonly _tag: "Spent"; readonly expiresAt: Date }

const decode = <S extends z.ZodType>(schema: S, value: unknown): Option<z.infer<S>> => {
  const parsed = schema.safeParse(value)
  return parsed.success ? Option(parsed.data as z.infer<S>) : Option.none()
}

const lapsed = (at: Date): boolean => at.getTime() < Date.now()

/** Whole seconds until `at`, and at least one, for a store's `ttl`. */
export const secondsUntil = (at: Date): number => Math.max(Math.ceil((at.getTime() - Date.now()) / 1000), 1)

export type Records = ReturnType<typeof createRecords>

export const createRecords = (store: TokenStore) => {
  /** Read and delete, atomically when the store can. */
  const take = async (key: string): Promise<unknown> => {
    if (store.take) return store.take(key)
    const value = await store.get(key)
    await store.delete(key)
    return value
  }

  // No cache in front: a client lasts as long as the store keeps it, and every instance sees the same.
  const clients = {
    find: async (clientId: string): Promise<Option<RegisteredClient>> => {
      const stored = decode(clientSchema, await store.get(`${KEY.client}${clientId}`))
      // Only clients FastMCP fetched from a metadata document have an expiresAt; this server never writes one.
      if (stored.exists((client) => client.expiresAt !== undefined && lapsed(client.expiresAt))) {
        await store.delete(`${KEY.client}${clientId}`)
        return Option.none()
      }
      return stored
    },
    /** Kept for `ttl` seconds from now; saving it again starts the time over. */
    save: (client: RegisteredClient, ttl: number): Promise<void> =>
      store.save(`${KEY.client}${client.clientId}`, client, ttl),
  }

  const pending = {
    delete: (id: string): Promise<void> => store.delete(`${KEY.pending}${id}`),
    /** For the consent step, which updates the request rather than ending it. */
    find: async (id: string): Promise<Option<PendingAuthorization>> =>
      decode(pendingSchema, await store.get(`${KEY.pending}${id}`)).filter((p) => !lapsed(p.expiresAt)),
    save: (request: PendingAuthorization): Promise<void> =>
      store.save(`${KEY.pending}${request.id}`, request, secondsUntil(request.expiresAt)),
    /** For the callback: the request ends here, and a replayed callback finds nothing. */
    take: async (id: string): Promise<Option<PendingAuthorization>> =>
      decode(pendingSchema, await take(`${KEY.pending}${id}`)).filter((p) => !lapsed(p.expiresAt)),
  }

  const codes = {
    /**
     * Removes the code and returns what it held. Removal goes through `take`, so concurrent
     * redemptions resolve to one winner; the caller then writes the spent marker in its place.
     */
    redeem: async (code: string): Promise<Option<Redemption>> => {
      const stored = await take(`${KEY.code}${code}`)
      const spent = decode(spentSchema, stored)
      if (spent.isSome())
        return spent
          .filter((s) => !lapsed(s.expiresAt))
          .map((s): Redemption => ({ _tag: "Spent", expiresAt: s.expiresAt }))
      return decode(codeSchema, stored)
        .filter((c) => !lapsed(c.expiresAt))
        .map((c): Redemption => ({ _tag: "Active", code: c }))
    },
    save: (code: AuthorizationCode): Promise<void> =>
      store.save(`${KEY.code}${code.code}`, code, secondsUntil(code.expiresAt)),
    /** The tombstone carries no tokens, and lapses when the code would have. */
    spend: (code: string, expiresAt: Date): Promise<void> =>
      store.save(`${KEY.code}${code}`, { expiresAt, used: true }, secondsUntil(expiresAt)),
  }

  const grants = {
    find: async (jti: string): Promise<Option<TokenGrant>> =>
      decode(grantSchema, await store.get(`${KEY.grant}${jti}`)),
    save: (grant: TokenGrant, ttl: number): Promise<void> => store.save(`${KEY.grant}${grant.jti}`, grant, ttl),
    take: async (jti: string): Promise<Option<TokenGrant>> => decode(grantSchema, await take(`${KEY.grant}${jti}`)),
  }

  const upstream = {
    find: async (key: string): Promise<Option<UpstreamTokens>> =>
      decode(upstreamTokensSchema, await store.get(`${KEY.upstream}${key}`)),
    save: (key: string, tokens: UpstreamTokens, ttl: number): Promise<void> =>
      store.save(`${KEY.upstream}${key}`, tokens, ttl),
  }

  return { clients, codes, grants, pending, upstream }
}
