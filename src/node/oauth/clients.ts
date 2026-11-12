// Dynamic client registration (RFC 7591), and which redirect URIs a client may register.
import type { Either } from "functype"
import { Left, Option, Right, Try } from "functype"
import { z } from "zod"

import { OAuthError } from "./errors.js"
import type { Records, RegisteredClient } from "./records.js"
import { randomHex, randomToken } from "./secrets.js"

/** With no patterns configured, only loopback redirect URIs, for native clients (RFC 8252 §7.3). */
const LOOPBACK_ONLY = ["http://localhost:*", "http://127.0.0.1:*"]

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"]

const DEFAULT_PORT = { http: "80", https: "443" } as const

type Scheme = keyof typeof DEFAULT_PORT

/**
 * An allowed redirect URI, parsed from a pattern: a literal scheme and host, a port (`*` for any,
 * loopback only), and a glob over the path and query.
 */
export type RedirectPattern = {
  readonly host: string
  readonly path: RegExp
  readonly port: string
  readonly scheme: Scheme
}

/** `scheme://host[:port][path]`. The host is a DNS name, an IPv4 address or a bracketed IPv6 one. */
const PATTERN = /^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\*|\d{1,5}))?(\/.*)?$/i

const SHAPE =
  "A pattern is http(s)://host[:port][/path]: the scheme and host are literal, * and ? match only in the path, a * port is allowed only on loopback, and http only on loopback."

/** A path glob as an anchored regular expression: `*` matches any run of characters, `?` exactly one. */
const globToRegExp = (glob: string): RegExp =>
  new RegExp(
    `^${[...glob]
      .map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("")}$`,
  )

const parsePattern = (pattern: string): Either<string, RedirectPattern> => {
  const parts = Option(PATTERN.exec(pattern))
  if (parts.isNone()) return Left(`"${pattern}" is not a pattern this server accepts`)
  const [, scheme, host, port, path] = parts.orThrow()
  // Groups 3 and 4 are optional: a pattern without them leaves them undefined.
  const portGlob = Option(port)
  const lower = scheme.toLowerCase() as Scheme
  // The host as a browser reads it, so `127.1` or an upper-case name compares like the URI's.
  const hostname = Try(() => new URL(`${lower}://${host}`).hostname).toOption()
  if (hostname.isNone()) return Left(`"${pattern}" has a host that is not valid`)
  const name = hostname.orThrow()
  const loopback = LOOPBACK_HOSTS.includes(name)
  const anyPort = portGlob.contains("*")
  if (lower === "http" && !loopback) return Left(`"${pattern}" uses http on a host that is not loopback`)
  if (anyPort && !loopback) return Left(`"${pattern}" allows any port on a host that is not loopback`)
  const portNumber = portGlob.filter((p) => p !== "*").map(Number)
  if (portNumber.exists((n) => n < 1 || n > 65535)) return Left(`"${pattern}" has a port out of range`)
  return Right({
    host: name,
    // A pattern without a path allows any path on its origin.
    path: globToRegExp(Option(path).orElse("*")),
    port: anyPort ? "*" : portNumber.map(String).orElse(DEFAULT_PORT[lower]),
    scheme: lower,
  })
}

/**
 * The redirect URI patterns to allow, or an error naming the first that is unsafe. Unset allows
 * loopback only; an empty list allows nothing.
 */
export const parseRedirectPatterns = (
  configured: Option<ReadonlyArray<string>>,
): Either<Error, ReadonlyArray<RedirectPattern>> =>
  configured
    .fold(
      (): ReadonlyArray<string> => LOOPBACK_ONLY,
      (patterns) => patterns,
    )
    .reduce<Either<Error, ReadonlyArray<RedirectPattern>>>(
      (parsed, pattern) =>
        parsed.flatMap((list) =>
          parsePattern(pattern).fold(
            (problem) =>
              Left<Error, ReadonlyArray<RedirectPattern>>(
                new Error(`[somamcp/oauth] allowedRedirectUriPatterns: ${problem}. ${SHAPE}`),
              ),
            (one) => Right<Error, ReadonlyArray<RedirectPattern>>([...list, one]),
          ),
        ),
      Right([]),
    )

const matches = (pattern: RedirectPattern, url: URL): boolean => {
  const scheme = url.protocol.slice(0, -1)
  if (scheme !== pattern.scheme) return false
  if (url.hostname !== pattern.host) return false
  const port = url.port === "" ? DEFAULT_PORT[pattern.scheme] : url.port
  if (pattern.port !== "*" && pattern.port !== port) return false
  return pattern.path.test(`${url.pathname}${url.search}`)
}

/**
 * Whether a client may register `uri`, or still use it. It must be an absolute URL with no user
 * name or password in it (`https://claude.ai@evil.example` hides its real host there) and no
 * fragment (RFC 6749 §3.1.2), and match one of `patterns` on its parsed scheme, host, port and path.
 */
export const isAllowedRedirectUri = (uri: string, patterns: ReadonlyArray<RedirectPattern>): boolean =>
  Try(() => new URL(uri))
    .toOption()
    .filter((url) => url.username === "" && url.password === "" && url.hash === "")
    .exists((url) => patterns.some((pattern) => matches(pattern, url)))

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
 * `lifetime` is how long, in seconds, a client is kept after it registered, or last completed a
 * sign-in or a refresh. A client nobody uses for that long is forgotten, so open registration
 * cannot fill the store.
 */
export const createClientRegistry = (records: Records, patterns: ReadonlyArray<RedirectPattern>, lifetime: number) => {
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

  /** Keep the client another `lifetime`, after a completed sign-in or refresh. Nothing when it is gone. */
  const use = async (clientId: string): Promise<Option<RegisteredClient>> => {
    const client = await records.clients.find(clientId)
    await client.fold(
      () => Promise.resolve(),
      (found) => records.clients.save(found, lifetime),
    )
    return client
  }

  return {
    /** Whether the server's patterns allow `uri` now: a client registered under looser ones may not use it. */
    allows: (uri: string): boolean => isAllowedRedirectUri(uri, patterns),
    find: (clientId: string): Promise<Option<RegisteredClient>> => records.clients.find(clientId),
    register,
    use,
  }
}

export type ClientRegistry = ReturnType<typeof createClientRegistry>
