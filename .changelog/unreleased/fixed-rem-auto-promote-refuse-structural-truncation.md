- **ADK auto-promote refuses a structurally truncated claim instead of persisting a fragment.**

  Slice 1 handled a generation the backend labelled incomplete (`finishReason`
  `length` / `content_filter`). This handles the case the backend cannot see: it
  reports `stop`, the JSON parses, the shape validates, and the claim is still a
  fragment because a nested UNESCAPED quote terminated the JSON string early —
  the observed claim, ending at `new Function(`, arriving as a
  complete-looking candidate. `decideAutoPromote` (the UNATTENDED promotion path)
  now refuses a claim with unbalanced backticks, parentheses, brackets or braces
  via a new typed skip reason `incomplete_claim`; the candidate stays pending for
  the human `rem promote` path. Missing terminal punctuation is deliberately NOT
  a refusal — plenty of legitimate claims end without a full stop, and a false
  refusal on an unattended path is silent — so that signal is surfaced as an
  advisory flag in `flair rem candidates` (and as `incompleteFlag` in its
  `--json` output) instead.

  > **Heads-up:** this detects STRUCTURAL truncation, not semantic completeness.
  > A claim can be perfectly balanced and still be a fragment; a refusal here
  > says only that the text is structurally lopsided, never that a promoted
  > claim is complete.

  (Refs #1756)
