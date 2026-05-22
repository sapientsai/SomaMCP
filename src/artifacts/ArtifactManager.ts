import type { Context, Hono, MiddlewareHandler } from "hono"

import type { ArtifactAuthenticate, ArtifactConfig } from "./types.js"

const unauthorized = (c: Context): Response => c.json({ error: "Unauthorized" }, 401)

const createAuthMiddleware =
  (authenticate?: ArtifactAuthenticate): MiddlewareHandler =>
  async (c, next) => {
    if (!authenticate) {
      return unauthorized(c)
    }
    try {
      const req = (c.env as { incoming?: unknown } | undefined)?.incoming ?? c.req.raw
      await authenticate(req)
    } catch {
      return unauthorized(c)
    }
    await next()
  }

export const registerArtifacts = (
  app: Hono,
  artifacts: ReadonlyArray<ArtifactConfig>,
  authenticate?: ArtifactAuthenticate,
): void => {
  artifacts.forEach((artifact) => {
    if (artifact.protected) {
      app.use(artifact.path, createAuthMiddleware(authenticate))
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
