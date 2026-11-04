import { Option } from "functype"

/** RFC 6749 §3.3 `scope-token`. Anything else can't go in the header, and no client could ask for it. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/

export type InsufficientScope = {
  /** What the session already holds. A client that asks for only `required` would lose these. */
  granted: ReadonlyArray<string>
  required: ReadonlyArray<string>
  requestId: string | number | null
  /** Where the client finds the authorization server (RFC 9728 §5.1). */
  resourceMetadata?: string
}

/**
 * The 403 that asks a client to sign in again with more scopes (RFC 6750 §3.1, the MCP
 * authorization spec's step-up). It has to be an HTTP status: a tool's own error is a 200.
 * `scope` holds what the session has as well as what's missing, so the new grant keeps both.
 */
export const insufficientScope = ({ granted, requestId, required, resourceMetadata }: InsufficientScope): Response => {
  const message = `This needs more permission: ${required.join(", ")}. Sign in again to grant it.`
  const scope = [...new Set([...granted, ...required])].filter((token) => SCOPE_TOKEN.test(token)).join(" ")
  const parameters = [
    ...Option(resourceMetadata).fold(
      () => [],
      (url) => [`resource_metadata="${url}"`],
    ),
    'error="insufficient_scope"',
    `scope="${scope}"`,
  ]
  return new Response(JSON.stringify({ error: { code: -32000, message }, id: requestId, jsonrpc: "2.0" }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "WWW-Authenticate": `Bearer ${parameters.join(", ")}`,
    },
    status: 403,
  })
}
