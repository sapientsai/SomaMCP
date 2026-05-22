import type { Context as HonoContext } from "hono"

type ArtifactCommon = {
  protected?: boolean
}

export type StaticArtifact = ArtifactCommon & {
  contentType: string
  content: string
  path: string
  type: "static"
}

export type DynamicArtifact = ArtifactCommon & {
  handler: (c: HonoContext) => Response | Promise<Response>
  path: string
  type: "dynamic"
}

export type DirectoryArtifact = ArtifactCommon & {
  directory: string
  path: string
  type: "directory"
}

export type ArtifactConfig = DirectoryArtifact | DynamicArtifact | StaticArtifact

export type ArtifactAuthenticate = (request: unknown) => Promise<unknown>
