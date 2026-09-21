- **The ADK auto-promote structural-truncation check now covers the enumerated full-width and CJK bracket pairs.**

  Slice 2 refused a structurally truncated claim on the unattended promotion
  path with an ASCII-only delimiter table, so a truncated full-width or CJK
  claim was judged balanced and auto-promoted. The table is extended from the
  ASCII pairs `( )`, `[ ]`, `{ }` to exactly the enumerated set
  `( ) [ ] { } （ ） ［ ］ ｛ ｝ 【 】 〔 〕 〖 〗 「 」 『 』`. One list is the
  single source: the opener set and the closer map are both derived from it. A
  truncated claim that leaves any of those open, or closes one with a
  mismatched partner (across widths too, e.g. `（… )`), is refused with
  `incomplete_claim` and left pending for the human `rem promote` path. The
  advisory `hasTerminalPunctuation` flag gains the full-width/CJK terminators
  `。` `！` `？` and the matching bracket closers in the same pass, so the two
  halves of the signal keep the same coverage.

  **The claim is these enumerated pairs, nothing more.** The check is not
  derived from Unicode general categories and is not "Unicode-aware": category
  membership does not establish paired usage, and a category counter refuses
  ordinary complete prose (see the quotation-mark limit below). No Unicode data
  is vendored and nothing is generated.

  Known limits:

  - **Backtick parity is not pairing.** The check counts backticks and refuses
    an odd total; it never matches an opener to a closer. A legitimate Markdown
    escape span — a literal backtick wrapped in a double-backtick span (`` ` ``)
    — is a complete, well-formed span yet has an odd backtick count, so it is
    refused.
  - **Quotation marks of any script are not counted.** `“ ” ‘ ’ „ “ ‚ ‘ « »`
    are not in the table, so a claim truncated mid-quotation is judged balanced
    and is not refused. This is deliberate, not an oversight: U+201E `„` (and
    U+201A `‚`) is category Ps while its closing mark U+201C (U+2018) is Pi, so
    a category-based counter refuses the ordinary *complete* German quotation
    `„Fertig.“`; and U+2019 `’` is the standard English apostrophe, so a quote
    leg refuses every English contraction. Enumerating the pairs avoids both
    false positives.
  - **A complete claim that merely discusses an unmatched delimiter is
    refused.** The delimiter is counted without interpreting context, so prose
    that mentions an unmatched delimiter — an interval written half-open, or a
    lone bracket quoted in text — is refused on the unattended path.

  Such candidates are not lost: they remain pending for manual promotion, and
  the rate is unmeasured.

  > **Heads-up:** this detects STRUCTURAL truncation, not semantic completeness.
  > A claim can be perfectly balanced and still be a fragment; passing the check
  > says only that no imbalance was detected in the enumerated pairs, never that
  > a promoted claim is complete.

  (Refs #1756, #1775, #1776)
