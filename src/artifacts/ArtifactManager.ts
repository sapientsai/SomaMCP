import type { Hono } from "hono"

import type { ArtifactConfig } from "./types.js"

export const registerArtifacts = (app: Hono, artifacts: ReadonlyArray<ArtifactConfig>): void => {
  artifacts.forEach((artifact) => {
    switch (artifact.type) {
      case "static": {
        app.get(artifact.path, (c) =>
          c.body(artifact.content, {
            headers: { "Content-Type": artifact.contentType },
          }),
        )
        break
      }
      case "dynamic": {
        app.get(artifact.path, (c) => artifact.handler(c))
        break
      }
      case "directory": {
        // Serve directory not implemented yet - placeholder for future fs-based serving
        break
      }
    }
  })
}
