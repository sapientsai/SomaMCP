// What the OAuth proxy stores: registered clients, authorization codes and transactions.
// Ported from fastmcp 4.22.10 (MIT, src/auth/OAuthProxyStateStore.ts). Keys and record
// shapes are FastMCP's, so records it wrote read back here.
import { Map, Option, Ref, Tuple } from "functype"
import { z } from "zod"

import type { TokenStorage } from "./storage.js"

export const KEY_PREFIX = { client: "client:", code: "code:", transaction: "transaction:" } as const

// Dates round-trip through JSON as ISO strings.
const storedDate = z.union([z.date(), z.string()]).transform((value, context) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    context.addIssue({ code: "custom", message: "Invalid stored date" })
    return z.NEVER
  }
  return date
})

const clientMetadataSchema = z.object({
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

const registeredClientSchema = z.object({
  callbackUrl: z.string(),
  clientId: z.string(),
  clientSecret: z.string().optional(),
  expiresAt: storedDate.optional(),
  metadata: clientMetadataSchema.optional(),
  redirectUris: z.array(z.string()),
  registeredAt: storedDate,
  source: z.literal("cimd").optional(),
})

const upstreamTokenSetSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
  idToken: z.string().optional(),
  issuedAt: storedDate,
  refreshExpiresIn: z.number().optional(),
  refreshToken: z.string().optional(),
  scope: z.array(z.string()),
  tokenType: z.string(),
})

const clientCodeSchema = z.object({
  clientId: z.string(),
  code: z.string(),
  codeChallenge: z.string(),
  codeChallengeMethod: z.string(),
  createdAt: storedDate,
  expiresAt: storedDate,
  transactionId: z.string(),
  upstreamTokens: upstreamTokenSetSchema,
  used: z.boolean().optional(),
})

const spentCodeSchema = z.object({ expiresAt: storedDate, used: z.literal(true) })

const transactionSchema = z.object({
  clientCallbackUrl: z.string(),
  clientCodeChallenge: z.string(),
  clientCodeChallengeMethod: z.string(),
  clientId: z.string(),
  consentGiven: z.boolean().optional(),
  createdAt: storedDate,
  expiresAt: storedDate,
  id: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  proxyCodeChallenge: z.string(),
  proxyCodeVerifier: z.string(),
  scope: z.array(z.string()),
  state: z.string(),
})

export type RegisteredClient = z.infer<typeof registeredClientSchema>
export type UpstreamTokenSet = z.infer<typeof upstreamTokenSetSchema>
export type ClientCode = z.infer<typeof clientCodeSchema>
export type OAuthTransaction = z.infer<typeof transactionSchema>

export type ConsumedCode =
  { clientCode: ClientCode; expiresAt: Date; status: "active" } | { expiresAt: Date; status: "spent" }

const isExpired = (expiresAt: Date): boolean => expiresAt.getTime() < Date.now()
const ttlSeconds = (expiresAt: Date): number => Math.max(Math.ceil((expiresAt.getTime() - Date.now()) / 1000), 1)

const parse = <S extends z.ZodType>(schema: S, value: unknown): Option<z.infer<S>> => {
  const parsed = schema.safeParse(value)
  return parsed.success ? Option(parsed.data as z.infer<S>) : Option.none()
}

export type StateStore = ReturnType<typeof createStateStore>

export const createStateStore = (storage: TokenStorage) => {
  // A DCR registration never changes once written, so a local copy cannot go stale.
  // It is also persisted, so other instances, and this one after a restart, find it.
  const clients = Ref(Map.empty<string, RegisteredClient>())

  /** Prefer the storage's atomic take; get + delete leaves a window between processes. */
  const take = async (key: string): Promise<unknown> => {
    if (storage.take) return storage.take(key)
    const stored = await storage.get(key)
    if (stored !== null) await storage.delete(key)
    return stored
  }

  const cacheClient = (client: RegisteredClient): void => {
    clients.set(clients.get().add(Tuple<[string, RegisteredClient]>([client.clientId, client])))
  }

  return {
    cacheClient,

    clear: (): void => {
      clients.set(Map.empty())
    },

    /**
     * Atomically consume an authorization code, so at most one caller ever redeems it.
     * Spent codes are taken too: the caller writes the tombstone back with `markCodeSpent`.
     */
    consumeCode: async (code: string): Promise<Option<ConsumedCode>> => {
      const stored = await take(`${KEY_PREFIX.code}${code}`)
      return parse(spentCodeSchema, stored).fold(
        () =>
          parse(clientCodeSchema, stored)
            .filter((clientCode) => !isExpired(clientCode.expiresAt))
            .map((clientCode): ConsumedCode => ({ clientCode, expiresAt: clientCode.expiresAt, status: "active" })),
        (spent) =>
          isExpired(spent.expiresAt)
            ? Option.none<ConsumedCode>()
            : Option<ConsumedCode>({ expiresAt: spent.expiresAt, status: "spent" }),
      )
    },

    /** Atomically consume a transaction, so a callback is redeemed once on any instance. */
    consumeTransaction: async (id: string): Promise<Option<OAuthTransaction>> =>
      parse(transactionSchema, await take(`${KEY_PREFIX.transaction}${id}`)).filter(
        (transaction) => !isExpired(transaction.expiresAt),
      ),

    deleteTransaction: (id: string): Promise<void> => storage.delete(`${KEY_PREFIX.transaction}${id}`),

    getClient: async (clientId: string): Promise<Option<RegisteredClient>> => {
      const cached = clients
        .get()
        .get(clientId)
        .filter((client) => !client.expiresAt || !isExpired(client.expiresAt))
      if (cached.isSome()) return cached
      clients.set(clients.get().remove(clientId))
      const stored = parse(registeredClientSchema, await storage.get(`${KEY_PREFIX.client}${clientId}`))
      if (stored.exists((client) => client.expiresAt !== undefined && isExpired(client.expiresAt))) {
        await storage.delete(`${KEY_PREFIX.client}${clientId}`)
        return Option.none()
      }
      stored.forEach(cacheClient)
      return stored
    },

    /** Read a transaction without consuming it, for the consent screen. */
    getTransaction: async (id: string): Promise<Option<OAuthTransaction>> => {
      const stored = parse(transactionSchema, await storage.get(`${KEY_PREFIX.transaction}${id}`))
      if (stored.exists((transaction) => isExpired(transaction.expiresAt))) {
        await storage.delete(`${KEY_PREFIX.transaction}${id}`)
        return Option.none()
      }
      return stored
    },

    /** Leave a tombstone, so a second redemption is "already used", not "unknown". */
    markCodeSpent: (code: string, expiresAt: Date): Promise<void> =>
      storage.save(`${KEY_PREFIX.code}${code}`, { expiresAt, used: true }, ttlSeconds(expiresAt)),

    saveClient: (client: RegisteredClient): Promise<void> =>
      storage.save(
        `${KEY_PREFIX.client}${client.clientId}`,
        client,
        client.expiresAt ? ttlSeconds(client.expiresAt) : undefined,
      ),

    saveCode: (clientCode: ClientCode): Promise<void> =>
      storage.save(`${KEY_PREFIX.code}${clientCode.code}`, clientCode, ttlSeconds(clientCode.expiresAt)),

    saveTransaction: (transaction: OAuthTransaction): Promise<void> =>
      storage.save(`${KEY_PREFIX.transaction}${transaction.id}`, transaction, ttlSeconds(transaction.expiresAt)),
  }
}
