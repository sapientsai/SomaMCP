# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

somamcp is a framework for building MCP (Model Context Protocol) servers with telemetry, introspection, and a backend abstraction layer. It wraps an underlying MCP framework (currently FastMCP) behind a `BackendAdapter` interface so the framework can be swapped without breaking consumers. The primary entry point is `createServer()`.

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

**Critical design constraint**: FastMCP is only imported in `src/backend/fastmcp.ts`. All other source files import from `src/types/` (somamcp-owned types). This isolation means swapping FastMCP requires changing one file.

- **`adapter.ts`** — defines `BackendAdapter<T>` interface: the contract somamcp uses to talk to any MCP framework (addTool, addResource, addPrompt, start, stop, getApp, on events)
- **`fastmcp.ts`** — `createFastMCPBackend()` implements `BackendAdapter` by delegating to a `FastMCP` instance. Types are structurally compatible; boundary uses `unknown` casts (no `any`)

### somamcp Types (`src/types/`)

somamcp owns its own MCP primitive types that are structurally identical to FastMCP's but independently defined:

- **`core.ts`** — `Tool`, `Resource`, `Prompt`, `Context`, `Content` (union of Text/Image/Audio/Resource/ResourceLink), `ContentResult`, `SessionAuth`, `SchemaParams`, `ServerStatus`, `UserError`
- **`server.ts`** — `ServerConfig`, `TransportConfig`, `Logger`

The generic auth parameter is `SessionAuth` (= `Record<string, unknown> | undefined`), threaded through Tool, Resource, Prompt, Context, and the server instance.

### Server (`src/Server.ts`)

`createServer(options)` is the main factory. It creates a `SomaServerInstance` — a wrapper around `BackendAdapter` that adds:

- **Telemetry wrapping** — every tool/resource/prompt gets wrapped with timing/error telemetry
- **Gateway management** — on `start()`, connects to configured remote MCP servers and proxies their tools
- **Introspection tools** — auto-registers `soma_health`, `soma_capabilities`, `soma_connections` (unless `enableIntrospection: false`)
- **Artifact serving** — registers HTTP routes on the Hono app (including an auto-generated dashboard)

`SomaServerOptions` extends `ServerConfig` with: `gateways`, `telemetry`, `artifacts`, `enableDashboard`, `enableIntrospection`, `backendOptions` (opaque pass-through to the backend for framework-specific config like OAuth, health endpoints, ping).

### Server-level Types (`src/types.ts`)

Defines `SomaServerOptions`, `SomaServerInstance`, `ServerHealth`, `ServerCapabilities`, `ToolOptions`. These compose the types from `src/types/core.ts` with server-specific concerns.

### Gateway System (`src/gateway/`)

Enables server-to-server MCP communication via the SDK 2.x client (`@modelcontextprotocol/client`) and its `StreamableHTTPClientTransport`, negotiating `2026-07-28` or falling back to the 2025 handshake.

- **`Gateway.ts`** — `createGateway()` manages connection lifecycle, auto-reconnect, and remote tool discovery
- **`GatewayManager.ts`** — manages multiple gateways with `connectAll()`/`disconnectAll()` via `Promise.allSettled`
- **`toolProxy.ts`** — `createProxiedTools()` wraps remote tools as local tools with a configurable prefix

### Telemetry (`src/telemetry/`)

Pluggable via `TelemetryCollector` interface (`recordEvent` + optional `flush`). Five collectors: `NoopTelemetry` (default), `ConsoleTelemetry`, `JsonFileTelemetry`, `LogLayerTelemetry`, `CompositeTelemetry`.

- **`telemetryWrapper.ts`** — `wrapTool`, `wrapResource`, `wrapPrompt` decorators that record execution time, errors, and input/output with configurable capture levels and field redaction
- **`EnrichedError.ts`** — `classifyError()` categorizes errors into 6 categories with contextual suggestions

Telemetry event types: `server.start`, `server.stop`, `tool.execute`, `tool.error`, `resource.load`, `resource.error`, `prompt.load`, `prompt.error`, `gateway.*`, `session.*`.

### Artifacts (`src/artifacts/`)

HTTP endpoints on the Hono app. Types: `StaticArtifact`, `DynamicArtifact`, `DirectoryArtifact`. `DashboardArtifact` auto-generates an HTML dashboard at `/dashboard`.

### Content Helpers (`src/content/`)

`imageContent()` and `audioContent()` — read from buffer/path/URL, base64-encode, and infer MIME type from extension. These are somamcp-owned (no FastMCP dependency).

## Key Patterns

- **Factory functions over classes** — all modules export `create*` factories returning typed object literals
- **Closure-based state** — mutable state held via functype's `Ref<T>` (closure-based mutable cell)
- **`SessionAuth` threading** — generic type parameter `T` propagates through Server, tools, gateways, backend
- **`backendOptions` pass-through** — FastMCP-specific config (OAuth, health, ping, roots) goes through `backendOptions: Record<string, unknown>` without somamcp needing to know about it
- **Error handling** — `Try.fromPromise()` + `.fold()` pattern in telemetry wrappers and tool proxy; errors converted to `ContentResult` with `isError: true`

## Package Exports

- `"somamcp"` — main public API (createServer, types, telemetry, gateway, artifacts, introspection)
- `"somamcp/backend"` — backend adapter types and `createFastMCPBackend` for advanced use
