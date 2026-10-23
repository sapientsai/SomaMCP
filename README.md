# SomaMCP

Framework for building **MCP (Model Context Protocol)** servers with built-in telemetry, introspection, agent feedback, and a backend abstraction layer.

somamcp builds on the official [MCP TypeScript SDK 2.x](https://ts.sdk.modelcontextprotocol.io/v2) behind a `BackendAdapter` interface — giving you a stable API surface, automatic telemetry, gateway-based server composition, identity/health endpoints with sensible security defaults, and HTTP artifacts out of the box. One endpoint serves both the `2026-07-28` protocol revision and 2025-era clients.

The main entry, `somamcp`, uses web-standard APIs only, so it runs on Cloudflare Workers without `nodejs_compat`, and on Deno, Bun and Node. `somamcp/node` adds what only Node can do: listening on a port, stdio, file telemetry, and reading content from a path. Coming from 1.x? See [Migrating from 1.x](#migrating-from-1x).

## Features

- **Both protocol eras** — the `2026-07-28` revision that current Claude clients request first, and the 2025 `initialize` handshake, from one endpoint
- **Runs anywhere** — the main entry is WinterTC-only (Workers, Deno, Bun, Node); `somamcp/node` adds a port listener and stdio
- **Backend abstraction** — framework-agnostic `BackendAdapter` interface; swap the underlying MCP implementation without changing consumer code
- **Structured telemetry** — pluggable `TelemetryCollector` with console, file (NDJSON), composite, and [functype-log](https://github.com/jordanburke/functype-log) adapters
- **Error classification & enrichment** — errors are auto-classified (validation / timeout / gateway / auth / not_found / internal) with actionable suggestions for LLMs
- **Per-tool capture config** — configure input/output capture levels, field redaction, and output size limits per tool
- **Gateway system** — connect to remote MCP servers and proxy their tools as local tools
- **Identity & build info** — `info` MCP tool returns name, version, build commit, runtime, and capability counts; auto-populated from `SOMAMCP_BUILD_*` env vars
- **Two-tier health** — public `/health` (minimal, for Docker/k8s probes) + protected `/health/detail` (full operational state)
- **Protected artifacts** — `protected: true` on any artifact reuses the server's `authenticate` callback; dashboard and `/info` protected by default
- **Method-aware protected routes** — `addRoute({ method, path, protected, handler })` for custom `POST`/`PUT`/etc. endpoints behind the same `authenticate` gate
- **Agent feedback tool** — `createFeedbackTool` posts agent-reported issues to GitHub or any webhook, with automatic credential/PII redaction
- **HTTP dashboard** — auto-generated overview at `/dashboard` (protected)
- **Functional style** — powered by [functype](https://github.com/jordanburke/functype) (`Ref`, `Try`, `Either`)

## Installation

```bash
pnpm add somamcp
# or
npm install somamcp
```

## Quick Start

On Node, import from `somamcp/node` and start a transport:

```typescript
import { createServer } from "somamcp/node"
import { z } from "zod"

const server = createServer({
  name: "my-server",
  version: "1.0.0",
})

server.addTool({
  name: "greet",
  description: "Greet someone by name",
  parameters: z.object({ name: z.string() }),
  execute: async ({ name }) => `Hello, ${name}!`,
})

await server.start({ transportType: "stdio" })
// or: await server.start({ transportType: "httpStream", httpStream: { port: 3000 } })
```

On Cloudflare Workers (or any runtime with `fetch`), import from `somamcp` and serve requests:

```typescript
import { createServer } from "somamcp"

const server = createServer({ name: "my-worker", version: "1.0.0" })
// ...addTool as above

export default { fetch: (request: Request) => server.fetch(request) }
```

## Identity & Health

SomaMCP auto-registers one MCP introspection tool and three HTTP endpoints:

| Surface  | Default path / name | Protected | Returns                                                                          |
| -------- | ------------------- | --------- | -------------------------------------------------------------------------------- |
| MCP tool | `info`              | n/a       | `{ name, version, build, runtime, capabilities: { tools, resources, prompts } }` |
| HTTP     | `/health`           | No        | `{ name, status }` — minimal, status code is the real signal (200 / 503)         |
| HTTP     | `/health/detail`    | Yes       | Full `ServerHealth` (sessions, gateway topology)                                 |
| HTTP     | `/info`             | Yes       | Same shape as the `info` MCP tool                                                |
| HTTP     | `/dashboard`        | Yes       | Rendered HTML overview                                                           |

**Why two health tiers?** The public `/health` exists for infrastructure probes (Docker `HEALTHCHECK`, k8s liveness/readiness, load balancers) — they only need a status code. Operational details (session counts, gateway URLs) are reconnaissance signals and live behind `protected: true`.

### Build info

Set these env vars at deploy time (e.g. in your Dockerfile or CI) so `info` reflects the actual build:

```bash
SOMAMCP_BUILD_COMMIT=abc123
SOMAMCP_BUILD_DATE=2026-05-22T00:00:00Z
SOMAMCP_BUILD_BRANCH=main
SOMAMCP_ENVIRONMENT=production
```

Or pass them programmatically (override wins over env):

```typescript
createServer({
  name: "my-server",
  version: "1.0.0",
  build: {
    commit: process.env.GIT_SHA,
    date: process.env.BUILD_DATE,
    environment: "production",
  },
})
```

### Disabling / customizing

```typescript
createServer({
  name: "my-server",
  version: "1.0.0",
  enableIntrospection: false, // remove the `info` MCP tool
  enableHealthEndpoint: false, // remove /health and /health/detail
  enableInfoEndpoint: false, // remove /info
  enableDashboard: false, // remove /dashboard
  healthPath: "/healthz", // custom paths
  healthDetailPath: "/health/full",
  infoPath: "/about",
  introspectionPrefix: "soma_", // → `soma_info` tool name
})
```

## Protected Artifacts

Any artifact can opt into auth with `protected: true`. The route runs the server's `authenticate` callback via Hono middleware — same auth model as MCP protocol calls. Rejecting, throwing, or resolving to `undefined`/`null` returns 401. If `protected: true` is set but no `authenticate` is configured, the route returns 401 unconditionally.

```typescript
import { createServer, getRequestHeader } from "somamcp/node"

createServer({
  name: "my-server",
  version: "1.0.0",
  // `authenticate` receives the web Request, for MCP calls and for protected
  // routes alike. On stdio there is no request, and it receives `undefined`.
  authenticate: async (req) => {
    const header = getRequestHeader(req, "authorization")
    const token = header?.replace(/^Bearer /, "")
    if (token !== process.env.OPS_TOKEN) throw new Error("denied")
    return { user: "ops" }
  },
  artifacts: [
    {
      type: "dynamic",
      path: "/admin/stats",
      protected: true,
      handler: (c) => c.json({ secret: "stuff" }),
    },
  ],
})
```

## Protected Routes

For write endpoints, or anything the GET-only artifact shape doesn't cover, use `addRoute`. Same `authenticate` gate, method-aware, with optional `onUnauthorized` for custom 401 responses.

```typescript
server.addRoute({
  method: ["POST", "PUT"],
  path: "/upload",
  protected: true,
  handler: async (c) => {
    const bytes = (await c.req.arrayBuffer()).byteLength
    return c.json({ bytes, status: "accepted" })
  },
  onUnauthorized: (c) =>
    c.json({ error: "unauthorized", hint: "provide Bearer" }, 401, { "WWW-Authenticate": "Bearer" }),
})
```

**Route ordering.** Hono dispatches by registration order. `addRoute` registers immediately, alongside artifacts and introspection routes. Concrete non-overlapping paths compose safely in any order; for wildcards or overlapping prefixes, register earlier to take precedence.

See [`examples/protected-upload-server`](examples/protected-upload-server) for a runnable end-to-end wiring: httpStream + `authenticate` + `addRoute` + a tool returning a content-array (text + inline image).

## Content-Array Tool Returns

A tool's `execute` may return a plain string **or** a full content-array with multimodal parts — telemetry passes the return value through unchanged. Use the exported `imageContent` / `audioContent` helpers to build parts without reaching into the backend. Both take `{ buffer }` (any `Uint8Array`, including a Node `Buffer`) or `{ url }` everywhere; the `somamcp/node` versions also take `{ path }`. A URL's or path's extension picks the MIME type.

```typescript
import { createServer, imageContent } from "somamcp/node"

server.addTool({
  name: "hello_pixel",
  description: "Text + inline image",
  parameters: z.object({ name: z.string() }),
  execute: async ({ name }) => ({
    content: [{ type: "text", text: `hello, ${name}` }, await imageContent({ path: "./banner.png" })],
  }),
})
```

## Telemetry

Telemetry is opt-in via the `telemetry` option. Every tool/resource/prompt call is automatically wrapped with timing, error classification, and optional input/output capture.

```typescript
// createJsonFileTelemetry writes to disk, so it comes from somamcp/node.
import { createServer, createCompositeTelemetry, createConsoleTelemetry, createJsonFileTelemetry } from "somamcp/node"

const telemetry = createCompositeTelemetry([
  createConsoleTelemetry(),
  createJsonFileTelemetry({ filePath: "./logs/events.ndjson" }),
])

const server = createServer({
  name: "my-server",
  version: "1.0.0",
  telemetry,
})
```

### Per-tool capture configuration

```typescript
server.addTool({
  name: "processPayment",
  description: "Process a payment",
  parameters: z.object({ amount: z.number(), cardToken: z.string() }),
  execute: async (args) => {
    /* ... */
  },
  captureConfig: {
    captureLevel: "full",
    redactInputFields: ["cardToken"],
    maxOutputSize: 2000,
  },
})
```

Capture levels:

- `"full"` — input + output + metadata (default)
- `"metadata"` — timing + name + ids only
- `"none"` — no telemetry

### Error enrichment

Errors thrown from tools are automatically classified and returned as structured `ContentResult` responses with `isError: true`, including suggestions to help calling LLMs self-correct.

```typescript
// Thrown: new Error("Request timed out after 30s")
// Returned to LLM:
{
  isError: true,
  content: [{
    type: "text",
    text: JSON.stringify({
      errorCategory: "timeout",
      message: "Request timed out after 30s",
      suggestions: [
        "The operation took too long. Try reducing the scope of the request.",
        "Check if the upstream service is responsive.",
      ],
    }),
  }],
}
```

## Gateways

Connect to remote MCP servers and proxy their tools as local tools.

```typescript
const server = createServer({
  name: "gateway-server",
  version: "1.0.0",
  gateways: [
    {
      id: "upstream",
      url: "https://remote-mcp.example.com",
      proxyTools: true, // register remote tools as local (prefixed: "upstream_toolname")
      reconnect: true,
    },
  ],
})
```

Gateways use the MCP SDK 2.x client. They speak the `2026-07-28` revision to servers that offer it, and fall back to the 2025 `initialize` handshake for the rest. A gateway's `info.protocolVersion` reports what was negotiated.

- **`versionNegotiation`:** `"auto"` (the default) probes first with `server/discover`. Some older servers answer that probe with a 5xx error, which fails the connection; set `"legacy"` for those to skip the probe.
- **`fetch`:** Replaces the global `fetch` for that gateway's requests. The client calls it as a plain function, so wrap a Workers service binding rather than passing its method: `fetch: (url, init) => env.UPSTREAM.fetch(url, init)`.

## Agent Feedback

Let agents file issues against your repo when they hit bugs or confusing behavior. The tool auto-redacts common credential patterns and PII, and includes a tool description that explicitly warns the LLM not to include proprietary data.

```typescript
import { createServer, createFeedbackTool, createGithubFeedback } from "somamcp"

const server = createServer({ name: "my-mcp", version: "1.0.0" })

server.addTool(
  createFeedbackTool({
    provider: createGithubFeedback({
      repo: "myorg/my-mcp",
      getToken: () => process.env.GITHUB_FEEDBACK_TOKEN,
      defaultLabels: ["agent-feedback"],
    }),
    // Auto-attached to each issue (visible in the issue body)
    enrichment: async () => ({
      server: server.getInfo(),
    }),
    extraLabels: ["from-agent"],
  }),
)
```

**What gets redacted automatically** (best-effort, not a substitute for caution):

- GitHub PATs (`ghp_*`, `github_pat_*`)
- AWS access keys (`AKIA*`)
- Stripe keys (`sk_live_*`, `pk_test_*`, etc.)
- Slack tokens (`xoxb-*`, `xoxp-*`, etc.)
- JWTs
- OpenAI/Anthropic API keys
- Bearer tokens (`Bearer <secret>`)
- Email addresses
- Private IPv4 addresses (RFC1918)
- Internal hostnames (`*.internal`, `*.local`, etc.)

The tool response includes a `redactionDetails` summary so the agent knows what was scrubbed. Add custom patterns via `redactionPatterns`.

**Providers:**

- `createGithubFeedback({ repo, getToken, defaultLabels?, baseUrl? })` — posts to GitHub Issues
- `createWebhookFeedback({ url, headers?, transform? })` — generic JSON POST to any endpoint (Linear, Jira, Sentry, custom relay)

**Token security:** the token only needs `issues: write` scope on the target repo. Use a GitHub App for fleet-scale (auditable, scoped, rotatable).

## Artifacts & Dashboard

Mount HTTP routes on the embedded Hono app. A protected health dashboard is auto-mounted at `/dashboard` unless disabled.

```typescript
const server = createServer({
  name: "my-server",
  version: "1.0.0",
  enableDashboard: true, // default; requires `authenticate` to view
  artifacts: [
    {
      type: "dynamic",
      path: "/status",
      handler: (c) => c.json({ ok: true }),
    },
  ],
})

// With createServer from "somamcp/node":
await server.start({
  transportType: "httpStream",
  httpStream: { port: 8080 },
})
```

## Entry Points

| Import            | Runs on                  | `createServer` defaults to | Adds                                                                                       |
| ----------------- | ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------ |
| `somamcp`         | Workers, Deno, Bun, Node | `createSdkBackend`         | —                                                                                          |
| `somamcp/node`    | Node (and Bun)           | `createNodeBackend`        | `start()` on a port or stdio, `createJsonFileTelemetry`, `{ path }` in the content helpers |
| `somamcp/backend` | anywhere                 | —                          | `createSdkBackend` and the backend types, for writing or wrapping a backend                |
| `somamcp/edge`    | anywhere                 | `createSdkBackend`         | Nothing: an alias of `somamcp` kept through 2.x so 1.x imports resolve. Removed in 3.0.    |

`somamcp/node` re-exports everything in `somamcp` and shares its modules rather than copying them, so values such as `UserError` are the same whichever entry you import them from. `pnpm validate` fails if Node-only code reaches anything `somamcp` loads, or if the core is emitted twice. It also runs the main entry inside `workerd`, Cloudflare's Workers runtime, without `nodejs_compat`, with both protocol eras, auth, content helpers, errors and resources (`test/workers/`).

On the main entry, a bare `start()` listens on nothing: it marks the server started and connects gateways. `start()` with a transport rejects with a pointer to `somamcp/node`. On `somamcp/node`, a bare `start()` serves stdio.

### On Workers

```typescript
import { createServer } from "somamcp"

const server = createServer({
  name: "my-worker",
  version: "1.0.0",
  // Workers has no process.env — pass build info from the fetch handler's `env`.
  build: { commit: "abc123", environment: "production" },
})

export default { fetch: (request: Request) => server.fetch(request) }
```

`server.fetch` serves both the MCP endpoint and every artifact/route you register, so `/health`, `/info`, and `/dashboard` work as they do on Node.

**Types.** The MCP SDK's own `.d.mts` files mention `Buffer`, so a Workers project without `@types/node` needs `skipLibCheck: true` (Wrangler's default). somamcp's own types do not.

**Gateways** need `await server.start()` to connect and register proxied tools. Workers forbids network I/O at module scope, so call it lazily inside your first request rather than at the top level. Without it, gateway tools are never registered.

**Registering routes late.** Hono builds its router on the first request and then rejects new routes ("matcher is already built"). Register every artifact and `addRoute` before serving traffic — on Workers that means at module scope, not inside the fetch handler.

**Runtime reporting.** `getInfo().runtime` is `"edge"` on Cloudflare Workers, Deno, and Vercel Edge, and `"node"` otherwise. Edge runtimes are detected positively — `navigator.userAgent === "Cloudflare-Workers"`, or a `Deno` / `EdgeRuntime` global — rather than by the absence of `process`, because Workers with `nodejs_compat` supplies a working `process.versions.node`. On edge, `arch` / `nodeVersion` / `platform` report `"unknown"` or the user agent, rather than describing the compatibility shim. Bun deliberately reports `"node"`: it is a Node-family server runtime with full Node APIs.

## The SDK Backend

`createSdkBackend` (and `createNodeBackend`, the same backend with Node transports) builds on `@modelcontextprotocol/server` 2.x. One endpoint serves both protocol revisions:

- **`2026-07-28`**, which current Claude clients request first.
- **2025-era clients**, which open with `initialize`.

How it behaves:

- **Stateless.** Every request gets a fresh SDK server built from somamcp's registry. There are no sessions, `connect`/`disconnect` events never fire, and a 2025 client's `GET` or `DELETE` is answered `405`. `httpStream.stateless: false` is ignored, with a warning through `logger`.
- **`authenticate` receives the web `Request`**, for MCP calls and for protected artifacts and routes. Read headers with `getRequestHeader`. On the MCP endpoint, rejecting with a `Response` serves that response as-is; protected artifacts and routes answer with their `onUnauthorized`, or 401. Any other rejection, a synchronous throw, or a nullish result is a `401`. On stdio there is no request: `authenticate` is called once with `undefined`, and a failure serves without a session. `canAccess` is only ever called with a real session: with none, gated tools are hidden when `authenticate` is configured and shown otherwise.
- **Errors follow SDK 2.x and the current spec.** Calling an unknown tool, or one hidden by `canAccess`, is a JSON-RPC `InvalidParams` error. Invalid arguments and thrown errors (including `UserError`) are `isError` tool results, so the model can read the message and retry.
- **Schemas must describe themselves as JSON Schema** (`~standard.jsonSchema`): zod 4, ArkType, or Valibot via `@valibot/to-json-schema`. Other schemas still validate, but clients see an empty argument list; `addTool` warns through `logger`.
- **`context.client.version`** is filled in for `2026-07-28` clients, which send their client info on every request. It is `undefined` for 2025 clients, which send it only during `initialize`.
- **`context.log` follows the client's log level.** A `2026-07-28` client receives tool logs only when its request asks for a log level (`io.modelcontextprotocol/logLevel`); otherwise the SDK drops them. 2025 clients receive them as before. Progress (`reportProgress`) is unaffected.
- **`streamKeepalive`** (`enabled`, `intervalMs`; default 20 s) writes SSE comment frames onto an in-flight call's own stream. With it on, every tool call is answered as an SSE stream, so a long call that produces no output still gets keepalives. `httpStream.enableJsonResponse` turns them off; it applies to `2026-07-28` exchanges only.
- **`httpStream.host` defaults to `localhost`.** Pass `host: "0.0.0.0"` to listen on every interface, for example in a container.
- **Health reports `running` from construction**, because the backend can answer `fetch()` before `start()`. `stop()` closes the listener and in-flight streams and reports `stopped` (so `/health` answers 503), but `fetch()` still answers MCP requests.
- **Removal is real:** `removeTool`, `removeResource` and `removePrompt` apply from the next request.
- **The MCP path comes first.** The backend claims the MCP endpoint before artifacts and routes, so an `addRoute` on that path is never reached.
- **`backendOptions`** (`SdkBackendOptions`) takes `mcpPath`, the endpoint for `fetch()` use (`httpStream.endpoint` overrides it), and, on `somamcp/node`, `stdioTransport`, a transport to use in place of the process's stdin/stdout.

## Backend Abstraction

The MCP implementation is reached only through the `BackendAdapter` interface. `createServer` accepts a `backend` factory; each entry supplies its default. To wrap or replace the backend, implement `BackendFactory`:

```typescript
import { createSdkBackend, type BackendFactory } from "somamcp/backend"

const myBackend: BackendFactory = (config, backendOptions) => {
  const backend = createSdkBackend(config, backendOptions)
  // ...wrap or extend it
  return backend
}
```

## Migrating from 1.x

somamcp 2.0 drops FastMCP. If you need FastMCP, stay on somamcp `^1.5`, which has both backends.

- **Node servers import from `somamcp/node`.** `start()` with `httpStream` or `stdio` now needs it; on `somamcp` it rejects. Change `import { createServer } from "somamcp"` to `"somamcp/node"`. Everything else `somamcp` exports is re-exported there.
- **A bare `start()` on `somamcp` no longer serves stdio.** It listens on nothing and resolves, so a stdio server that keeps importing from `somamcp` exits quietly. On `somamcp/node`, a bare `start()` still serves stdio.
- **`createJsonFileTelemetry` and path-based `imageContent` / `audioContent` moved to `somamcp/node`.** `{ buffer }` and `{ url }` inputs still work from `somamcp`.
- **`somamcp/edge` is an alias of `somamcp`.** `createEdgeBackend` and `EdgeBackendOptions` are gone; the main entry runs on Workers itself. `createFastMCPBackend` is gone too.
- **`authenticate` receives the web `Request` everywhere**, including protected routes on Node, where 1.x passed `http.IncomingMessage`. Its type is now `(request: Request | undefined) => Promise<T>`. `getRequestHeader` reads both shapes, so code that uses it keeps working.
- **A nullish `authenticate` result now fails protected artifacts and routes** with a 401, as it already did on the SDK backend's MCP endpoint. 1.x let it through on routes.
- **`addResourceTemplate` is typed:** it takes one `ResourceTemplate<T>`.
- **Removed options:** `httpStream.eventStore`, `streamKeepalive.logLevel`, and FastMCP's `backendOptions` (`ping`, `health`, `roots`, `oauth`).
- **Behavior from the SDK backend**, if you were on FastMCP: stateless serving, `isError` results for invalid arguments, `running` health from construction, and the rest of [The SDK Backend](#the-sdk-backend).
- **Gateways** use the SDK 2.x client; see [Gateways](#gateways).

## API Surface

**Core**

- `createServer(options)` → `SomaServerInstance`
- Types: `SomaServerOptions`, `SomaServerInstance`, `ServerHealth`, `ServerInfo`, `ServerCapabilities`, `CapabilitiesSummary`, `ToolOptions`

**Primitives** (somamcp-owned, no SDK types leak through)

- `Tool`, `Resource`, `Prompt`, `Context`, `Content`, `ContentResult`, `SessionAuth`, `UserError`

**Build info**

- `readBuildInfoFromEnv`, `resolveBuildInfo`, `getRuntimeInfo`
- Types: `BuildInfo`, `RuntimeInfo`

**Telemetry**

- `createConsoleTelemetry`, `createCompositeTelemetry`, `createLogLayerTelemetry`, `NoopTelemetry`
- `createJsonFileTelemetry` (`somamcp/node` only)
- `classifyError`, `createEnrichedError`
- Types: `TelemetryCollector`, `TelemetryEvent`, `CaptureLevel`, `ToolCaptureConfig`, `ErrorCategory`

**Gateway**

- `createGateway`, `createGatewayManager`, `createProxiedTools`
- Types: `GatewayConfig`, `GatewayInstance`, `GatewayManagerInstance`, `GatewayStatus`

**Artifacts**

- `registerArtifacts`, `createDashboardArtifact`, `createHealthArtifact`, `createHealthDetailArtifact`, `createInfoArtifact`
- Types: `StaticArtifact`, `DynamicArtifact`, `DirectoryArtifact`, `ArtifactConfig`, `ArtifactAuthenticate`

**Auth & Routes**

- `createAuthMiddleware`, `getRequestHeader`
- Types: `Authenticate`, `OnUnauthorized`, `AuthMiddlewareConfig`, `RouteConfig`, `RouteMethod`

**Transport**

- Types: `TransportConfig`, `HttpStreamConfig` (`port`, `host`, `endpoint`, `cors`, `enableJsonResponse`, `stateless`, `sslCert` / `sslKey` / `sslCa`); listening needs `somamcp/node`
- `streamKeepalive` on `ServerConfig` — `{ enabled, intervalMs }`; see [The SDK Backend](#the-sdk-backend)

**Introspection**

- `createInfoTool` (auto-registered as `info`)
- `createHealthTool`, `createCapabilitiesTool`, `createConnectionsTool` (legacy, exported for manual use)

**Feedback**

- `createFeedbackTool`, `createGithubFeedback`, `createWebhookFeedback`
- `redact`, `DEFAULT_REDACTION_PATTERNS`
- Types: `FeedbackProvider`, `FeedbackToolOptions`, `GithubFeedbackOptions`, `WebhookFeedbackOptions`, `RedactionPattern`, `RedactionResult`, `NormalizedFeedback`, `FeedbackSubmitResult`

**Content helpers**

- `imageContent`, `audioContent` (`{ buffer }` or `{ url }`; `somamcp/node` adds `{ path }`)
- Types: `ContentInput`, `NodeContentInput` (`somamcp/node`)

**Backend** (`somamcp` and `somamcp/backend`)

- `createSdkBackend`; `createNodeBackend` (`somamcp/node` only)
- Types: `BackendAdapter`, `BackendFactory`, `BackendSession`, `SdkBackendOptions`

## Scripts

```bash
pnpm validate       # Pre-commit: format + lint + typecheck + test + build
pnpm test           # Run tests
pnpm build          # Build via tsdown
pnpm dev            # Watch mode
pnpm typecheck      # Type check only
```

## License

MIT © Jordan Burke
