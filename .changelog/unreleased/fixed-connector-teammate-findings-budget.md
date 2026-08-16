- **`bootstrap` over the /mcp connector now respects `maxTokens` when teammate
  findings are present.** The token budget charged each memory and teammate
  finding its short *prose* line, but on the connector path (where the prose
  `context` is a pointer) it is the heavier *structured* container object that
  actually ships — and that object is what `tokenEstimate` measures. Teammate
  findings, which carry an id, two timestamps and a source, ran well over their
  prose line, so several rode outside the enforced budget: a `maxTokens: 4000`
  bootstrap could serialize at ~5300 (+33%) with no org events involved
  (flair#1199). The selector now charges each item what it actually ships on the
  requested surface — the structured object on the connector path, the prose line
  on the REST/CLI prose path (which keeps its 0.44.6 selection capacity, flair#1207
  unchanged) — so a connector's payload stays within `maxTokens` plus a small,
  fixed JSON-scaffolding tolerance. A teammate-heavy conformance fixture now makes
  the budget-cap invariant catch this class (it fails if the fix is reverted).
