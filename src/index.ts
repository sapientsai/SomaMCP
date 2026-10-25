// somamcp — the main entry. It uses WinterTC APIs only (fetch, Request/Response,
// Web Streams, Web Crypto), so it runs on Cloudflare Workers without
// nodejs_compat, and on Deno, Bun and Node. Nothing reachable from here may import
// `node:*` or use a Node global; `pnpm build` checks the bundle. Node-only
// features live in `somamcp/node`, which re-exports everything here.

// Core
import { createSdkBackend } from "./backend/sdk/index.js"
import { createServerCore } from "./Server.js"
import type { SomaServerInstance, SomaServerOptions } from "./types.js"
import type { SessionAuth } from "./types/core.js"

/**
 * Create a server on the MCP SDK 2.x backend. Serve it with `server.fetch`:
 *
 * ```ts
 * const server = createServer({ name: "my-server", version: "1.0.0" })
 * export default { fetch: (req: Request) => server.fetch(req) }
 * ```
 *
 * To listen on a port or on stdio, import `createServer` from `somamcp/node` instead.
 */
export const createServer = <T extends SessionAuth = SessionAuth>(
  options: SomaServerOptions<T>,
): SomaServerInstance<T> => createServerCore({ ...options, backend: options.backend ?? createSdkBackend<T> })

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
  ImageContent,
  InferSchemaOutput,
  Progress,
  Prompt,
  PromptArgument,
  PromptResult,
  Resource,
  ResourceContent,
  ResourceLink,
  ResourceResult,
  ResourceTemplate,
  ResourceTemplateArgument,
  SchemaParams,
  ServerStatus,
  SessionAuth,
  TextContent,
  Tool,
  ToolAnnotations,
} from "./types/index.js"
export type {
  AuthChallenge,
  AuthProvider,
  AuthRoute,
  HttpStreamConfig,
  Logger,
  RouteConfig,
  RouteMethod,
  ServerConfig,
  TransportConfig,
} from "./types/index.js"
export { UserError } from "./types/index.js"

// Auth helpers (for `authenticate` callbacks + custom middleware)
export type { Authenticate, AuthMiddlewareConfig, OnUnauthorized } from "./auth/index.js"
export { createAuthMiddleware, getRequestHeader } from "./auth/index.js"

// Content helpers
export type { ContentInput } from "./content/index.js"
export { audioContent, imageContent } from "./content/index.js"

// Backend
export type { BackendAdapter, BackendFactory, BackendSession, SdkBackendOptions } from "./backend/index.js"
export { createSdkBackend } from "./backend/index.js"

// Telemetry
export type {
  CaptureLevel,
  ErrorCategory,
  TelemetryCollector,
  TelemetryEvent,
  TelemetryEventType,
  ToolCaptureConfig,
} from "./telemetry/index.js"
export type { EnrichedErrorResponse } from "./telemetry/index.js"
export {
  classifyError,
  createCompositeTelemetry,
  createConsoleTelemetry,
  createEnrichedError,
  createLogLayerTelemetry,
  NoopTelemetry,
} from "./telemetry/index.js"
export { wrapPrompt, wrapResource, wrapTool } from "./telemetry/index.js"

// Logging
export { createDefaultLogger } from "./logging.js"
export type { DirectLogger } from "functype-log"

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

// Gateway
export type {
  GatewayConfig,
  GatewayInfo,
  GatewayInstance,
  GatewayManagerInstance,
  GatewayStatus,
} from "./gateway/index.js"
export { createGateway, createGatewayManager, createProxiedTools } from "./gateway/index.js"
