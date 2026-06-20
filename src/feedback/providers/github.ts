import { Option, Set as FSet, Try } from "functype"

import type { FeedbackProvider, FeedbackSubmitResult, NormalizedFeedback } from "../types.js"

export type GithubFeedbackOptions = {
  baseUrl?: string
  defaultLabels?: ReadonlyArray<string>
  fetchImpl?: typeof fetch
  getToken: () => Option<string>
  repo: `${string}/${string}`
}

type GithubIssueResponse = {
  html_url?: string
  id?: number
  message?: string
  number?: number
}

export const createGithubFeedback = (options: GithubFeedbackOptions): FeedbackProvider => {
  const baseUrl = options.baseUrl ?? "https://api.github.com"
  const doFetch = options.fetchImpl ?? fetch

  return {
    name: "github",
    submit: async (payload: NormalizedFeedback): Promise<FeedbackSubmitResult> => {
      const tokenOpt = options.getToken()
      if (tokenOpt.isEmpty) {
        return { error: "No GitHub token configured", success: false }
      }
      const token = tokenOpt.orThrow(new Error("unreachable"))

      const labels = [...(options.defaultLabels ?? []), ...payload.labels]
      const body = JSON.stringify({
        body: payload.body,
        labels: FSet(labels).toArray(),
        title: payload.title,
      })

      const attempt = await Try.fromPromise(
        doFetch(`${baseUrl}/repos/${options.repo}/issues`, {
          body,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          method: "POST",
        }),
      )

      return attempt.foldAsync<FeedbackSubmitResult>(
        (error) => ({
          error: error instanceof Error ? error.message : "Unknown error submitting to GitHub",
          success: false,
        }),
        async (res) => {
          const data = (await res.json().catch(() => ({}))) as GithubIssueResponse

          if (!res.ok) {
            return {
              error: `GitHub API ${String(res.status)}: ${data.message ?? res.statusText}`,
              success: false,
            }
          }

          return {
            id: Option(data.number).fold(
              () => undefined,
              (n) => String(n),
            ),
            success: true,
            url: data.html_url,
          }
        },
      )
    },
  }
}
