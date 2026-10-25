// somamcp/node — everything in `somamcp`, plus what only Node can do: listen on
// a port, serve stdio, write telemetry to a file, and read content from a path.
// It shares the main entry's modules rather than copying them, so values such as
// UserError are the same objects whichever entry a consumer imports them from.

import { createServerCore } from "../Server.js"
import type { SomaServerInstance, SomaServerOptions } from "../types.js"
import type { SessionAuth } from "../types/core.js"
import { createNodeBackend } from "./backend.js"

export * from "../index.js"

/**
 * Create a server on the MCP SDK 2.x backend with Node transports. Identical to
 * `somamcp`'s `createServer`, except that `start()` can listen on a port
 * (`httpStream`) or serve stdio, which a bare `start()` does.
 */
export const createServer = <T extends SessionAuth = SessionAuth>(
  options: SomaServerOptions<T>,
): SomaServerInstance<T> => createServerCore({ ...options, backend: options.backend ?? createNodeBackend<T> })

export { createNodeBackend } from "./backend.js"
export type { NodeContentInput } from "./content.js"
export { audioContent, imageContent } from "./content.js"
export type { JsonFileTelemetryOptions } from "./JsonFileTelemetry.js"
export { createJsonFileTelemetry } from "./JsonFileTelemetry.js"
export * from "./oauth/index.js"
