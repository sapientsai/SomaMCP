import type { ServerInfo } from "../types.js"
import type { ArtifactConfig } from "./types.js"

export const DEFAULT_INFO_PATH = "/info"

export const createInfoArtifact = (getInfo: () => ServerInfo, path: string = DEFAULT_INFO_PATH): ArtifactConfig => ({
  handler: () => {
    return new Response(JSON.stringify(getInfo()), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    })
  },
  path,
  protected: true,
  type: "dynamic",
})
