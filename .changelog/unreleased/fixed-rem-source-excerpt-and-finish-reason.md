- **REM distillation no longer passes off a truncated source or a length-capped response as a complete claim.**

  `buildSourceMemoriesBlock` silently sent `content.slice(0, 300)`, so a
  complete source memory could reach the model as an unfinished expression with
  nothing marking it cut short; a longer source is now presented as an
  EXPLICITLY identified excerpt (tag `excerpt="true"` plus an
  `[excerpt truncated]` marker, charged against the same per-source budget),
  never a silent prefix. Source text and attribute values are escaped so the
  excerpt annotation cannot be counterfeited by the content it annotates, and
  the per-source budget is charged against the escaped body so escaping never
  grows the prompt. The local generate contract now carries Harper's
  `finishReason`, and a response the backend flagged `length` or
  `content_filter` is rejected/retried (`incomplete_generation`, HTTP 502)
  rather than staged as a finished thought. Detection depends on the completion
  reasons the backend adapter preserves; a missing or unrecognized reason is not
  rejected. Ordinary `stop` still stages as
  before — it does not, on its own, prove a claim is semantically complete.
  (Refs #1756)
