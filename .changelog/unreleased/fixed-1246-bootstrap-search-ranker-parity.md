- **Bootstrap's teammate/task-relevant pass now ranks on the SAME hybrid
  (BM25 + union-RRF) retrieval as `memory_search` — and the inert
  `_score > 0.3` task-relevance floor is removed** (flair#1246). Bootstrap's
  task-relevant candidate pass invoked the shared retrieval core in HNSW-only
  mode (an accident of early code) while search ran hybrid, so the two
  surfaces ranked the same store+query on different signals: a record whose
  task-relevance is lexical (exact task terms inside semantically-atypical
  prose) fused to rank 1 in search but ranked below bland-generic noise on
  pure cosine in bootstrap (measured: cosine 0.5656 vs noise 0.6086 at N=21 —
  HNSW rank 6, fused rank 1), and at field scale (corpus larger than the
  bounded candidate pool) was excluded from bootstrap's pool entirely. The
  pass now resolves its mode from the same `hybridEnabled()` selector search
  uses and passes `currentTask` as the lexical leg, so bootstrap's teammate
  picks and `memory_search` agree — one ranker, one scale — and the
  `FLAIR_HYBRID_RETRIEVAL` kill-switch moves both surfaces together.

  The historical `TASK_RELEVANCE_FLOOR` (0.3, carried verbatim from the
  original raw JS dot-product scan) is removed rather than recalibrated: a
  6-variant measurement on the shipped embedding model proved it inert
  (nothing in 126 records scored under ~0.44 — it cut zero records and never
  delivered "show nothing when nothing's relevant" either, since
  fully-unrelated bland noise scores 0.44–0.63). Task-relevant selection is
  fused retrieval rank plus the existing token budget. Count semantics are
  unchanged in shape (`teammateFindingsIncluded + teammateFindingsTruncated
  == teammateFindingsMatched`); "matched" now means "entered the scored
  retrieval pool". A ranking-parity integration case (the measured
  max-dilution fixture) pins bootstrap's top teammate pick to search's top
  result so any future divergence of the two retrieval paths fails CI.
