import type { ServerHealth } from "../types.js"
import type { ArtifactConfig } from "./types.js"

export const DEFAULT_HEALTH_PATH = "/health"

export const createHealthArtifact = (
  getHealth: () => ServerHealth,
  path: string = DEFAULT_HEALTH_PATH,
): ArtifactConfig => ({
  handler: () => {
    const health = getHealth()
    const status = health.status === "running" ? 200 : 503
    return new Response(JSON.stringify(health), {
      headers: { "Content-Type": "application/json" },
      status,
    })
  },
  path,
  type: "dynamic",
})
