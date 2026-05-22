import type { ServerInfo } from "../types.js"
import type { SessionAuth, Tool } from "../types/core.js"

export const createInfoTool = <T extends SessionAuth>(getInfo: () => ServerInfo, name: string = "info"): Tool<T> => ({
  annotations: {
    readOnlyHint: true,
  },
  description:
    "Returns identity and build information for this server (name, version, build commit, runtime, capability counts)",
  execute: () => Promise.resolve(JSON.stringify(getInfo(), null, 2)),
  name,
})
