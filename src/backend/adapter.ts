import type { Hono } from "hono"

import type { Prompt, PromptArgument, Resource, SchemaParams, ServerStatus, SessionAuth, Tool } from "../types/core.js"
import type { ServerConfig, TransportConfig } from "../types/server.js"

// ── Backend Session ───────────────────────────────────────────────────

export type BackendSession<T extends SessionAuth = SessionAuth> = {
  sessionId?: string
  auth?: T
}

// ── Backend Events ────────────────────────────────────────────────────

export type BackendEvents<T extends SessionAuth> = {
  connect: (event: { session: BackendSession<T> }) => void
  disconnect: (event: { session: BackendSession<T> }) => void
}

// ── Backend Adapter ───────────────────────────────────────────────────

export type BackendAdapter<T extends SessionAuth = SessionAuth> = {
  readonly serverState: ServerStatus
  readonly sessions: ReadonlyArray<BackendSession<T>>

  addPrompt: <Args extends PromptArgument<T>[]>(prompt: Prompt<T, Args>) => void
  addResource: (resource: Resource<T>) => void
  addResourceTemplate: (...args: ReadonlyArray<unknown>) => void
  addTool: <P extends SchemaParams>(tool: Tool<T, P>) => void

  /**
   * Handle a web-standard Request. Optional: when absent, callers fall back to
   * `getApp().fetch`. Edge backends implement this as their primary entry point;
   * Node backends provide it for parity so `SomaServerInstance.fetch` always works.
   */
  fetch?: (request: Request) => Promise<Response>

  getApp: () => Hono

  on: <E extends keyof BackendEvents<T>>(event: E, handler: BackendEvents<T>[E]) => void

  /**
   * Whether `removeTool` / `removeResource` / `removePrompt` actually take
   * effect. Defaults to true when absent.
   *
   * The edge backend sets this false: EdgeFastMCP exposes no removal API, so its
   * `remove*` calls only warn. Capability counts must not shrink for a tool that
   * is still being served.
   */
  readonly supportsRemoval?: boolean

  removePrompt: (name: string) => void
  removeResource: (name: string) => void
  removeTool: (name: string) => void

  start: (transport?: TransportConfig) => Promise<void>
  stop: () => Promise<void>
}

// ── Backend Factory ───────────────────────────────────────────────────

export type BackendFactory<T extends SessionAuth = SessionAuth> = (
  config: ServerConfig<T>,
  backendOptions?: Record<string, unknown>,
) => BackendAdapter<T>
