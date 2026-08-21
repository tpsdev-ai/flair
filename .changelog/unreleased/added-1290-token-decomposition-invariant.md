- **Conformance: token-decomposition invariant — the #1270 ledger identity is
  now enforced** (flair#1290, final step). A new `tokenDecomposition` invariant
  type in the `/mcp` tool contracts asserts `tokenEstimate ≈ scaffoldTokens +
  soulTokens + memoryTokens + trustTokens + eventsTokens` on every bootstrap
  payload the conformance engine checks, bounded on both sides: the gap may not
  exceed a per-shipped-item structured-overhead tolerance (an uncounted content
  class — the exact #1270 field gap — overshoots it), and the ledger sum may
  not exceed `tokenEstimate` beyond per-line rounding (a counter reporting
  content that never shipped is the same defect mirrored). The identity's terms
  and tolerance constants live in one place — the bootstrap contract
  declaration — and the #1270 ledger suite now reads them from there instead of
  re-declaring its own copy. Runs automatically at every `conform()` site: the
  connector-conformance suite (default, tight-budget, event-detail, count,
  trust, and hint fixtures) and the large-store heavy-lane workout. Test- and
  contract-layer only; no runtime behavior changes.
