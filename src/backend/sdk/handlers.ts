import {
  type CallToolResult,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  Server,
  UriTemplate,
} from "@modelcontextprotocol/server"
import { List, type Map, Option, Ref, Try } from "functype"

import type {
  Completion,
  Prompt,
  PromptArgument,
  Resource,
  ResourceTemplate,
  SchemaIssue,
  SchemaParams,
  SessionAuth,
  Tool,
} from "../../types/core.js"
import {
  completeFromEnum,
  createToolContext,
  errorResult,
  toCallResult,
  toCompleteResult,
  toJsonSchema,
  toPromptResult,
  toReadResult,
} from "./mapping.js"

export type AnyTool<T extends SessionAuth> = Tool<T, SchemaParams>
export type AnyPrompt<T extends SessionAuth> = Prompt<T, PromptArgument<T>[]>

/**
 * Read access to somamcp's registry. Each getter returns the current immutable
 * snapshot, so a server built for one request sees exactly what was registered
 * when it ran, and later adds or removes apply from the next request.
 */
export type Registry<T extends SessionAuth> = {
  readonly prompts: () => Map<string, AnyPrompt<T>>
  readonly resources: () => Map<string, Resource<T>>
  readonly templates: () => Map<string, ResourceTemplate<T>>
  readonly tools: () => Map<string, AnyTool<T>>
}

export type ServerIdentity = {
  /** Whether `authenticate` is configured. With no session, tools gated by `canAccess` are then hidden. */
  authRequired: boolean
  instructions?: string
  name: string
  version: string
}

const valuesOf = <V>(map: Map<string, V>): List<V> => List([...map].map(([, value]) => value))

/** The first of several lazily computed options that is Some. */
const firstSome = <A>(...candidates: ReadonlyArray<() => Option<A>>): Option<A> =>
  candidates.reduce<Option<A>>(
    (found, next) =>
      found.fold(
        () => next(),
        () => found,
      ),
    Option.none(),
  )

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// ── Tool calls ────────────────────────────────────────────────────────

const timedOut = (tool: AnyTool<SessionAuth>): string =>
  `Tool '${tool.name}' timed out after ${tool.timeoutMs}ms. Consider increasing timeoutMs or optimizing the tool implementation.`

/** Races `run` against the tool's `timeoutMs`, when it has one. */
const withTimeout = <R>(tool: AnyTool<SessionAuth>, run: Promise<R>): Promise<R> =>
  Option(tool.timeoutMs).fold(
    () => run,
    (ms) => {
      const handle = Ref<Option<ReturnType<typeof setTimeout>>>(Option.none())
      const timer = new Promise<never>((_, reject) => {
        handle.set(Option(setTimeout(() => reject(new Error(timedOut(tool))), ms)))
      })
      return Promise.race([run, timer]).finally(() => handle.get().forEach(clearTimeout))
    },
  )

type Validated = { value: unknown } | { issues: ReadonlyArray<SchemaIssue> }

/** `recurrence.pattern.dayOfMonth: <message>`, so a model can tell which argument to fix. An issue about the whole input keeps its message alone. */
const describeIssue = (issue: SchemaIssue): string => {
  const path = Option(issue.path)
    .map((segments) => segments.map((segment) => String(typeof segment === "object" ? segment.key : segment)))
    .orElse([])
  return path.length > 0 ? `${path.join(".")}: ${issue.message}` : issue.message
}

const validate = (tool: AnyTool<SessionAuth>, args: Record<string, unknown>): Promise<Validated> =>
  Option(tool.parameters).fold(
    () => Promise.resolve({ value: args }),
    (schema) => Promise.resolve(schema["~standard"].validate(args)),
  )

/** URI template variables as plain strings; a multi-valued variable is comma-joined. */
const flattenVariables = (variables: Record<string, string | string[]>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(variables).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : value]),
  )

// ── Server ────────────────────────────────────────────────────────────

/**
 * One low-level SDK `Server` for one request (or one stdio connection). The
 * handler set is fixed, so construction cost does not grow with the number of
 * registered tools; the handlers read the registry when they run.
 */
export const buildServer = <T extends SessionAuth>(
  registry: Registry<T>,
  identity: ServerIdentity,
  session: Option<T>,
): Server => {
  const auth = session.orUndefined()

  // Mirrors FastMCP's toolsVisibleTo: canAccess only ever sees a real session. With
  // none, gated tools are hidden when authentication is configured and shown otherwise.
  const canUse = (tool: AnyTool<T>): boolean =>
    session.fold(
      () => !(identity.authRequired && tool.canAccess),
      (s) => !tool.canAccess || tool.canAccess(s),
    )
  const findTool = (name: string): Option<AnyTool<T>> => registry.tools().get(name).filter(canUse)

  const server = new Server(
    { name: identity.name, version: identity.version },
    {
      capabilities: { completions: {}, logging: {}, prompts: {}, resources: {}, tools: {} },
      instructions: identity.instructions,
    },
  )

  server.setRequestHandler("tools/list", () => ({
    tools: valuesOf(registry.tools())
      .filter(canUse)
      .map((tool) => ({
        ...(tool._meta ? { _meta: tool._meta } : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        description: tool.description,
        inputSchema: toJsonSchema(Option(tool.parameters)),
        name: tool.name,
        ...(tool.outputSchema ? { outputSchema: toJsonSchema(Option(tool.outputSchema)) } : {}),
        ...(tool.annotations?.title ? { title: tool.annotations.title } : {}),
      }))
      .toArray(),
  }))

  const callTool = async (
    tool: AnyTool<T>,
    args: Record<string, unknown>,
    context: Parameters<AnyTool<T>["execute"]>[1],
  ): Promise<CallToolResult> => {
    const parsed = await validate(tool as AnyTool<SessionAuth>, args)
    if ("issues" in parsed) {
      return errorResult(`Invalid arguments for tool '${tool.name}': ${parsed.issues.map(describeIssue).join("; ")}`)
    }
    const outcome = await Try.fromPromise(
      withTimeout(tool as AnyTool<SessionAuth>, tool.execute(parsed.value as never, context)),
    )
    return outcome.fold(
      (error) => errorResult(describeError(error)),
      (result) => toCallResult(result),
    )
  }

  /**
   * An unknown (or hidden) tool is a protocol error, as in SDK 2.x and the spec;
   * the same message for both, so a hidden tool's existence is not revealed.
   * Invalid arguments stay a tool error the model can read and retry from.
   * @interop SDK request handlers report JSON-RPC errors by throwing.
   */
  const resolveTool = (name: string): AnyTool<T> =>
    findTool(name).orThrow(() => new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`))

  server.setRequestHandler("tools/call", (request, ctx) => {
    const { arguments: args, name } = request.params
    return callTool(resolveTool(name), args ?? {}, createToolContext(ctx, session, name))
  })

  server.setRequestHandler("resources/list", () => ({
    resources: valuesOf(registry.resources())
      .map((r) => ({ description: r.description, mimeType: r.mimeType, name: r.name, uri: r.uri }))
      .toArray(),
  }))

  server.setRequestHandler("resources/templates/list", () => ({
    resourceTemplates: valuesOf(registry.templates())
      .map((t) => ({ description: t.description, mimeType: t.mimeType, name: t.name, uriTemplate: t.uriTemplate }))
      .toArray(),
  }))

  type ResourceLoad = { load: () => ReturnType<Resource<T>["load"]>; mimeType?: string }

  const findResource = (uri: string): Option<ResourceLoad> =>
    firstSome<ResourceLoad>(
      () =>
        valuesOf(registry.resources())
          .find((r) => r.uri === uri)
          .map((r) => ({ load: () => r.load(auth), mimeType: r.mimeType })),
      () =>
        valuesOf(registry.templates())
          .map((template) => ({ template, variables: Option(new UriTemplate(template.uriTemplate).match(uri)) }))
          .find((m) => m.variables.isSome())
          .map(({ template, variables }) => ({
            load: () => template.load(flattenVariables(variables.orElse({})), auth),
            mimeType: template.mimeType,
          })),
    )

  /** @interop SDK request handlers report JSON-RPC errors by throwing. */
  const readResource = async (uri: string) => {
    const resource = findResource(uri).orThrow(() => new ResourceNotFoundError(uri))
    return toReadResult(await resource.load(), { mimeType: resource.mimeType, uri })
  }
  server.setRequestHandler("resources/read", (request) => readResource(request.params.uri))

  server.setRequestHandler("prompts/list", () => ({
    prompts: valuesOf(registry.prompts())
      .map((p) => ({
        arguments: p.arguments?.map((a) => ({ description: a.description, name: a.name, required: a.required })),
        description: p.description,
        name: p.name,
      }))
      .toArray(),
  }))

  /** @interop SDK request handlers report JSON-RPC errors by throwing. */
  const getPrompt = async (name: string, args: Record<string, string>) => {
    const prompt = registry
      .prompts()
      .get(name)
      .orThrow(() => new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown prompt: ${name}`))
    const missing = List(prompt.arguments ?? []).filter((a) => a.required === true && !(a.name in args))
    if (!missing.isEmpty) {
      const names = missing
        .map((a) => a.name)
        .toArray()
        .join(", ")
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Prompt '${name}' is missing required arguments: ${names}`,
      )
    }
    return toPromptResult(await prompt.load(args, auth))
  }
  server.setRequestHandler("prompts/get", (request) => getPrompt(request.params.name, request.params.arguments ?? {}))

  type Completer = () => Promise<Completion>

  const promptCompleter = (name: string, argName: string, value: string): Option<Completer> => {
    const prompt = registry.prompts().get(name)
    const argument = prompt.flatMap((p) => List(p.arguments ?? []).find((a) => a.name === argName))
    return firstSome<Completer>(
      () => argument.flatMap((a) => Option(a.complete)).map((complete) => () => complete(value, auth)),
      () =>
        argument.flatMap((a) => Option(a.enum)).map((values) => () => Promise.resolve(completeFromEnum(values, value))),
      () => prompt.flatMap((p) => Option(p.complete)).map((complete) => () => complete(argName, value, auth)),
    )
  }

  const templateCompleter = (uriTemplate: string, argName: string, value: string): Option<Completer> => {
    const template = valuesOf(registry.templates()).find((t) => t.uriTemplate === uriTemplate)
    const argument = template.flatMap((t) => List(t.arguments).find((a) => a.name === argName))
    return firstSome<Completer>(
      () => argument.flatMap((a) => Option(a.complete)).map((complete) => () => complete(value, auth)),
      () => template.flatMap((t) => Option(t.complete)).map((complete) => () => complete(argName, value, auth)),
    )
  }

  server.setRequestHandler("completion/complete", async (request) => {
    const { argument, ref } = request.params
    const completer =
      ref.type === "ref/prompt"
        ? promptCompleter(ref.name, argument.name, argument.value)
        : templateCompleter(ref.uri, argument.name, argument.value)
    return toCompleteResult(
      await completer.foldAsync(
        () => Promise.resolve(Option.none<Completion>()),
        async (complete) => Option(await complete()),
      ),
    )
  })

  return server
}
