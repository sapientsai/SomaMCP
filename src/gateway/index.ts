// somamcp/gateway — server-to-server MCP: a server's `gateways` connect to remote MCP servers and
// proxy their tools. It is its own entry because it brings the MCP SDK client, which a server
// without gateways shouldn't bundle. Pass `gatewayManager: createGatewayManager` to createServer.
export { createGateway } from "./Gateway.js"
export { createGatewayManager } from "./GatewayManager.js"
export { createProxiedTools } from "./toolProxy.js"
export type {
  GatewayConfig,
  GatewayInfo,
  GatewayInstance,
  GatewayManagerFactory,
  GatewayManagerInstance,
  GatewayStatus,
} from "./types.js"
