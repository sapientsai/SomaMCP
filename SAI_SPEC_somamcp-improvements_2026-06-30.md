# somamcp — improvement spec: protected routes, auth-shape normalization, content returns

**Date:** 2026-06-30
**Status:** Proposal
**Driver:** Building `@sapientsai/ms-graph-server` (`packages/graph` in the `microsoft365-mcp-server`
monorepo) on `somamcp@1.0.15`. These are grounded in real friction hit while wiring an app-only
Microsoft Graph server — a custom `/upload` HTTP route with API-key auth, plus a deferred
image-returning tool — not theoretical. Every item is a **fleet-wide** improvement: it benefits any
MCP server built on somamcp, not just this one.

---

## Summary

| # | Add | Priority | API change? | Why (grounded) |
|---|-----|----------|-------------|----------------|
| 1 | Method-aware **protected routes** (`addRoute`) | **High** | new API (minor) | We hand-mounted `POST /upload` via `getApp().post()` and **self-applied the auth gate** — a per-consumer security footgun. |
| 2 | **Normalized `authenticate` request** (or header helper) | Medium | additive | One `authenticate` callback must shape-sniff `http.IncomingMessage` vs Hono `Request`. We wrote `extractAuthHeader()` boilerplate. |
| 3 | **Content-array + image tool returns** (confirm + helper) | Medium-High | docs/test + helper | A real tool (`download_file`) is **blocked/unported** because content-array/image returns aren't confirmed to pass through. |
| 4 | Surface dropped **httpStream options** (cors/stateless/SSL) | Low | additive | `TransportConfig` drops FastMCP options. Not needed for headless app-only; real gap for browser-facing servers. |
| 5 | **Example**: httpStream + custom route + authenticate | Low | docs | No example wires these together; we were the first. |

#1–#3 are the ones with concrete call-site evidence. #1 alone lets `packages/graph` delete its
`authorizeCaller` + `mountUploadRoute` + `extractAuthHeader` and inherit the gate.

---

## 1. Method-aware protected routes — **High**

### Problem (lived, not theoretical)
somamcp's artifact pipeline auto-applies the `authenticate` middleware (`ArtifactManager.ts` —
`app.use(path, createAuthMiddleware(authenticate))`) but only registers **`app.get`** routes. There is
no POST/PUT artifact type. So a write endpoint must be hand-mounted via the `getApp()` escape hatch and
is **not** covered by any built-in auth.

In `packages/graph` this forced:
- `src/upload/upload-route.ts` → `mountUploadRoute(app, auth, apiKey)` calling `app.post('/upload', …)`
  and `app.put('/upload', …)` directly, and
- a hand-rolled `authorizeCaller(bearer, apiKey)` that re-implements the bearer/ticket check that the
  artifact middleware already does for GET routes.

Every consumer that mounts a write route must remember to gate it. "Unprotected write route" should be
hard to do by accident, not the default.

### Proposed API
A first-class route registrar on `SomaServerInstance`, with the same `protected` semantics as artifacts:

```ts
type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

type RouteConfig = {
  method: RouteMethod | RouteMethod[]
  path: `/${string}`
  protected?: boolean // when true, the createServer `authenticate` middleware runs first (401 on throw)
  handler: (c: HonoContext) => Response | Promise<Response>
}

interface SomaServerInstance {
  // ...existing...
  addRoute(route: RouteConfig): void
}
```

Implementation: reuse `createAuthMiddleware(authenticate)` (already in `ArtifactManager.ts`); register
`app.on(methods, path, ...)` instead of `app.get`. Optionally also add a method-aware
`DynamicArtifact` variant so it flows through the existing artifacts config.

### Migration impact
`packages/graph` replaces `mountUploadRoute` + `authorizeCaller` with
`server.addRoute({ method: ["POST","PUT"], path: "/upload", protected: true, handler })`. Net deletion
of code. Additive for somamcp (no breaking change); ship in a minor.

---

## 2. Normalized `authenticate` request shape — **Medium**

### Problem
somamcp passes `authenticate` an `http.IncomingMessage` on the MCP transport path (FastMCP) but a Hono
`Request` on `protected` artifact routes (`ArtifactManager.ts` reads `c.env.incoming` / `c.req.raw`). A
single `authenticate` callback therefore has to handle both shapes. `packages/graph` wrote:

```ts
const extractAuthHeader = (request: unknown): string | undefined => {
  const headers = (request as { headers?: unknown })?.headers
  if (headers && typeof (headers as { get?: unknown }).get === "function") {
    return (headers as Headers).get("authorization") ?? undefined        // Hono Request
  }
  const h = headers as Record<string, string | string[] | undefined> | undefined
  const raw = h?.authorization ?? h?.Authorization                       // http.IncomingMessage
  return Array.isArray(raw) ? raw[0] : raw
}
```

That's boilerplate every consumer will re-invent.

### Proposed
Either (a) normalize the object passed to `authenticate` to a single shape across both paths, or (b)
export a helper `getRequestHeader(request: unknown, name: string): string | undefined` that hides the
shape difference. (b) is non-breaking and pairs with #1's `HonoContext`.

---

## 3. Content-array + image tool returns — **Medium-High**

### Problem
A tool `execute` that returns inline images / multimodal content uses the MCP content-array shape:

```ts
return { content: [{ type: "text", text }, { type: "image", data, mimeType }] }
```

FastMCP supports this, but it's **not confirmed/documented that somamcp's `wrapTool` passes
content-array (and image) returns through unchanged** (vs. coercing to a string). Because of that
uncertainty, `packages/graph` **deferred porting `download_file`** (which returns inline images and raw
base64) from the gateway — a real capability blocked on an unknown.

### Proposed
- Add a test + doc proving `execute` may return a string **or** a `{ content: [...] }` array (including
  `{ type: "image", data, mimeType }`), passed through to the backend unchanged.
- Optionally re-export an `imageContent({ buffer })`-style helper so consumers don't reach into fastmcp.

### Impact
Unblocks `download_file` and any image/multimodal tool across the fleet.

---

## 4. Surface dropped httpStream options — **Low**

`TransportConfig` (`src/types/server.ts`) exposes only `{ enableJsonResponse?, endpoint?, host?, port }`
and drops FastMCP's `cors`, `stateless`, `eventStore`, and SSL options. Not needed for our headless
app-only deployment, but a real gap for any browser-facing somamcp server (CORS) or stateless HTTP
deployment. Additive: widen the `httpStream` option type and pass through.

## 5. Example: httpStream + custom route + authenticate — **Low**

`examples/time-server` shows httpStream + `addTool` but no `getApp()` custom route and no `authenticate`.
No example exercises the make-or-break combination; we were the first to wire it. An
`examples/protected-upload-server` (a POST route + `authenticate` + a tool) would save the next consumer
the spelunking — and would double as the test fixture for #1–#3.

---

## Versioning & rollout

- #1 (`addRoute`) and #2 (normalized request) touch the public surface → **minor bump** (e.g. `1.1.0`).
- #3/#5 are docs/tests/helpers (patch-able); #4 is additive.
- After shipping, `packages/graph` adopts #1+#2 and deletes `upload-route.ts`'s `authorizeCaller` +
  `mountUploadRoute` + `extractAuthHeader`, and (pending the `download_file` decision) #3 unblocks that
  port.

## Non-goals

- Re-architecting the artifacts system (the GET-based static/dynamic artifacts stay as-is; `addRoute` is
  the general escape hatch beside them).
- Changing the FastMCP backend abstraction or the telemetry/introspection surface.
