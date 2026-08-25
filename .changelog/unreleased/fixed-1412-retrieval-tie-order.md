- **Tied retrieval results now have a specified order** (flair#1412).
  When fused ranks are equal, the newer `createdAt` wins and `id`
  ascending is the total-order backstop, so the same query against the
  same store returns the same order after a restart. A missing
  `createdAt` sorts as oldest (never NaN). Recency within a tie is
  best-effort across federated writers — clock skew cannot reintroduce
  nondeterminism.
