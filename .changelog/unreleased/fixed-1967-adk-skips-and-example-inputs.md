- **ADK Python logs skipped text-less entries on a successful write, and the concierge example rejects empty input.**
  `add_memory` logs one warning with the count of skipped text-less entries when every attempted write succeeds; a failed write still reports them in `FlairWriteError.skipped`. The team-concierge example's `record_decision` and `record_personal` tools return an error for empty input instead of writing.

  (Refs #1967)
