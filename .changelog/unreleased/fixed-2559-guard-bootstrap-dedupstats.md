- **MemoryBootstrap's task-relevant selection and the `/MemoryDedupStats` sweep now consult the embedding-space guard (#2559).**

  They were the last consumers reading stored vectors without the guard
  `SemanticSearch` and the write-time dedup leg already use. When the store's
  model stamps are not known uniform in the current embedding space — a
  non-current stamp observed, or an unknown verdict (not yet verified, or a
  failed scan) — MemoryBootstrap refuses its task embedding, selects on the
  lexical leg alone and returns the same state-named warning `SemanticSearch`
  emits. `/MemoryDedupStats` runs no ANN query and returns no vector-derived
  counts, naming the guard state (`mixed`, `unverified` or `scan-failed`) in
  place of the cluster numbers, and persists nothing. A uniform store is
  unchanged.
