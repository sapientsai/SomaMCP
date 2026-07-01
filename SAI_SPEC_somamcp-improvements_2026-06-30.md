# somamcp — improvement spec: protected routes, auth-shape normalization, content returns

**Date:** 2026-06-30
**Status:** Proposal
**Driver:** Building `@sapientsai/ms-graph-server` (`packages/graph` in the `microsoft365-mcp-server`
monorepo) on `somamcp@1.0.15`. These are grounded in real friction hit while wiring an app-only
Microsoft Graph server — a custom `/upload` HTTP route with API-key auth, plus a deferred
image-returning tool — not theoretical. Every item is a **fleet-wide** improvement: it benefits any
MCP server built on somamcp, not just this one.

> **Reviewed 2026-06-30** against the somamcp tree — all code references verified accurate. Two
> corrections folded in below: **#3 is already satisfied in code** (`wrapTool`'s success path returns the
> value unchanged — `telemetryWrapper.ts:76` — so content-array/image returns pass through today, and
> `imageContent`/`audioContent` are already exported at `src/index.ts:45`), so it drops to a **test + doc**
> task and **`download_file` is NOT blocked — it can be ported now**. **#2** commits to the additive
> helper (b). Recommended cut: ship **#1 + #2(b) as `1.1.0`**, close #3 with a test + doc, bundle #4 + #5.

---

## Summary

| #   | Add                                                         | Priority   | API change?     | Why (grounded)                                                                                                                             |
| --- | ----------------------------------------------------------- | ---------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Method-aware **protected routes** (`addRoute`)              | **High**   | new API (minor) | We hand-mounted `POST /upload` via `getApp().post()` and **self-applied the auth gate** — a per-consumer security footgun.                 |
| 2   | **Normalized `authenticate` request** (or header helper)    | Medium     | additive        | One `authenticate` callback must shape-sniff `http.IncomingMessage` vs Hono `Request`. We wrote `extractAuthHeader()` boilerplate.         |
| 3   | **Content-array + image tool returns** (lock in)            | test + doc | docs/test       | **Already works** (`wrapTool` passes content-array through; `imageContent` exported) — just needs a test + doc. `download_file` unblocked. |
| 4   | Surface dropped **httpStream options** (cors/stateless/SSL) | Low        | additive        | `TransportConfig` drops FastMCP options. Not needed for headless app-only; real gap for browser-facing servers.                            |
| 5   | **Example**: httpStream + custom route + authenticate       | Low        | docs            | No example wires these together; we were the first.                                                                                        |

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

### Notes (from review)

- **Route ordering.** Hono dispatches by registration order. `addRoute` should document _when_ it may be
  called relative to `start()` — which registers the introspection routes + artifacts. A concrete
  `POST /upload` is fine after `start()`, but a wildcard path could shadow built-ins. Recommend allowing
  `addRoute` pre-`start()` (registered before the introspection/artifact routes) and documenting the
  order guarantee.
- **`onUnauthorized` knob.** `createAuthMiddleware` currently hardcodes a `401 { error: "Unauthorized" }`
  with no `WWW-Authenticate` header or customization. If shipping #1, add an optional
  `RouteConfig.onUnauthorized?: (c) => Response` so consumers can shape the 401.
- **Testing.** Model the `addRoute` tests on `test/artifacts/ArtifactManager.test.ts` (protected vs
  unprotected, method dispatch, 401-on-throw).

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
    return (headers as Headers).get("authorization") ?? undefined // Hono Request
  }
  const h = headers as Record<string, string | string[] | undefined> | undefined
  const raw = h?.authorization ?? h?.Authorization // http.IncomingMessage
  return Array.isArray(raw) ? raw[0] : raw
}
```

That's boilerplate every consumer will re-invent.

### Proposed (decided: option b)

Export a helper `getRequestHeader(request: unknown, name: string): string | undefined` that hides the
shape difference. Purely additive and pairs with #1's `HonoContext`.

Normalizing the object passed to `authenticate` to a single shape (option a) is rejected for now: it
would **break any consumer already shape-sniffing** (including `packages/graph`'s `extractAuthHeader`).
Leave normalization for a future major.

---

## 3. Content-array + image tool returns — **test + doc only** (already works)

### Status (corrected by review)

This **already works in somamcp today** — it was an unknown to us, not a gap:

- `wrapTool`'s success path returns the tool's value **unchanged** (`telemetryWrapper.ts:76`), so a
  content-array return passes straight through to the FastMCP backend:

  ```ts
  return {
    content: [
      { type: "text", text },
      { type: "image", data, mimeType },
    ],
  }
  ```

- `imageContent` and `audioContent` are **already exported** (`src/index.ts:45`) — no new helper needed.

`packages/graph` deferred `download_file` on this uncertainty; that uncertainty is now resolved, so
**`download_file` is not blocked and can be ported today.**

### Proposed

Just lock the behavior in: add a `wrapTool` test asserting a `{ content: [...] }` (incl.
`{ type: "image", data, mimeType }`) return passes through unchanged, and a short doc line. **No new
code.**

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

- Ship **#1 (`addRoute`) + #2(b) (`getRequestHeader`) as `1.1.0`** — both touch the public surface.
- **#3 is a test + doc** (no code); **#4** additive; **#5** docs. Bundle #4 + #5 into the same release.
- **Semver footnote:** `1.0.15` already shipped a de-facto breaking change
  (`GithubFeedbackOptions.getToken` → `Option<string>`), so strict semver is already loose here. Either
  retroactively treat the next cut as `1.1.0` or commit to "1.x is patch-anywhere" — just be consistent.
- After shipping, `packages/graph` adopts #1 + #2(b) and deletes `upload-route.ts`'s `authorizeCaller` +
  `mountUploadRoute` + `extractAuthHeader`. `download_file` can be ported **independently** (not gated on
  any somamcp change — see #3).

## Non-goals

- Re-architecting the artifacts system (the GET-based static/dynamic artifacts stay as-is; `addRoute` is
  the general escape hatch beside them).
- Changing the FastMCP backend abstraction or the telemetry/introspection surface.
