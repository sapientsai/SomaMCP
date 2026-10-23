import { Option } from "functype"

import type { BackendAdapter } from "../backend/adapter.js"
import { buildSdkBackend } from "../backend/sdk/index.js"
import type { SessionAuth } from "../types/core.js"
import type { ServerConfig } from "../types/server.js"
import { NODE_TRANSPORTS } from "./listen.js"

/**
 * The SDK backend with Node transports: `start({ transportType: "httpStream" })`
 * listens on a port, and `start({ transportType: "stdio" })` or a bare `start()`
 * serves stdio. `fetch()` works as it does in the main entry.
 */
export const createNodeBackend = <T extends SessionAuth = SessionAuth>(
  config: ServerConfig<T>,
  backendOptions?: Record<string, unknown>,
): BackendAdapter<T> => buildSdkBackend(Option(NODE_TRANSPORTS), config, backendOptions)
