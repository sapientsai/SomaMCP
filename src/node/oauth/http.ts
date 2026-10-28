// The authorization server over HTTP: metadata documents, the /oauth/* endpoints, and the
// 401 that sends an MCP client to sign in.
import type { Either } from "functype"
import { Option, Try } from "functype"
import type { Context } from "hono"

import type { AuthChallenge, AuthRoute } from "../../types/auth.js"
import { UserError } from "../../types/core.js"
import type { Logger } from "../../types/server.js"
import { readBoundedText } from "../../utils/body.js"
import type { BrowserStep } from "./authorization.js"
import { type OAuthError, toWireError, wireErrorBody } from "./errors.js"
import { consentPage, errorPage, PAGE_SECURITY_HEADERS } from "./pages.js"
import type { AuthorizationServer } from "./server.js"

/** Registration, consent and token requests need a few KiB; this leaves room for a client's `jwks`. */
const MAX_BODY_KIB = 64
const JSON_TYPE = "application/json; charset=utf-8"
const HTML_TYPE = "text/html; charset=utf-8"
/** Responses carrying credentials must not be cached (RFC 6749 §5.1). */
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" }
const PROTECTED_RESOURCE = "/.well-known/oauth-protected-resource"

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": JSON_TYPE, ...headers }, status })

const html = (body: string, status: number): Response =>
  new Response(body, { headers: { "Content-Type": HTML_TYPE, ...PAGE_SECURITY_HEADERS }, status })

/** RFC 9728 §3.1: the metadata for `https://host/mcp` is at `https://host/.well-known/oauth-protected-resource/mcp`. */
export const protectedResourceMetadataUrl = (resource: string): string =>
  Try(() => new URL(resource))
    .toOption()
    .fold(
      () => `${resource}${PROTECTED_RESOURCE}`,
      (url) => {
        url.pathname = `${PROTECTED_RESOURCE}${url.pathname === "/" ? "" : url.pathname}`
        return url.toString()
      },
    )

const resourceFor = (issuer: string, endpoint: string): string => `${issuer.replace(/\/+$/, "")}${endpoint}`

/** What a 401 tells the client about a failure: a `UserError`'s message, else nothing internal. */
const challengeMessage = (error: unknown, logger: Pick<Logger, "error">): string => {
  if (error === undefined) return "Unauthorized: Authentication failed"
  // By name too, in case two copies of somamcp are installed and instanceof fails across them.
  if (error instanceof UserError || (error instanceof Error && error.name === "UserError")) return error.message
  logger.error("[somamcp/oauth] authenticating an MCP request failed:", error)
  return "Unauthorized: Authentication error"
}

/**
 * The 401 for an MCP request without a valid token, in the shape mcp-proxy sent in front of
 * FastMCP: the challenge points at the protected resource metadata (RFC 9728 §5.1), and the
 * body is a JSON-RPC error that echoes the request's id. Only a `UserError` reaches the client
 * in words; anything else thrown is logged, because its message can name files or store keys.
 */
export const mcpChallenge =
  (issuer: string, logger: Pick<Logger, "error">) =>
  ({ endpoint, error, requestId }: AuthChallenge): Response => {
    const message = challengeMessage(error, logger)
    const parameters = [
      `resource_metadata="${protectedResourceMetadataUrl(resourceFor(issuer, endpoint))}"`,
      'error="invalid_token"',
      `error_description="${message.replace(/"/g, '\\"')}"`,
    ]
    return json({ error: { code: -32000, message }, id: requestId, jsonrpc: "2.0" }, 401, {
      "WWW-Authenticate": `Bearer ${parameters.join(", ")}`,
    })
  }

const tooLarge = (): Response =>
  json(
    {
      error: "invalid_request",
      error_description: `The request body is over ${MAX_BODY_KIB} KiB, or could not be read.`,
    },
    413,
    {
      Connection: "close",
    },
  )

const formDecode = (part: string): string => Try(() => decodeURIComponent(part.replace(/\+/g, " "))).orElse(part)

/** `id:secret` split at the first colon, each part form-decoded (RFC 6749 §2.3.1). */
const splitCredentials = (decoded: string): { id: string; secret: string } => {
  const at = decoded.indexOf(":")
  return { id: formDecode(decoded.slice(0, at)), secret: formDecode(decoded.slice(at + 1)) }
}

/** Client credentials from `Authorization: Basic`. */
const basicCredentials = (header: Option<string>): Option<{ id: string; secret: string }> =>
  header
    .flatMap((value) => Option(/^Basic\s+(\S+)$/i.exec(value)?.[1]))
    .map((encoded) => Buffer.from(encoded, "base64").toString("utf-8"))
    .filter((decoded) => decoded.includes(":"))
    .map(splitCredentials)

const wantsHtml = (c: Context): boolean => (c.req.header("accept") ?? "").includes("text/html")

export const createOAuthRoutes = (
  server: AuthorizationServer,
  logger: Pick<Logger, "error">,
): ((endpoint: () => string) => ReadonlyArray<AuthRoute>) => {
  const { host } = new URL(server.issuer)

  const errorJson = (error: OAuthError, headers: Record<string, string> = {}): Response => {
    const wire = toWireError(error)
    return json(wireErrorBody(wire), wire.status, headers)
  }

  /** Anything unexpected: logged, and answered without detail. */
  const failed = (where: string, error: unknown): Response => {
    logger.error(`[somamcp/oauth] ${where} failed:`, error)
    return json({ error: "server_error", error_description: "The server could not complete the request." }, 500)
  }

  const guarded = async (where: string, handle: () => Promise<Response>): Promise<Response> =>
    (await Try.fromPromise(Promise.resolve().then(handle))).fold(
      (error) => failed(where, error),
      (response) => response,
    )

  /** A browser endpoint: a redirect or the consent page, and errors as a page or as JSON. */
  const browser = (c: Context, step: Either<OAuthError, BrowserStep>): Response =>
    step.fold(
      (error) => {
        if (!wantsHtml(c)) return errorJson(error)
        const wire = toWireError(error)
        return html(errorPage(wire.code, wire.description.orElse(wire.code), host), wire.status)
      },
      (next) =>
        next._tag === "Redirect"
          ? new Response(null, { headers: { "Cache-Control": "no-store", Location: next.location }, status: 302 })
          : html(consentPage(next.screen, host), 200),
    )

  const withBody = async (c: Context, handle: (body: string) => Promise<Response>): Promise<Response> =>
    (await readBoundedText(c.req.raw, MAX_BODY_KIB * 1024)).fold(
      () => Promise.resolve(tooLarge()),
      (body) => handle(body),
    )

  return (endpoint) => {
    const protectedResource = (c: Context): Response => {
      if (c.req.path !== PROTECTED_RESOURCE && c.req.path !== `${PROTECTED_RESOURCE}${endpoint()}`)
        return new Response(null, { status: 404 })
      return json(
        {
          authorization_servers: [server.issuer],
          resource: resourceFor(server.issuer, endpoint()),
          scopes_supported: server.scopes,
        },
        200,
      )
    }

    return [
      { handler: () => json(server.metadata(), 200), method: "GET", path: "/.well-known/oauth-authorization-server" },
      { handler: protectedResource, method: "GET", path: PROTECTED_RESOURCE },
      { handler: protectedResource, method: "GET", path: `${PROTECTED_RESOURCE}/*` },
      {
        handler: (c) =>
          guarded("client registration", () =>
            withBody(c, async (body) => {
              const input = Try(() => JSON.parse(body) as unknown).toOption()
              if (input.isNone())
                return json(
                  { error: "invalid_client_metadata", error_description: "The request body must be JSON." },
                  400,
                  NO_STORE,
                )
              return (await server.register(input.orElse(null))).fold(
                (error) => errorJson(error, NO_STORE),
                (registration) => json(registration, 201, NO_STORE),
              )
            }),
          ),
        method: "POST",
        path: "/oauth/register",
      },
      {
        handler: (c) =>
          guarded("authorization", async () =>
            browser(c, await server.authorize(Object.fromEntries(new URL(c.req.url).searchParams))),
          ),
        method: "GET",
        path: "/oauth/authorize",
      },
      {
        handler: (c) =>
          guarded("consent", () =>
            withBody(c, async (body) => browser(c, await server.decide(new URLSearchParams(body)))),
          ),
        method: "POST",
        path: "/oauth/consent",
      },
      {
        handler: (c) =>
          guarded("the provider callback", async () => browser(c, await server.callback(new URL(c.req.url)))),
        method: "GET",
        path: "/oauth/callback",
      },
      {
        handler: (c) =>
          guarded("the token endpoint", () =>
            withBody(c, async (body) => {
              const form = new URLSearchParams(body)
              const basic = basicCredentials(Option(c.req.header("authorization")))
              const field = (name: string): Option<string> => Option(form.get(name)).filter((v) => v !== "")
              const issued = await server.token({
                clientId: basic.map((b) => b.id).orElse(form.get("client_id") ?? ""),
                code: field("code").orUndefined(),
                codeVerifier: field("code_verifier").orUndefined(),
                grantType: form.get("grant_type") ?? "",
                refreshToken: field("refresh_token").orUndefined(),
                scope: field("scope").orUndefined(),
              })
              return issued.fold(
                (error) => errorJson(error, NO_STORE),
                (tokens) => json(tokens, 200, NO_STORE),
              )
            }),
          ),
        method: "POST",
        path: "/oauth/token",
      },
    ]
  }
}
