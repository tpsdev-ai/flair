- **ADK auto-promote refuses a structurally truncated claim instead of persisting a fragment.**

  Slice 1 handled a generation the backend labelled incomplete (`finishReason`
  `length` / `content_filter`). This handles the other case: a claim reaches
  staging STRUCTURALLY TRUNCATED while the response still parses and validates —
  the observed candidate ended at an unclosed code span and parenthesis, and a
  truncated string is still a valid string in a valid object, so nothing upstream
  rejects it. The mechanism that produces such a well-formed fragment is not
  established. `decideAutoPromote` (the UNATTENDED promotion path) now refuses a
  claim with unbalanced backticks, parentheses, brackets or braces via a new
  typed skip reason `incomplete_claim`; the candidate stays pending for the human
  `rem promote` path. Missing terminal punctuation is deliberately NOT a refusal
  — plenty of legitimate claims end without a full stop, and a false refusal on
  an unattended path is silent — so that signal is surfaced as an advisory flag
  in `flair rem candidates` (and as `incompleteFlag` in its `--json` output)
  instead.

  The check counts delimiters without interpreting context, so a complete claim
  that merely discusses an unmatched delimiter is also refused on the unattended
  path — for example an interval written half-open, or prose quoting a lone
  bracket. Such candidates are not lost: they remain pending for manual
  promotion, and the rate is unmeasured.

  > **Heads-up:** this detects STRUCTURAL truncation, not semantic completeness.
  > A claim can be perfectly balanced and still be a fragment; a refusal here
  > says only that the text is structurally lopsided, never that a promoted
  > claim is complete.

  (Refs #1756)
