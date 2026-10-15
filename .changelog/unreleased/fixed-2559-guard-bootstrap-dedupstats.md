- **MemoryBootstrap's task-relevant selection and the `/MemoryDedupStats` sweep now consult the embedding-space guard (#2559).**

  They were the remaining runtime vector-comparison consumers without the guard
  `SemanticSearch` and the write-time dedup leg already use. On a non-uniform
  verdict, MemoryBootstrap refuses its task embedding, selects on the
  lexical leg alone and returns the same state-named warning `SemanticSearch`
  emits. `/MemoryDedupStats` runs no ANN query and returns no vector-derived
  counts, naming the guard state (`mixed`, `unverified` or `scan-failed`) in
  place of the cluster numbers, and persists nothing. A verified-uniform
  verdict preserves the prior behaviour.
