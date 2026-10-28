// Dynamic client registration (RFC 7591), and which redirect URIs a client may register.
import type { Either } from "functype"
import { Left, Option, Right, Try } from "functype"
import { z } from "zod"

import { OAuthError } from "./errors.js"
import type { Records, RegisteredClient } from "./records.js"
import { randomHex, randomToken } from "./secrets.js"

/** With no patterns configured, only loopback redirect URIs, for native clients (RFC 8252 §7.3). */
const LOOPBACK_ONLY = ["http://localhost:*", "http://127.0.0.1:*"]

/**
 * A glob as an anchored regular expression: `*` matches any run of characters, `?` exactly
 * one, and everything else only itself.
 */
const globToRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${[...pattern]
      .map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("")}$`,
  )

/**
 * Whether a client may register `uri`. It must be an absolute URL with no user name or
 * password in it (`https://claude.ai@evil.example` hides its real host there), and match
 * one of `patterns`. Unset patterns allow loopback only; an empty list allows nothing.
 */
export const isAllowedRedirectUri = (uri: string, patterns: Option<ReadonlyArray<string>>): boolean => {
  const url = Try(() => new URL(uri)).toOption()
  if (!url.exists((u) => u.username === "" && u.password === "")) return false
  return patterns.orElse(LOOPBACK_ONLY).some((pattern) => globToRegExp(pattern).test(uri))
}

const optionalString = z.string().optional()

const registrationSchema = z.object({
  client_name: optionalString,
  client_uri: optionalString,
  contacts: z.array(z.string()).optional(),
  grant_types: z.array(z.string()).optional(),
  jwks: z.record(z.string(), z.unknown()).optional(),
  jwks_uri: optionalString,
  logo_uri: optionalString,
  policy_uri: optionalString,
  redirect_uris: z.array(z.string()).min(1),
  response_types: z.array(z.string()).optional(),
  scope: optionalString,
  software_id: optionalString,
  software_version: optionalString,
  token_endpoint_auth_method: optionalString,
  tos_uri: optionalString,
})

export type ClientRegistration = z.infer<typeof registrationSchema>

export type RegistrationResponse = ClientRegistration & {
  client_id: string
  client_id_issued_at: number
  client_secret: string
  client_secret_expires_at: 0
  grant_types: ReadonlyArray<string>
  response_types: ReadonlyArray<string>
  token_endpoint_auth_method: string
}

/**
 * `lifetime` is how long, in seconds, a client is kept after it was registered or last used. A
 * client nobody signs in with or refreshes for that long is forgotten, so open registration
 * cannot fill the store.
 */
export const createClientRegistry = (records: Records, patterns: Option<ReadonlyArray<string>>, lifetime: number) => {
  const register = async (input: unknown): Promise<Either<OAuthError, RegistrationResponse>> => {
    const parsed = registrationSchema.safeParse(input)
    if (!parsed.success) {
      const uris: unknown =
        typeof input === "object" && input !== null ? Reflect.get(input, "redirect_uris") : undefined
      const missingUris = !Array.isArray(uris) || uris.length === 0
      return Left(
        OAuthError.invalidMetadata(
          missingUris ? "redirect_uris must list at least one URI." : "The client metadata is not valid.",
        ),
      )
    }
    const request = parsed.data
    const refused = Option(request.redirect_uris.find((uri) => !isAllowedRedirectUri(uri, patterns)))
    if (refused.isSome()) return Left(OAuthError.redirectUriNotAllowed(refused.orElse("")))

    const client: RegisteredClient = {
      callbackUrl: request.redirect_uris[0] ?? "",
      clientId: randomHex(16),
      clientSecret: randomToken(32),
      metadata: {
        client_name: request.client_name,
        client_uri: request.client_uri,
        contacts: request.contacts,
        jwks: request.jwks,
        jwks_uri: request.jwks_uri,
        logo_uri: request.logo_uri,
        policy_uri: request.policy_uri,
        scope: request.scope,
        software_id: request.software_id,
        software_version: request.software_version,
        tos_uri: request.tos_uri,
      },
      redirectUris: request.redirect_uris,
      registeredAt: new Date(),
    }
    await records.clients.save(client, lifetime)

    return Right({
      ...request,
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.registeredAt.getTime() / 1000),
      client_secret: client.clientSecret ?? "",
      // The secret never expires (RFC 7591 §3.2.1).
      client_secret_expires_at: 0,
      grant_types: request.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: request.response_types ?? ["code"],
      token_endpoint_auth_method: request.token_endpoint_auth_method ?? "client_secret_basic",
    })
  }

  /** The client, kept for another `lifetime` because it is in use. Nothing when it is gone. */
  const use = async (clientId: string): Promise<Option<RegisteredClient>> => {
    const client = await records.clients.find(clientId)
    await client.fold(
      () => Promise.resolve(),
      (found) => records.clients.save(found, lifetime),
    )
    return client
  }

  return {
    find: (clientId: string): Promise<Option<RegisteredClient>> => records.clients.find(clientId),
    register,
    use,
  }
}

export type ClientRegistry = ReturnType<typeof createClientRegistry>
