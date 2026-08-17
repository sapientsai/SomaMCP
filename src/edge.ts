// somamcp/edge — edge-runtime entry point (Cloudflare Workers, Deno Deploy, Bun).
//
// This barrel deliberately imports from source modules rather than the package
// barrels. `./index.js`, `./telemetry/index.js`, and `./content/index.js` all
// re-export helpers that import `node:fs` (createJsonFileTelemetry,
// imageContent, audioContent), which would drag Node built-ins into a Workers
// bundle. Anything exported here must be reachable without touching `node:*`.

// Core
import { createEdgeBackend } from "./backend/edge.js"
import { createServerCore } from "./Server.js"
import type { SomaServerInstance, SomaServerOptions } from "./types.js"
import type { SessionAuth } from "./types/core.js"

/**
 * Create a server backed by the edge runtime adapter. Identical to the `somamcp`
 * `createServer` except that `backend` defaults to `createEdgeBackend`.
 *
 * ```ts
 * const server = createServer({ name: "my-server", version: "1.0.0" })
 * export default { fetch: (req: Request) => server.fetch(req) }
 * ```
 */
export const createServer = <T extends SessionAuth = SessionAuth>(
  options: SomaServerOptions<T>,
): SomaServerInstance<T> => createServerCore({ ...options, backend: options.backend ?? createEdgeBackend<T> })

export { createServerCore } from "./Server.js"
export type {
  CapabilitiesSummary,
  ServerCapabilities,
  ServerHealth,
  ServerInfo,
  SomaServerInstance,
  SomaServerOptions,
  ToolOptions,
} from "./types.js"

// Edge backend
export type { BackendAdapter, BackendFactory, BackendSession } from "./backend/adapter.js"
export type { EdgeBackendOptions } from "./backend/edge.js"
export { createEdgeBackend } from "./backend/edge.js"

// Build info
export type { BuildInfo, RuntimeInfo } from "./buildInfo.js"
export { getRuntimeInfo, readBuildInfoFromEnv, resolveBuildInfo } from "./buildInfo.js"

// Types (somamcp-owned MCP primitives)
export type {
  AudioContent,
  Completion,
  Content,
  ContentResult,
  Context,
  HttpStreamConfig,
  ImageContent,
  InferSchemaOutput,
  Logger,
  Progress,
  Prompt,
  PromptArgument,
  PromptResult,
  Resource,
  ResourceContent,
  ResourceLink,
  ResourceResult,
  RouteConfig,
  RouteMethod,
  SchemaParams,
  ServerConfig,
  ServerStatus,
  SessionAuth,
  TextContent,
  Tool,
  ToolAnnotations,
  TransportConfig,
} from "./types/index.js"
export { UserError } from "./types/index.js"

// Auth helpers
export type { Authenticate, AuthMiddlewareConfig, OnUnauthorized } from "./auth/index.js"
export { createAuthMiddleware, getRequestHeader } from "./auth/index.js"

// Telemetry — file-backed collectors are Node-only and intentionally absent.
export { createCompositeTelemetry } from "./telemetry/CompositeTelemetry.js"
export { createConsoleTelemetry } from "./telemetry/ConsoleTelemetry.js"
export type { EnrichedErrorResponse } from "./telemetry/EnrichedError.js"
export { classifyError, createEnrichedError } from "./telemetry/EnrichedError.js"
export { NoopTelemetry } from "./telemetry/NoopTelemetry.js"
export type {
  CaptureLevel,
  ErrorCategory,
  TelemetryCollector,
  TelemetryEvent,
  TelemetryEventType,
  ToolCaptureConfig,
} from "./telemetry/TelemetryCollector.js"
export { wrapPrompt, wrapResource, wrapTool } from "./telemetry/telemetryWrapper.js"

// Artifacts
export type {
  ArtifactAuthenticate,
  ArtifactConfig,
  DirectoryArtifact,
  DynamicArtifact,
  StaticArtifact,
} from "./artifacts/index.js"
export {
  createDashboardArtifact,
  createHealthArtifact,
  createHealthDetailArtifact,
  createInfoArtifact,
  DEFAULT_HEALTH_DETAIL_PATH,
  DEFAULT_HEALTH_PATH,
  DEFAULT_INFO_PATH,
  registerArtifacts,
} from "./artifacts/index.js"

// Introspection
export {
  createCapabilitiesTool,
  createConnectionsTool,
  createHealthTool,
  createInfoTool,
} from "./introspection/index.js"

// Feedback
export type {
  FeedbackEnrichmentContext,
  FeedbackProvider,
  FeedbackSeverity,
  FeedbackSubmitFailure,
  FeedbackSubmitResult,
  FeedbackSubmitSuccess,
  FeedbackToolOptions,
  FeedbackType,
  GithubFeedbackOptions,
  NormalizedFeedback,
  RedactionPattern,
  RedactionResult,
  WebhookFeedbackOptions,
} from "./feedback/index.js"
export {
  createFeedbackTool,
  createGithubFeedback,
  createWebhookFeedback,
  DEFAULT_REDACTION_PATTERNS,
  redact,
} from "./feedback/index.js"

// Gateway — uses StreamableHTTPClientTransport (fetch-based), edge-safe.
export type {
  GatewayConfig,
  GatewayInfo,
  GatewayInstance,
  GatewayManagerInstance,
  GatewayStatus,
} from "./gateway/index.js"
export { createGateway, createGatewayManager, createProxiedTools } from "./gateway/index.js"
