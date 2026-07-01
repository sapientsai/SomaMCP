import type { Hono } from "hono"

import { createAuthMiddleware } from "../auth/index.js"
import type { ArtifactAuthenticate, ArtifactConfig } from "./types.js"

export const registerArtifacts = (
  app: Hono,
  artifacts: ReadonlyArray<ArtifactConfig>,
  authenticate?: ArtifactAuthenticate,
): void => {
  artifacts.forEach((artifact) => {
    if (artifact.protected) {
      app.use(artifact.path, createAuthMiddleware({ authenticate }))
    }

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
