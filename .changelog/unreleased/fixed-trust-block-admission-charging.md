- **Per-memory trust blocks are now charged against the bootstrap token budget.**
  When `includeTrust:true`, each candidate memory's projected trust block (the
  `buildTrustBlock(m)` serialization, including the conditional `matchQualityNote`)
  is charged against `tokenBudget` at the same admission moment as its content
  cost, at all five admission sites (permanent/recent/predicted/teammate/relevant).
  Previously the trust array was built post-admission and serialized without ever
  being counted, so `tokenEstimate` could overshoot `maxTokens * 1.25` on the
  `/mcp` connector path (measured ~772 uncounted tokens on 0.44.11). The
  `includeTrust:false` path is byte-identical — no trust cost is charged when
  trust is off, so content-only selection is unchanged.
