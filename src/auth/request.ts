import { Option } from "functype"

const readFetchHeader = (headers: unknown, lower: string): Option<string> => {
  if (typeof (headers as { get?: unknown }).get !== "function") return Option.none()
  return Option((headers as Headers).get(lower))
}

const readNodeHeader = (headers: unknown, lower: string, original: string): Option<string> => {
  const bag = headers as Record<string, string | string[] | undefined>
  return Option(bag[lower] ?? bag[original]).map((raw) => (Array.isArray(raw) ? (raw[0] ?? "") : raw))
}

const readAny = (headers: unknown, lower: string, original: string): Option<string> =>
  readFetchHeader(headers, lower).fold(
    () => readNodeHeader(headers, lower, original),
    (value) => Option(value),
  )

const extractHeaders = (request: unknown): Option<unknown> =>
  Option(request as { headers?: unknown } | null | undefined).flatMap((r) => Option(r.headers))

/**
 * Extract a header from either shape somamcp's `authenticate` callback may receive:
 *
 * - **Hono `Request`** (`c.req.raw`) — used on protected artifact and custom routes.
 *   Headers implement the WHATWG `Headers` interface (`.get(name)`).
 * - **`http.IncomingMessage`** — used on the MCP transport path (FastMCP).
 *   Headers are a plain lowercased object; values may be `string | string[]`.
 *
 * Case-insensitive on the header name. Returns `undefined` when the header is
 * absent or the request shape is not recognized — matches the `Headers.get`
 * shape callers already write against.
 */
// eslint-disable-next-line functype/prefer-option -- public helper mirrors the WHATWG Headers.get contract; forcing Option onto consumers here would push functype through a boundary the rest of somamcp deliberately keeps optional
export const getRequestHeader = (request: unknown, name: string): string | undefined => {
  const lower = name.toLowerCase()
  return extractHeaders(request)
    .flatMap((h) => readAny(h, lower, name))
    .orUndefined()
}
