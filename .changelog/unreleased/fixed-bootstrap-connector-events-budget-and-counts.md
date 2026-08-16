- **`bootstrap` org events now respect `maxTokens`, drop boot noise, and the
  counters add up.** The structured `events` array was assembled but never
  charged against the token budget, and every event shipped a verbose `detail`
  blob — a `maxTokens: 4000` request serialized at ~6286 (flair#1199). Events are
  now counted against the shared budget like every other content section, ship
  LEAN by default (opt the `detail` JSON back in with `includeEventDetail: true`),
  and honor a `maxEvents` cap. Zero-row no-op auto-heal migration events (the
  "graph-heal verified / migration success (0 rows)" pairs that fire every boot)
  are suppressed at render, freeing the scarce event slots for signal — the
  migration ledger still records every one (flair#1200). Count arithmetic is
  fixed too: `memoriesIncluded + memoriesTruncated` can no longer exceed
  `memoriesAvailable` (a memory considered in two sections was double-counted),
  and teammate findings now report `teammateFindingsMatched` (the relevance-floor
  pool) so `teammateFindingsTruncated` reads as "relevant but no budget," not
  "every candidate not selected" (flair#1207). The connector-conformance suite
  gains two invariants that catch these classes: `tokenEstimate <= maxTokens`
  (within a scaffolding tolerance) and `included + truncated <= available`.
  Connectors simply get a payload that fits the budget they asked for.
