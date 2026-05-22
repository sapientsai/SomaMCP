import type { ServerHealth } from "../types.js"
import type { ArtifactConfig } from "./types.js"

export const DEFAULT_HEALTH_PATH = "/health"
export const DEFAULT_HEALTH_DETAIL_PATH = "/health/detail"

export const createHealthArtifact = (
  getHealth: () => ServerHealth,
  path: string = DEFAULT_HEALTH_PATH,
): ArtifactConfig => ({
  handler: () => {
    const health = getHealth()
    const status = health.status === "running" ? 200 : 503
    return new Response(JSON.stringify({ name: health.name, status: health.status }), {
      headers: { "Content-Type": "application/json" },
      status,
    })
  },
  path,
  type: "dynamic",
})

export const createHealthDetailArtifact = (
  getHealth: () => ServerHealth,
  path: string = DEFAULT_HEALTH_DETAIL_PATH,
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
  protected: true,
  type: "dynamic",
})
