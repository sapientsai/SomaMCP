import type { FeedbackProvider, FeedbackSubmitResult, NormalizedFeedback } from "../types.js"

export type GithubFeedbackOptions = {
  baseUrl?: string
  defaultLabels?: ReadonlyArray<string>
  fetchImpl?: typeof fetch
  getToken: () => string | undefined
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
      const token = options.getToken()
      if (!token) {
        return { error: "No GitHub token configured", success: false }
      }

      const labels = [...(options.defaultLabels ?? []), ...payload.labels]
      const body = JSON.stringify({
        body: payload.body,
        labels: Array.from(new Set(labels)),
        title: payload.title,
      })

      try {
        const res = await doFetch(`${baseUrl}/repos/${options.repo}/issues`, {
          body,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          method: "POST",
        })

        const data = (await res.json().catch(() => ({}))) as GithubIssueResponse

        if (!res.ok) {
          return {
            error: `GitHub API ${String(res.status)}: ${data.message ?? res.statusText}`,
            success: false,
          }
        }

        return {
          id: data.number !== undefined ? String(data.number) : undefined,
          success: true,
          url: data.html_url,
        }
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "Unknown error submitting to GitHub",
          success: false,
        }
      }
    },
  }
}
