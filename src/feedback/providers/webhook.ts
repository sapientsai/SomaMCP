import type { FeedbackProvider, FeedbackSubmitResult, NormalizedFeedback } from "../types.js"

export type WebhookFeedbackOptions = {
  fetchImpl?: typeof fetch
  headers?: Record<string, string>
  transform?: (payload: NormalizedFeedback) => unknown
  url: string
}

export const createWebhookFeedback = (options: WebhookFeedbackOptions): FeedbackProvider => {
  const doFetch = options.fetchImpl ?? fetch
  const transform = options.transform ?? ((p) => p)

  return {
    name: "webhook",
    submit: async (payload: NormalizedFeedback): Promise<FeedbackSubmitResult> => {
      try {
        const res = await doFetch(options.url, {
          body: JSON.stringify(transform(payload)),
          headers: {
            "Content-Type": "application/json",
            ...(options.headers ?? {}),
          },
          method: "POST",
        })

        if (!res.ok) {
          const text = await res.text().catch(() => "")
          return {
            error: `Webhook ${String(res.status)}: ${text || res.statusText}`,
            success: false,
          }
        }

        return { success: true }
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : "Unknown error posting to webhook",
          success: false,
        }
      }
    },
  }
}
