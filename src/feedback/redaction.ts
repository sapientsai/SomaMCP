import { Map as FMap, Tuple } from "functype"

export type RedactionPattern = {
  description: string
  name: string
  pattern: RegExp
  replacement?: string
}

export type RedactionResult = {
  matches: ReadonlyArray<{ name: string; count: number }>
  redacted: boolean
  text: string
}

const REDACTED = "[REDACTED]"

export const DEFAULT_REDACTION_PATTERNS: ReadonlyArray<RedactionPattern> = [
  {
    description: "GitHub personal access token",
    name: "github_pat",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    description: "AWS access key ID",
    name: "aws_access_key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    description: "AWS secret access key (heuristic)",
    name: "aws_secret_key",
    pattern: /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/g,
  },
  {
    description: "Stripe secret/publishable key",
    name: "stripe_key",
    pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
  },
  {
    description: "Slack token",
    name: "slack_token",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    description: "JSON Web Token",
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\b/g,
  },
  {
    description: "OpenAI / Anthropic style API key",
    name: "ai_api_key",
    pattern: /\b(?:sk-ant-|sk-)[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    description: "Generic bearer-style secret prefix",
    name: "bearer_authorization",
    pattern: /\b[Bb]earer\s+[A-Za-z0-9._\-+/]{16,}\b/g,
  },
  {
    description: "Email address",
    name: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    description: "Private IPv4 address (RFC1918)",
    name: "private_ipv4",
    pattern: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g,
  },
  {
    description: "URL pointing at internal/private hostname",
    name: "internal_url",
    pattern: /\bhttps?:\/\/(?:[a-z0-9-]+\.)*(?:internal|intranet|corp|local|lan)(?:[/:][^\s]*)?/gi,
  },
]

export const redact = (
  input: string,
  patterns: ReadonlyArray<RedactionPattern> = DEFAULT_REDACTION_PATTERNS,
): RedactionResult => {
  const { counts, text } = patterns.reduce<{ counts: FMap<string, number>; text: string }>(
    (acc, p) => {
      const matchCount = Array.from(acc.text.matchAll(p.pattern)).length
      if (matchCount === 0) return acc
      return {
        counts: acc.counts.add(Tuple<[string, number]>([p.name, matchCount])),
        text: acc.text.replace(p.pattern, p.replacement ?? REDACTED),
      }
    },
    { counts: FMap.empty<string, number>(), text: input },
  )

  const matches = [...counts].map(([name, count]) => ({ count, name }))
  return {
    matches,
    redacted: matches.length > 0,
    text,
  }
}
