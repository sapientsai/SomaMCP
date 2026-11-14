// The gateway manager of a server with no gateways. It imports no MCP client, so the main entry
// stays free of it; somamcp/gateway's createGatewayManager is the real one.
import { Option } from "functype"

import type { GatewayManagerInstance } from "./types.js"

export const noGateways: GatewayManagerInstance = {
  /** @interop the manager's contract returns the gateway it added, and this one can add none. */
  add: (config) => {
    throw new Error(
      `[somamcp] cannot add gateway "${config.id}": this server has no gateway manager. Pass \`gatewayManager: createGatewayManager\` from "somamcp/gateway" to createServer.`,
    )
  },
  connectAll: () => Promise.resolve(),
  connectedCount: 0,
  disconnectAll: () => Promise.resolve(),
  get: () => Option.none(),
  getAll: () => [],
  getInfoAll: () => [],
  totalCount: 0,
}
