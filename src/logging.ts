import type { DirectLogger } from "functype-log"
import { createDirectConsoleLogger } from "functype-log"

export const createDefaultLogger = (name: string): DirectLogger =>
  // stderr, not stdout — stdout is reserved for the JSON-RPC stream on the stdio MCP transport.
  createDirectConsoleLogger({ prefix: `[${name}]`, stream: "stderr" }).withContext({ cell: name })
