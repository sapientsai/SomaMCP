// somamcp-owned MCP primitive types — no imports from "fastmcp"
//
// These types are intentionally plain `T | undefined` rather than `Option<T>` because:
//   1. They must be structurally compatible with the MCP SDK / FastMCP, StandardSchemaV1,
//      and wire-format JSON. Wrapping in `Option` would break structural assignability and
//      force consumers to import functype to construct basic MCP primitives.
//   2. They cross serialization boundaries where `undefined` means "absent field".
//
// Internal mutable state uses `Option<T>`; these public protocol types do not.
/* eslint-disable functype/prefer-option */

// ── Auth ──────────────────────────────────────────────────────────────

export type SessionAuth = Record<string, unknown> | undefined

// ── Schema ────────────────────────────────────────────────────────────

/**
 * Structural type compatible with StandardSchemaV1 (zod, valibot, etc.)
 * We define this structurally to avoid a direct dependency on @standard-schema/spec.
 */
export type SchemaParams = {
  readonly "~standard": {
    readonly version: 1
    readonly vendor: string
    readonly types?: { readonly input: unknown; readonly output: unknown } | undefined
    readonly validate: (
      value: unknown,
    ) =>
      | { value: unknown }
      | { issues: ReadonlyArray<{ message: string }> }
      | Promise<{ value: unknown } | { issues: ReadonlyArray<{ message: string }> }>
  }
}

export type InferSchemaOutput<P extends SchemaParams> = NonNullable<P["~standard"]["types"]>["output"] extends infer O
  ? [O] extends [never]
    ? unknown
    : O
  : unknown

// ── Content ───────────────────────────────────────────────────────────

export type TextContent = { text: string; type: "text" }
export type ImageContent = { data: string; mimeType: string; type: "image" }
export type AudioContent = { data: string; mimeType: string; type: "audio" }

export type ResourceContent = {
  resource: { blob?: string; mimeType?: string; text?: string; uri: string }
  type: "resource"
}

export type ResourceLink = {
  mimeType?: string
  name?: string
  type: "resource_link"
  uri: string
}

export type Content = AudioContent | ImageContent | ResourceContent | ResourceLink | TextContent

export type ContentResult = {
  content: Content[]
  isError?: boolean
}

// ── Progress ──────────────────────────────────────────────────────────

export type Progress = { progress: number; total?: number }

// ── Context ───────────────────────────────────────────────────────────

export type Context<T extends SessionAuth = SessionAuth> = {
  client: { version: unknown }
  log: {
    debug: (message: string, data?: unknown) => void
    error: (message: string, data?: unknown) => void
    info: (message: string, data?: unknown) => void
    warn: (message: string, data?: unknown) => void
  }
  reportProgress: (progress: Progress) => Promise<void>
  requestId?: string
  session: T | undefined
  sessionId?: string
  streamContent: (content: Content | Content[]) => Promise<void>
}

// ── Tool ──────────────────────────────────────────────────────────────

export type ToolAnnotations = {
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
  readOnlyHint?: boolean
  streamingHint?: boolean
  title?: string
}

export type Tool<T extends SessionAuth = SessionAuth, P extends SchemaParams = SchemaParams> = {
  _meta?: { [key: string]: unknown; ui?: { resourceUri?: string } }
  annotations?: ToolAnnotations
  canAccess?: (auth: T) => boolean
  description?: string
  execute: (args: InferSchemaOutput<P>, context: Context<T>) => Promise<Content | ContentResult | string | void>
  name: string
  outputSchema?: SchemaParams
  parameters?: P
  timeoutMs?: number
}

// ── Resource ──────────────────────────────────────────────────────────

export type Completion = { hasMore?: boolean; total?: number; values: string[] }

export type ResourceResult =
  | { blob: string; mimeType?: string; uri?: string }
  | { mimeType?: string; text: string; uri?: string }

export type Resource<T extends SessionAuth = SessionAuth> = {
  complete?: (name: string, value: string, auth?: T) => Promise<Completion>
  description?: string
  load: (auth?: T) => Promise<ResourceResult | ResourceResult[]>
  mimeType?: string
  name: string
  uri: string
}

// ── Prompt ─────────────────────────────────────────────────────────────

export type PromptArgument<T extends SessionAuth = SessionAuth> = Readonly<{
  complete?: (value: string, auth?: T) => Promise<Completion>
  description?: string
  enum?: string[]
  name: string
  required?: boolean
}>

export type PromptResult = { messages: unknown[] } | string

export type Prompt<T extends SessionAuth = SessionAuth, Args extends PromptArgument<T>[] = PromptArgument<T>[]> = {
  arguments?: Args
  complete?: (name: string, value: string, auth?: T) => Promise<Completion>
  description?: string
  load: (args: Record<string, string | undefined>, auth?: T) => Promise<PromptResult>
  name: string
}

// ── Server Status ─────────────────────────────────────────────────────

export type ServerStatus = "error" | "running" | "stopped"

// ── UserError ─────────────────────────────────────────────────────────

export class UserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UserError"
  }
}
