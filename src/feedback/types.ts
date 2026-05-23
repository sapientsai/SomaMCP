export type FeedbackType = "bug" | "feature" | "feedback" | "question"
export type FeedbackSeverity = "high" | "low" | "medium"

export type NormalizedFeedback = {
  body: string
  labels: ReadonlyArray<string>
  title: string
}

export type FeedbackSubmitSuccess = {
  id?: string
  success: true
  url?: string
}

export type FeedbackSubmitFailure = {
  error: string
  success: false
}

export type FeedbackSubmitResult = FeedbackSubmitFailure | FeedbackSubmitSuccess

export type FeedbackProvider = {
  readonly name: string
  submit: (payload: NormalizedFeedback) => Promise<FeedbackSubmitResult>
}
