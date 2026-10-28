# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

somamcp is a framework for building MCP (Model Context Protocol) servers with telemetry, introspection, and a backend abstraction layer. It builds on the official MCP TypeScript SDK 2.x (`@modelcontextprotocol/server`) behind a `BackendAdapter` interface. The primary entry point is `createServer()`.

**The main entry is WinterTC-only.** Nothing reachable from `src/index.ts` may import `node:*`, a Node-only package (`@hono/node-server`, `@modelcontextprotocol/server/stdio`), or use a Node global (`Buffer`, `process`). Node-only code lives in `src/node/` and is reached only from `src/node/index.ts` (`somamcp/node`). `scripts/check-worker-bundle.mjs` (the last step of `pnpm validate`) enforces this on the built output, and also that the core is emitted once, so `somamcp/node` shares the main entry's modules. It reads somamcp's own emitted code; dependencies are external. `test/scripts/check-worker-bundle.test.ts` proves each check fails on a leak. `test/workers/workerd.test.ts` bundles `test/workers/worker.ts` with esbuild and runs it in workerd through Miniflare, without `nodejs_compat`, so a Node global on the request path fails a test, dependencies included. (`@cloudflare/vitest-pool-workers` supports vitest 4 only.)

## Commands

```bash
pnpm validate                              # Pre-commit: format + lint + typecheck + test + build
pnpm test                                  # Run tests once
pnpm vitest run test/Server.test.ts        # Run single test file
pnpm build                                 # Production build via tsdown
pnpm dev                                   # Watch mode build
pnpm typecheck                             # TypeScript type checking only
```

All scripts delegate to `ts-builds` (centralized TypeScript toolchain). Build config is in `tsdown.config.ts`, TS config extends `ts-builds/tsconfig`.

## Architecture

### Backend Abstraction (`src/backend/`)

**Design constraint**: the MCP SDK server is only imported in `src/backend/sdk/` (and its Node transports in `src/node/listen.ts`). All other source files import from `src/types/` (somamcp-owned types).

- **`adapter.ts`** — defines `BackendAdapter<T>` interface: the contract somamcp uses to talk to any MCP implementation (addTool, addResource, addPrompt, start, stop, getApp, on events)
- **`sdk/index.ts`** — `buildSdkBackend(transports, config, options)`: the SDK 2.x backend. A Hono app whose MCP path goes to `createMcpHandler`, which serves `2026-07-28` and 2025 clients statelessly. `createSdkBackend` is it with no transports (fetch only); `createNodeBackend` (`src/node/backend.ts`) plugs in a port and stdio
- **`sdk/handlers.ts`** — builds a low-level SDK `Server` per request whose handlers read somamcp's registries (tools, resources, templates, prompts, completions)
- **`sdk/mapping.ts`** — somamcp types ↔ SDK wire types (JSON Schema, results, tool context)
- **`sdk/transports.ts`** — the `SdkTransports` type that `somamcp/node` implements

### somamcp Types (`src/types/`)

somamcp owns its own MCP primitive types, structurally compatible with the MCP SDK's wire types but independently defined:

- **`core.ts`** — `Tool`, `Resource`, `Prompt`, `Context`, `Content` (union of Text/Image/Audio/Resource/ResourceLink), `ContentResult`, `SessionAuth`, `SchemaParams`, `ServerStatus`, `UserError`
- **`server.ts`** — `ServerConfig`, `TransportConfig`, `Logger`

The generic auth parameter is `SessionAuth` (= `Record<string, unknown> | undefined`), threaded through Tool, Resource, Prompt, Context, and the server instance.

### Server (`src/Server.ts`)

`createServer(options)` is the main factory. It creates a `SomaServerInstance` — a wrapper around `BackendAdapter` that adds:

- **Telemetry wrapping** — every tool/resource/prompt gets wrapped with timing/error telemetry
- **Gateway management** — on `start()`, connects to configured remote MCP servers and proxies their tools
- **Introspection tool** — auto-registers `info` (`introspectionPrefix: "soma_"` → `soma_info`) unless `enableIntrospection: false`. `createHealthTool`, `createCapabilitiesTool` and `createConnectionsTool` are exported for manual use
- **Artifact serving** — registers HTTP routes on the Hono app (including an auto-generated dashboard)

`SomaServerOptions` extends `ServerConfig` with: `gateways`, `telemetry`, `artifacts`, `enableDashboard`, `enableIntrospection`, `backendOptions` (opaque pass-through to the backend; the SDK backend reads `SdkBackendOptions`).

### Server-level Types (`src/types.ts`)

Defines `SomaServerOptions`, `SomaServerInstance`, `ServerHealth`, `ServerCapabilities`, `ToolOptions`. These compose the types from `src/types/core.ts` with server-specific concerns.

### Gateway System (`src/gateway/`)

Enables server-to-server MCP communication via the SDK 2.x client (`@modelcontextprotocol/client`) and its `StreamableHTTPClientTransport`, negotiating `2026-07-28` or falling back to the 2025 handshake.

- **`Gateway.ts`** — `createGateway()` manages connection lifecycle, auto-reconnect, and remote tool discovery
- **`GatewayManager.ts`** — manages multiple gateways with `connectAll()`/`disconnectAll()` via `Promise.allSettled`
- **`toolProxy.ts`** — `createProxiedTools()` wraps remote tools as local tools with a configurable prefix

### Telemetry (`src/telemetry/`)

Pluggable via `TelemetryCollector` interface (`recordEvent` + optional `flush`). Five collectors: `NoopTelemetry` (default), `ConsoleTelemetry`, `LogLayerTelemetry`, `CompositeTelemetry`, and `JsonFileTelemetry` (`src/node/`, `somamcp/node` only).

- **`telemetryWrapper.ts`** — `wrapTool`, `wrapResource`, `wrapPrompt` decorators that record execution time, errors, and input/output with configurable capture levels and field redaction
- **`EnrichedError.ts`** — `classifyError()` categorizes errors into 6 categories with contextual suggestions

Telemetry event types: `server.start`, `server.stop`, `tool.execute`, `tool.error`, `resource.load`, `resource.error`, `prompt.load`, `prompt.error`, `gateway.*`, `session.*`.

### Artifacts (`src/artifacts/`)

HTTP endpoints on the Hono app. Types: `StaticArtifact`, `DynamicArtifact`, `DirectoryArtifact`. `DashboardArtifact` auto-generates an HTML dashboard at `/dashboard`.

### OAuth Server (`src/node/oauth/`, `somamcp/node` only)

An OAuth 2.1 authorization server in front of an upstream provider. `createAzureProvider` and `createOAuthProxyProvider` (`provider.ts`) return an `AuthProvider` (`src/types/auth.ts`) for `createServer({ auth })`. The modules:

- `server.ts` puts the pieces together
- `authorization.ts` is the browser flow (authorize, consent, callback)
- `grants.ts` is the token endpoint, and runs `acceptSignIn` again on every refresh; `jwt.ts` marks each token `access` or `refresh` (`token_use`)
- `scopes.ts` caps what a client can ask the provider for at the server's `scopes`
- `upstream.ts` talks to the provider
- `clients.ts` is registration. A client is kept for `lifetimes.client` (90 days) after it registered, or last completed a sign-in or a refresh
- `http.ts` holds the routes and the MCP 401
- `pages.ts` is the HTML: no scripts (the CSP forbids them), so the long scope list folds with `<details>`
- `provider.ts` builds the session tools see: `claims` from the id token (never the access token, which Microsoft calls opaque), and for Azure `oid`, `tid` and `upn`, plus the tenant check when `tenantId` is a GUID
- `errors.ts` is the `OAuthError` union; `http.ts` turns it into wire codes, and `authorization.ts` does the same on redirects back to a client

**Compatibility is the contract, one way.** somamcp must keep reading what FastMCP 4.22.10 wrote, or every user of a server moved off FastMCP has to sign in again. Nothing moves back to FastMCP (Jordan, 2026-10-27), so FastMCP need not read what somamcp writes. The contract covers:

- the key prefixes and record shapes
- the DiskStore file names and `{ expiresAt, value }` files
- the `"<iv>:<tag>:<ciphertext>"` AES-256-GCM format with the `fastmcp-oauth-proxy-salt` scrypt key
- the HS256 JWT format in `jwt.ts`. somamcp's own tokens add `token_use`; FastMCP's lack it and are accepted in either role

`test/node/oauth-compat.test.ts` reads what FastMCP wrote (`test/fixtures/fastmcp-4.22.10-oauth`), and is the check that matters. `pnpm build && node test/fixtures/fastmcp-4.22.10-oauth/xcheck.mjs dist/node/index.js <fastmcp-4.22.10 dist>` also runs both servers on one store; its FastMCP-reads-somamcp checks are informational. Everything else, such as error wording, pages and structure, is somamcp's own.

### Content Helpers (`src/content/`)

`imageContent()` and `audioContent()` — read from bytes (`{ buffer }`, any `Uint8Array`) or a URL, base64-encode without `Buffer`, and infer MIME type from extension. `src/node/content.ts` wraps them to also read `{ path }` from disk.

## Key Patterns

- **Factory functions over classes** — all modules export `create*` factories returning typed object literals
- **Closure-based state** — mutable state held via functype's `Ref<T>` (closure-based mutable cell)
- **`SessionAuth` threading** — generic type parameter `T` propagates through Server, tools, gateways, backend
- **`backendOptions` pass-through** — backend-specific config goes through `backendOptions: Record<string, unknown>`; the SDK backend reads `SdkBackendOptions` (`mcpPath`, `stdioTransport`)
- **Error handling** — `Try.fromPromise()` + `.fold()` pattern in telemetry wrappers and tool proxy; errors converted to `ContentResult` with `isError: true`

## Package Exports

- `"somamcp"` — main public API, WinterTC-only (createServer → SDK backend, types, telemetry, gateway, artifacts, introspection)
- `"somamcp/node"` — re-exports `somamcp`, plus `createServer` → `createNodeBackend` (port + stdio), `createJsonFileTelemetry`, and content helpers that read `{ path }`
- `"somamcp/backend"` — backend adapter types and `createSdkBackend` for advanced use
- `"somamcp/edge"` — alias of `somamcp`, kept through 2.x; removed in 3.0

All entries build in one tsdown pass so they share chunks; see `tsdown.config.ts`.
