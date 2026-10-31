import { List, Option } from "functype"

import type { ErrorCategory } from "./TelemetryCollector.js"

export type EnrichedErrorResponse = {
  errorCategory: ErrorCategory
  message: string
  relatedState?: Record<string, unknown>
  suggestions?: ReadonlyArray<string>
}

const CATEGORIES = List<ErrorCategory>([
  "validation",
  "execution",
  "timeout",
  "gateway",
  "internal",
  "auth",
  "not_found",
])

/** What a `UserError` says about itself. Read by name, not `instanceof`, so a second copy of somamcp still counts. */
type Reported = { category: Option<ErrorCategory>; suggestions: Option<ReadonlyArray<string>> }

const isCategory = (value: unknown): value is ErrorCategory =>
  typeof value === "string" && CATEGORIES.contains(value as ErrorCategory)

const isStrings = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

/** `value` as an `A` when the guard accepts it. */
const narrowed = <A>(value: unknown, guard: (candidate: unknown) => candidate is A): Option<A> =>
  guard(value) ? Option(value) : Option.none<A>()

const reportedBy = (error: unknown): Option<Reported> => {
  if (error === null || typeof error !== "object" || !("name" in error) || error.name !== "UserError")
    return Option.none()
  const fields = error as { category?: unknown; suggestions?: unknown }
  return Option({
    category: narrowed(fields.category, isCategory),
    suggestions: narrowed(fields.suggestions, isStrings),
  })
}

/** A schema library's error (zod, valibot): it carries the issues it found. */
const isSchemaError = (error: unknown): boolean =>
  error !== null && typeof error === "object" && "issues" in error && Array.isArray(error.issues)

/** A guess from the words of an unexpected error's message, which is the library's own. */
const guessFromMessage = (error: unknown): ErrorCategory => {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    if (msg.includes("validation") || msg.includes("invalid") || msg.includes("schema")) return "validation"
    if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("etimedout")) return "timeout"
    if (
      msg.includes("gateway") ||
      msg.includes("not connected") ||
      msg.includes("econnrefused") ||
      msg.includes("connection refused")
    )
      return "gateway"
    if (msg.includes("auth") || msg.includes("unauthorized") || msg.includes("forbidden")) return "auth"
    if (msg.includes("not found") || msg.includes("404")) return "not_found"
  }
  return "internal"
}

/**
 * A `UserError` is labelled as it says, or `execution` when it says nothing: its message is what
 * the tool reports, often a remote command's own output, so its words are no guide. A schema
 * library's error is `validation`. Anything else is guessed from its message.
 */
export const classifyError = (error: unknown): ErrorCategory =>
  reportedBy(error).fold(
    () => (isSchemaError(error) ? "validation" : guessFromMessage(error)),
    (reported) => reported.category.orElse("execution"),
  )

const getSuggestions = (
  category: ErrorCategory,
  context?: { gatewayStatus?: string; toolName?: string },
): ReadonlyArray<string> => {
  switch (category) {
    case "validation":
      return ["Check the tool's parameter schema and provide valid input"]
    case "execution":
      return []
    case "timeout":
      return ["The operation timed out. Try again or reduce the scope of the request"]
    case "gateway":
      return [
        `Gateway is ${context?.gatewayStatus ?? "unavailable"}. The remote service may be down`,
        "Try again later or check the remote service status",
      ]
    case "auth":
      return ["Authentication failed. Check credentials or permissions"]
    case "not_found":
      return ["The requested resource was not found. Verify the identifier"]
    case "internal":
      return ["An internal error occurred. The tool maintainer should investigate"]
  }
}

export const createEnrichedError = (
  error: unknown,
  context?: { gatewayStatus?: string; toolName?: string },
): EnrichedErrorResponse => {
  const errorCategory = classifyError(error)
  const message = error instanceof Error ? error.message : String(error)
  const suggestions = reportedBy(error)
    .flatMap((reported) => reported.suggestions)
    .orElse(getSuggestions(errorCategory, context))
  const relatedState: Record<string, unknown> = {
    ...(context?.gatewayStatus && { gatewayStatus: context.gatewayStatus }),
    ...(context?.toolName && { toolName: context.toolName }),
  }

  return {
    errorCategory,
    message,
    ...(Object.keys(relatedState).length > 0 && { relatedState }),
    ...(suggestions.length > 0 && { suggestions }),
  }
}
