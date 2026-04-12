# somamcp

Framework for building **MCP (Model Context Protocol)** servers with built-in telemetry, introspection, and a backend abstraction layer.

somamcp wraps an underlying MCP framework (currently [FastMCP](https://github.com/punkpeye/fastmcp)) behind a `BackendAdapter` interface — giving you a stable API surface, automatic telemetry, gateway-based server composition, and HTTP artifacts out of the box.

## Features

- **Backend abstraction** — framework-agnostic `BackendAdapter` interface; swap the underlying MCP framework without changing consumer code
- **Structured telemetry** — pluggable `TelemetryCollector` with console, file (NDJSON), composite, and [functype-log](https://github.com/jordanburke/functype-log) adapters
- **Error classification & enrichment** — errors are auto-classified (validation / timeout / gateway / auth / not_found / internal) with actionable suggestions for LLMs
- **Per-tool capture config** — configure input/output capture levels, field redaction, and output size limits per tool
- **Gateway system** — connect to remote MCP servers and proxy their tools as local tools
- **Auto-introspection** — `soma_health`, `soma_capabilities`, `soma_connections` tools registered by default
- **HTTP artifacts** — mount static or dynamic routes on the embedded [Hono](https://hono.dev) app, including an auto-generated dashboard
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

## Artifacts & Dashboard

Mount HTTP routes on the embedded Hono app. A health dashboard is auto-mounted at `/dashboard` unless disabled.

```typescript
const server = createServer({
  name: "my-server",
  version: "1.0.0",
  enableDashboard: true, // default
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

## Introspection

Three tools are auto-registered (disable with `enableIntrospection: false`):

- **`soma_health`** — server status, uptime, active sessions, gateway count
- **`soma_capabilities`** — registered tools, resources, prompts
- **`soma_connections`** — gateway connection info

## Backend Abstraction

The underlying MCP framework is accessed exclusively through the `BackendAdapter` interface. To use a non-FastMCP backend, implement `BackendFactory`:

```typescript
import { createFastMCPBackend } from "somamcp/backend"
import type { BackendFactory } from "somamcp/backend"

const myBackend: BackendFactory = (config, backendOptions) => {
  // ...
}
```

Framework-specific options (e.g. FastMCP's OAuth, ping, health endpoints) flow through `backendOptions`:

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
- Types: `SomaServerOptions`, `SomaServerInstance`, `ServerHealth`, `ServerCapabilities`, `ToolOptions`

**Primitives** (somamcp-owned, no FastMCP leakage)

- `Tool`, `Resource`, `Prompt`, `Context`, `Content`, `ContentResult`, `SessionAuth`, `UserError`

**Telemetry**

- `createConsoleTelemetry`, `createJsonFileTelemetry`, `createCompositeTelemetry`, `createLogLayerTelemetry`, `NoopTelemetry`
- `classifyError`, `createEnrichedError`
- Types: `TelemetryCollector`, `TelemetryEvent`, `CaptureLevel`, `ToolCaptureConfig`, `ErrorCategory`

**Gateway**

- `createGateway`, `createGatewayManager`, `createProxiedTools`
- Types: `GatewayConfig`, `GatewayInstance`, `GatewayManagerInstance`, `GatewayStatus`

**Artifacts**

- `registerArtifacts`, `createDashboardArtifact`
- Types: `StaticArtifact`, `DynamicArtifact`, `DirectoryArtifact`, `ArtifactConfig`

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
