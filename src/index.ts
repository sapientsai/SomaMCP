// Core
export { createCell } from "./Cell.js"
export type { CellCapabilities, CellHealth, CellInstance, CellOptions, CellTool } from "./types.js"

// Telemetry
export type { TelemetryCollector, TelemetryEvent, TelemetryEventType } from "./telemetry/index.js"
export { createConsoleTelemetry, createLogLayerTelemetry, NoopTelemetry } from "./telemetry/index.js"
export { wrapPrompt, wrapResource, wrapTool } from "./telemetry/index.js"

// Logging
export { createDefaultLogger } from "./logging.js"
export type { ILogLayer } from "loglayer"

// Artifacts
export type { ArtifactConfig, DirectoryArtifact, DynamicArtifact, StaticArtifact } from "./artifacts/index.js"
export { createDashboardArtifact, registerArtifacts } from "./artifacts/index.js"

// Introspection
export { createCapabilitiesTool, createConnectionsTool, createHealthTool } from "./introspection/index.js"

// Gateway
export type {
  GatewayConfig,
  GatewayInfo,
  GatewayInstance,
  GatewayManagerInstance,
  GatewayStatus,
} from "./gateway/index.js"
export { createGateway, createGatewayManager, createProxiedTools } from "./gateway/index.js"

// Re-export key FastMCP types
export type {
  Content,
  ContentResult,
  Context,
  InputPrompt,
  InputPromptArgument,
  Resource,
  ServerOptions,
  Tool,
  ToolParameters,
} from "fastmcp"
export {
  audioContent,
  FastMCP,
  type FastMCPSession,
  type FastMCPSessionAuth,
  imageContent,
  ServerState,
  UserError,
} from "fastmcp"
