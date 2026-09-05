# SomaMCP

Framework for building **MCP (Model Context Protocol)** servers with built-in telemetry, introspection, agent feedback, and a backend abstraction layer.

somamcp wraps an underlying MCP framework (currently [FastMCP](https://github.com/punkpeye/fastmcp)) behind a `BackendAdapter` interface — giving you a stable API surface, automatic telemetry, gateway-based server composition, identity/health endpoints with sensible security defaults, and HTTP artifacts out of the box.

## Features

- **Backend abstraction** — framework-agnostic `BackendAdapter` interface; swap the underlying MCP framework without changing consumer code
- **Structured telemetry** — pluggable `TelemetryCollector` with console, file (NDJSON), composite, and [functype-log](https://github.com/jordanburke/functype-log) adapters
- **Error classification & enrichment** — errors are auto-classified (validation / timeout / gateway / auth / not_found / internal) with actionable suggestions for LLMs
- **Per-tool capture config** — configure input/output capture levels, field redaction, and output size limits per tool
- **Gateway system** — connect to remote MCP servers and proxy their tools as local tools
- **Identity & build info** — `info` MCP tool returns name, version, build commit, runtime, and capability counts; auto-populated from `SOMAMCP_BUILD_*` env vars
- **Two-tier health** — public `/health` (minimal, for Docker/k8s probes) + protected `/health/detail` (full operational state)
- **Protected artifacts** — `protected: true` on any artifact reuses FastMCP's `authenticate` callback; dashboard and `/info` protected by default
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

```typescript
import { createServer } from "somamcp"
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

Any artifact can opt into auth with `protected: true`. The route runs FastMCP's `authenticate` callback via Hono middleware — same auth model as MCP protocol calls. If `protected: true` is set but no `authenticate` is configured, the route returns 401 unconditionally.

```typescript
import { createServer, getRequestHeader } from "somamcp"

createServer({
  name: "my-server",
  version: "1.0.0",
  // `authenticate` receives either a Hono Request (routes/artifacts) or an
  // http.IncomingMessage (MCP transport). `getRequestHeader` hides the shape difference.
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

A tool's `execute` may return a plain string **or** a full content-array with multimodal parts — telemetry passes the return value through unchanged. Use the exported `imageContent` / `audioContent` helpers to build parts without reaching into the backend.

```typescript
import { createServer, imageContent } from "somamcp"

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
import { createServer, createCompositeTelemetry, createConsoleTelemetry, createJsonFileTelemetry } from "somamcp"

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

await server.start({
  transportType: "httpStream",
  httpStream: { port: 8080 },
})
```

## Edge Runtimes (Cloudflare Workers, Deno Deploy, Bun)

Import from `somamcp/edge` instead of `somamcp`. The API is identical — `backend` just defaults to `createEdgeBackend` rather than the Node FastMCP backend.

```typescript
import { createServer } from "somamcp/edge"
import { z } from "zod"

const server = createServer({
  name: "my-worker",
  version: "1.0.0",
  // Workers has no process.env — pass build info from the fetch handler's `env`.
  build: { commit: "abc123", environment: "production" },
})

server.addTool({
  name: "greet",
  description: "Greet someone by name",
  parameters: z.object({ name: z.string() }),
  execute: async ({ name }) => `Hello, ${name}!`,
})

export default {
  fetch: (request: Request) => server.fetch(request),
}
```

`server.fetch` serves both the MCP endpoint and every artifact/route you register, so `/health`, `/info`, and `/dashboard` work as they do on Node.

### Why a separate entry point

The root `somamcp` barrel exports `createJsonFileTelemetry`, `imageContent`, and `audioContent`, which import `node:fs`. Importing it from a Worker pulls Node built-ins into the bundle. `somamcp/edge` is built as a separate pass with no shared chunks, and `pnpm check:edge` fails the build if any `node:` import reaches the edge output.

### Feature parity

| Feature                                            | Node (`somamcp`) | Edge (`somamcp/edge`)             |
| -------------------------------------------------- | ---------------- | --------------------------------- |
| Tools, resources, prompts                          | ✅               | ✅                                |
| Artifacts, `addRoute`, auth middleware             | ✅               | ✅                                |
| `authenticate` on the MCP endpoint                 | ✅               | ✅ — enforced by somamcp          |
| `/health`, `/health/detail`, `/info`, `/dashboard` | ✅               | ✅                                |
| `info` introspection tool                          | ✅               | ✅                                |
| Telemetry (console, composite, custom)             | ✅               | ✅                                |
| Tool errors (`isError`)                            | ✅               | ✅ — sent as JSON-RPC errors      |
| File telemetry, `imageContent` / `audioContent`    | ✅               | ❌ — need `node:fs`               |
| stdio transport                                    | ✅               | ❌ — HTTP only                    |
| Sessions, `connect` / `disconnect` events          | ✅               | ❌ — stateless                    |
| Gateways (proxying remote MCP servers)             | ✅               | ⚠️ requires `start()` — see below |
| Multi-result resources (`load()` returning array)  | ✅               | ⚠️ first result only, warns       |
| `reportProgress` / `streamContent` in tools        | ✅               | ⚠️ inert no-ops                   |
| `removeTool` / `removeResource` / `removePrompt`   | ✅               | ⚠️ warns, does nothing            |
| `supportsRemoval`                                  | `true`           | `false`                           |
| `addResourceTemplate`                              | ✅               | ⚠️ warns, does nothing            |

The ⚠️ rows are limits of `EdgeFastMCP`, which exposes no removal API, has no server→client channel, and treats resources as single-valued. They log through `config.logger` rather than failing, so passing a `logger` is recommended on edge.

**Capability counts.** `getInfo().capabilities` counts every tool actually served — including the built-in `info` tool and any proxied gateway tools. Because the edge backend reports `supportsRemoval: false`, a `removeTool` there leaves the count untouched: the tool is still being served, so it is still counted.

**Auth.** `EdgeFastMCPOptions` has no `authenticate` field, so somamcp gates the MCP endpoint itself with the same middleware that protects artifacts and routes. Behaviour matches Node: configure `authenticate`, and unauthenticated MCP calls get a 401.

**Tool errors.** `EdgeFastMCP` builds its response as `result: { content }` and discards `isError`, which would make a failed tool look successful. The edge adapter rethrows on `isError` so the client receives a JSON-RPC error instead.

**Gateways** need `await server.start()` to connect and register proxied tools. Workers forbids network I/O at module scope, so call it lazily inside your first request rather than at the top level. Without it, gateway tools are never registered.

**Registering routes late.** Hono builds its router on the first request and then rejects new routes ("matcher is already built"). Register every artifact and `addRoute` before serving traffic — on edge that means at module scope, not inside the fetch handler.

**Route precedence.** somamcp owns the outer Hono app and falls through to `EdgeFastMCP` for anything unmatched. This ordering is deliberate: `EdgeFastMCP` registers its own `/health` at construction, and Hono is first-match-wins, so mounting it first would shadow somamcp's health artifact.

**Runtime reporting.** `getInfo().runtime` is `"edge"` on Cloudflare Workers, Deno, and Vercel Edge, and `"node"` otherwise. Edge runtimes are detected positively — `navigator.userAgent === "Cloudflare-Workers"`, or a `Deno` / `EdgeRuntime` global — rather than by the absence of `process`, because Workers with `nodejs_compat` supplies a working `process.versions.node`. On edge, `arch` / `nodeVersion` / `platform` report `"unknown"` or the user agent, rather than describing the compatibility shim.

Bun deliberately reports `"node"`: it is a Node-family server runtime with full Node APIs, so that is the accurate answer even though `somamcp/edge` runs there.

## Backend Abstraction

The underlying MCP framework is accessed exclusively through the `BackendAdapter` interface. `createServer` accepts a `backend` factory — this is how `somamcp/edge` swaps in the edge adapter:

```typescript
import { createServer } from "somamcp"
import { createEdgeBackend } from "somamcp/edge"

// equivalent to importing createServer from "somamcp/edge"
const server = createServer({ name: "my-server", version: "1.0.0", backend: createEdgeBackend })
```

To use a different backend entirely, implement `BackendFactory`:

```typescript
import { createFastMCPBackend } from "somamcp/backend"
import type { BackendFactory } from "somamcp/backend"

const myBackend: BackendFactory = (config, backendOptions) => {
  // ...
}
```

Framework-specific options (e.g. FastMCP's OAuth, ping) flow through `backendOptions`:

```typescript
createServer({
  name: "my-server",
  version: "1.0.0",
  backendOptions: {
    ping: { enabled: true, intervalMs: 30000 },
    // ...any FastMCP ServerOptions fields
  },
})
```

## API Surface

**Core**

- `createServer(options)` → `SomaServerInstance`
- Types: `SomaServerOptions`, `SomaServerInstance`, `ServerHealth`, `ServerInfo`, `ServerCapabilities`, `CapabilitiesSummary`, `ToolOptions`

**Primitives** (somamcp-owned, no FastMCP leakage)

- `Tool`, `Resource`, `Prompt`, `Context`, `Content`, `ContentResult`, `SessionAuth`, `UserError`

**Build info**

- `readBuildInfoFromEnv`, `resolveBuildInfo`, `getRuntimeInfo`
- Types: `BuildInfo`, `RuntimeInfo`

**Telemetry**

- `createConsoleTelemetry`, `createJsonFileTelemetry`, `createCompositeTelemetry`, `createLogLayerTelemetry`, `NoopTelemetry`
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

- Types: `TransportConfig`, `HttpStreamConfig` (accepts `cors`, `stateless`, `eventStore`, `sslCert` / `sslKey` / `sslCa`, plus `port` / `host` / `endpoint` / `enableJsonResponse`)
- `streamKeepalive` on `ServerConfig` — `{ enabled, intervalMs }`, written onto an in-flight tool call's own
  response stream so a proxy does not close it as idle during a long, silent call. **Pair it with
  `httpStream.stateless`**: a transport-level ping needs the standing server-to-client stream that stateless
  does not have, so this is the only keepalive left. It sits on `ServerConfig` rather than `HttpStreamConfig`
  because the backend builds its server before `start()` sees the transport. Ignored by the edge backend.

**Introspection**

- `createInfoTool` (auto-registered as `info`)
- `createHealthTool`, `createCapabilitiesTool`, `createConnectionsTool` (legacy, exported for manual use)

**Feedback**

- `createFeedbackTool`, `createGithubFeedback`, `createWebhookFeedback`
- `redact`, `DEFAULT_REDACTION_PATTERNS`
- Types: `FeedbackProvider`, `FeedbackToolOptions`, `GithubFeedbackOptions`, `WebhookFeedbackOptions`, `RedactionPattern`, `RedactionResult`, `NormalizedFeedback`, `FeedbackSubmitResult`

**Content helpers**

- `imageContent`, `audioContent`

**Backend** (via `somamcp/backend`)

- `createFastMCPBackend`
- Types: `BackendAdapter`, `BackendFactory`, `BackendSession`

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
