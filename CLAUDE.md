# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Somamcp is a **cell-based architecture framework** for building MCP (Model Context Protocol) servers. It wraps [FastMCP](https://github.com/punkpeye/fastmcp) with higher-level abstractions: cells, gateways, telemetry, artifacts, and introspection. A "Cell" is an enhanced MCP server that can connect to other MCP servers (via gateways), proxy their tools, serve HTTP artifacts, and collect telemetry.

## Commands

```bash
pnpm validate          # Pre-commit: format + lint + typecheck + test + build
pnpm test              # Run tests once
pnpm vitest run test/Cell.test.ts  # Run single test file
pnpm build             # Production build via tsdown
pnpm dev               # Watch mode build
pnpm typecheck         # TypeScript type checking only
```

All scripts delegate to `ts-builds` (centralized TypeScript toolchain). Build config is in `tsdown.config.ts`, TS config extends `ts-builds/tsconfig`.

## Architecture

### Cell (`src/Cell.ts`)

The central abstraction. `createCell(options)` is the factory that produces a `CellInstance` — a wrapper around `FastMCP` that adds:

- **Telemetry wrapping** — every tool/resource/prompt registered via the cell gets wrapped with timing/error telemetry (`src/telemetry/telemetryWrapper.ts`)
- **Gateway management** — on `start()`, connects to configured remote MCP servers and proxies their tools into this server
- **Introspection tools** — auto-registers `soma_health`, `soma_capabilities`, `soma_connections` tools (unless `enableIntrospection: false`)
- **Artifact serving** — registers HTTP routes on FastMCP's Hono app (including an auto-generated dashboard)
- **Session tracking** — emits telemetry events on client connect/disconnect

`CellOptions` extends FastMCP's `ServerOptions` with: `gateways`, `telemetry`, `artifacts`, `enableDashboard`, `enableIntrospection`.

### Gateway System (`src/gateway/`)

Enables cell-to-cell communication. A gateway connects to a remote MCP server via `StreamableHTTPClientTransport` (from `@modelcontextprotocol/sdk`).

- **`Gateway.ts`** — `createGateway()` factory. Manages connection lifecycle, auto-reconnect, and remote tool discovery via `client.listTools()`
- **`GatewayManager.ts`** — `createGatewayManager()` manages multiple gateways. Provides `connectAll()`/`disconnectAll()` with `Promise.allSettled`
- **`toolProxy.ts`** — `createProxiedTools()` takes a connected gateway's remote tools and wraps them as local FastMCP tools with a configurable prefix (default: `{gatewayId}_`)

### Telemetry (`src/telemetry/`)

Pluggable telemetry via `TelemetryCollector` interface (just `recordEvent` + optional `flush`). Two built-in implementations:

- `NoopTelemetry` — default, discards events
- `ConsoleTelemetry` — logs to console

`telemetryWrapper.ts` provides `wrapTool`, `wrapResource`, `wrapPrompt` — decorators that record execution time and errors.

### Artifacts (`src/artifacts/`)

HTTP endpoints registered on FastMCP's Hono app. Three types: `StaticArtifact` (string content), `DynamicArtifact` (Hono handler), `DirectoryArtifact` (placeholder). `DashboardArtifact` auto-generates an HTML dashboard at `/dashboard`.

### Introspection (`src/introspection/`)

Three auto-registered MCP tools that expose cell state: health status, registered capabilities, and gateway connections.

## Key Dependencies

- **fastmcp** — MCP server framework (provides `FastMCP`, `Tool`, `Resource`, `InputPrompt` types)
- **@modelcontextprotocol/sdk** — Official MCP SDK (used by gateway for `Client` + `StreamableHTTPClientTransport`)
- **hono** — HTTP framework (FastMCP's internal app, used for artifacts)
- **zod** — Schema validation (tool parameter schemas)
- **functype** — FP library (available but lightly used currently)

## Patterns

- **Factory functions over classes** — all modules export `create*` factories returning typed object literals (not `new Class()`)
- **Closure-based state** — mutable state is held in closure variables with `eslint-disable functional/no-let` annotations
- **Generic auth threading** — `FastMCPSessionAuth` type parameter `T` is threaded through Cell, tools, gateways to support custom auth
- **Tests use `get-port-please`** — for dynamic port allocation in integration tests
