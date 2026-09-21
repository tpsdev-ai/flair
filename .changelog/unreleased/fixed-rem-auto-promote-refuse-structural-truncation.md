- **ADK auto-promote refuses a structurally truncated claim instead of persisting a fragment.**

  Slice 1 handled a generation the backend labelled incomplete (`finishReason`
  `length` / `content_filter`). This handles the other case: a claim reaches
  staging STRUCTURALLY TRUNCATED while the response still parses and validates —
  the observed candidate ended at an unclosed code span and parenthesis, and a
  truncated string is still a valid string in a valid object, so nothing upstream
  rejects it. The mechanism that produces such a well-formed fragment is not
  established. `decideAutoPromote` (the UNATTENDED promotion path) now refuses a
  claim with unbalanced ASCII backticks, parentheses, brackets or braces via a
  new typed skip reason `incomplete_claim`; the candidate stays pending for the
  human `rem promote` path. Missing terminal punctuation is deliberately NOT a
  refusal — plenty of legitimate claims end without a full stop, and a false
  refusal on an unattended path is silent — so that signal is surfaced as an
  advisory flag in `flair rem candidates` (and as `incompleteFlag` in its
  `--json` output) instead.

  **The delimiter check is ASCII-only.** It recognizes the ASCII backtick and the
  ASCII pairs `( )`, `[ ]` and `{ }`. It does NOT recognize non-ASCII pairs —
  full-width parentheses and brackets (`（）`, `［］`, `｛｝`) and CJK lenticular
  brackets (`【】`, `〔〕`, `〖〗`) — so a truncated claim written with those
  characters is judged balanced and CAN STILL BE AUTO-PROMOTED on the unattended
  path. A candidate's locale is not bounded. Extending the delimiter set to
  non-ASCII pairs is a separate change, not this one.

  Known limits:

  - **Backtick parity is not pairing.** The check counts backticks and refuses an
    odd total; it never matches an opener to a closer. A legitimate Markdown
    escape span — a literal backtick wrapped in a double-backtick span (`` ` ``) —
    is a complete, well-formed span yet has an odd backtick count, so it is
    refused.
  - **A complete claim that merely discusses an unmatched delimiter is refused.**
    The delimiter is counted without interpreting context, so prose that mentions
    an unmatched delimiter — an interval written half-open, or a lone bracket
    quoted in text — is refused on the unattended path.

  Such candidates are not lost: they remain pending for manual promotion, and the
  rate is unmeasured.

  > **Heads-up:** this detects STRUCTURAL truncation, not semantic completeness.
  > A claim can be perfectly balanced and still be a fragment; a refusal here
  > says only that the text is structurally lopsided, never that a promoted
  > claim is complete.

  (Refs #1756, #1775)
