import { z } from "zod"

import type { SessionAuth, Tool } from "../types/core.js"
import { DEFAULT_REDACTION_PATTERNS, redact, type RedactionPattern, type RedactionResult } from "./redaction.js"
import type { FeedbackProvider, FeedbackSeverity, FeedbackType } from "./types.js"

export type FeedbackEnrichmentContext = {
  type: FeedbackType
  severity?: FeedbackSeverity
}

export type FeedbackToolOptions = {
  description?: string
  enrichment?: (ctx: FeedbackEnrichmentContext) => Promise<Record<string, unknown>> | Record<string, unknown>
  extraLabels?: ReadonlyArray<string>
  name?: string
  provider: FeedbackProvider
  redactionPatterns?: ReadonlyArray<RedactionPattern>
}

const DEFAULT_DESCRIPTION = [
  "Submit a feedback report or issue to this server's maintainers.",
  "",
  "IMPORTANT: Treat all input as potentially public.",
  "- Do NOT include API keys, tokens, passwords, or credentials",
  "- Do NOT include customer data, PII, or proprietary information",
  "- Do NOT include internal URLs, hostnames, or system topology",
  "- Describe the behavior and how to reproduce it, not the data involved",
  "",
  "Common credential patterns are automatically redacted before submission,",
  "but redaction is best-effort and is not a substitute for caution.",
].join("\n")

const PARAMETERS = z.object({
  description: z
    .string()
    .min(10, "Provide enough context to reproduce (>=10 chars)")
    .max(8000)
    .describe("Detailed description. NO secrets, customer data, or internal URLs."),
  severity: z.enum(["low", "medium", "high"]).optional().describe("Severity hint (optional)"),
  title: z.string().min(5, "Title must be at least 5 characters").max(200).describe("Brief, public-safe summary"),
  type: z.enum(["bug", "feature", "feedback", "question"]).default("feedback").describe("What kind of report this is"),
})

type FeedbackToolParams = z.infer<typeof PARAMETERS>

const formatRedactionSummary = (titleRes: RedactionResult, bodyRes: RedactionResult): string | undefined => {
  if (!titleRes.redacted && !bodyRes.redacted) return undefined
  const seen = new Map<string, number>()
  for (const m of [...titleRes.matches, ...bodyRes.matches]) {
    seen.set(m.name, (seen.get(m.name) ?? 0) + m.count)
  }
  const lines = Array.from(seen.entries()).map(([name, count]) => `- ${name}: ${String(count)}`)
  return ["⚠️ Automatic redactions applied:", ...lines].join("\n")
}

const formatEnrichment = (ctx: Record<string, unknown> | undefined): string | undefined => {
  if (!ctx || Object.keys(ctx).length === 0) return undefined
  return ["---", "**Context (auto-collected):**", "```json", JSON.stringify(ctx, null, 2), "```"].join("\n")
}

const buildBody = (
  description: string,
  type: FeedbackType,
  severity: FeedbackSeverity | undefined,
  redactionSummary: string | undefined,
  enrichmentBlock: string | undefined,
): string => {
  const parts: string[] = []
  parts.push(`**Type:** ${type}`)
  if (severity) parts.push(`**Severity:** ${severity}`)
  parts.push("")
  parts.push(description)
  if (redactionSummary) {
    parts.push("")
    parts.push(redactionSummary)
  }
  if (enrichmentBlock) {
    parts.push("")
    parts.push(enrichmentBlock)
  }
  return parts.join("\n")
}

export const createFeedbackTool = <T extends SessionAuth>(options: FeedbackToolOptions): Tool<T, typeof PARAMETERS> => {
  const patterns = options.redactionPatterns ?? DEFAULT_REDACTION_PATTERNS

  return {
    annotations: {
      destructiveHint: false,
      readOnlyHint: false,
    },
    description: options.description ?? DEFAULT_DESCRIPTION,
    execute: async (args: FeedbackToolParams) => {
      const titleRes = redact(args.title, patterns)
      const bodyRes = redact(args.description, patterns)

      const enrichment = options.enrichment
        ? await options.enrichment({ severity: args.severity, type: args.type })
        : undefined

      const redactionSummary = formatRedactionSummary(titleRes, bodyRes)
      const enrichmentBlock = formatEnrichment(enrichment)
      const finalBody = buildBody(bodyRes.text, args.type, args.severity, redactionSummary, enrichmentBlock)

      const labels = [
        args.type,
        ...(args.severity ? [`severity:${args.severity}`] : []),
        ...(options.extraLabels ?? []),
      ]

      const result = await options.provider.submit({
        body: finalBody,
        labels,
        title: titleRes.text,
      })

      if (!result.success) {
        return JSON.stringify(
          {
            error: result.error,
            redacted: redactionSummary !== undefined,
            success: false,
          },
          null,
          2,
        )
      }

      return JSON.stringify(
        {
          id: result.id,
          provider: options.provider.name,
          redacted: redactionSummary !== undefined,
          redactionDetails: [...titleRes.matches, ...bodyRes.matches],
          success: true,
          url: result.url,
        },
        null,
        2,
      )
    },
    name: options.name ?? "report_feedback",
    parameters: PARAMETERS,
  }
}
