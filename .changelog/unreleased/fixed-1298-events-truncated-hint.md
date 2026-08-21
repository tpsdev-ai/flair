- **bootstrap: `eventsHint` distinguishes budget-truncated from genuinely-empty**
  (flair#1298). When org events cleared the lookback window and every relevance
  filter but none fit the remaining token budget, the empty `events` container
  claimed "present-but-empty by design, not dropped" — exactly the false
  reassurance the flair#1182 empty-container hints exist to prevent (the events
  were dropped; the payload said they weren't). `eventsHint` now mirrors
  `teammateFindingsHint`'s branches: the budget-truncated case says how many
  relevant events were admitted-then-skipped and that raising `maxTokens`
  includes them; the by-design wording is reserved for a genuinely event-less
  window. The count is of admitted-then-skipped events only — never derived
  from a gap that could imply withheld rows. Hint emission conditions are
  unchanged (present exactly when `events` ships empty), so the flair#1290
  `hintWhenEmpty` conformance invariant holds as declared.
