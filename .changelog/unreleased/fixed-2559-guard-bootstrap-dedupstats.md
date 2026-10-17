- **MemoryBootstrap's task-relevant selection and the `/MemoryDedupStats` sweep now consult the embedding-space guard (#2559).**

  They were the remaining request and maintenance paths covered by #2559 without the guard
  `SemanticSearch` and the write-time dedup leg already use. On a non-uniform
  verdict, MemoryBootstrap refuses its task embedding and returns the same
  state-named warning `SemanticSearch` emits; both use BM25 for guarded
  vector-only retrieval. When the opening verdict is non-uniform, `/MemoryDedupStats` runs no ANN query. A non-uniform verdict at either check returns no vector-derived counts, names `mixed`, `excluded`, `unverified` or `scan-failed`, and leaves stored stats unchanged. A verified-uniform
  verdict preserves the prior behaviour.
