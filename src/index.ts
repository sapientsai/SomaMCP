// Core
export { createServer } from "./Server.js"
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
  SchemaParams,
  ServerStatus,
  SessionAuth,
  TextContent,
  Tool,
  ToolAnnotations,
} from "./types/index.js"
export type { Logger, ServerConfig, TransportConfig } from "./types/index.js"
export { UserError } from "./types/index.js"

// Content helpers
export { audioContent, imageContent } from "./content/index.js"

// Backend
export type { BackendAdapter, BackendFactory, BackendSession } from "./backend/index.js"
export { createFastMCPBackend } from "./backend/index.js"

// Telemetry
export type {
  CaptureLevel,
  ErrorCategory,
  TelemetryCollector,
  TelemetryEvent,
  TelemetryEventType,
  ToolCaptureConfig,
} from "./telemetry/index.js"
export type { EnrichedErrorResponse, JsonFileTelemetryOptions } from "./telemetry/index.js"
export {
  classifyError,
  createCompositeTelemetry,
  createConsoleTelemetry,
  createEnrichedError,
  createJsonFileTelemetry,
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
