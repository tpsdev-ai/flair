- **MemoryBootstrap's task-relevant selection and the `/MemoryDedupStats` sweep now consult the embedding-space guard (#2559).**

  They were the remaining runtime vector-comparison consumers without the guard
  `SemanticSearch` and the write-time dedup leg already use. On a non-uniform
  verdict, MemoryBootstrap refuses its task embedding and returns the same
  state-named warning `SemanticSearch` emits; both use BM25 for guarded
  vector-only retrieval. `/MemoryDedupStats` runs no ANN query and returns no
  vector-derived counts, naming the guard state (`mixed`, `unverified` or `scan-failed`) in
  place of the cluster numbers, and persists nothing. A verified-uniform
  verdict preserves the prior behaviour.
