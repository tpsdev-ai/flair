- **Hybrid search no longer reports the RRF rank-normalized value as `_score`
  under `scoring:"raw"` — `_score` is an absolute similarity again**
  (flair#985). The hybrid path pinned the top result of ANY query at exactly
  1.0 by construction, so every consumer thresholding `_score` as a
  similarity failed open at maximal confidence: the pre-0.18 flair-client
  dedup gate (still live in stale installs and in openclaw-flair's committed
  dist through 0.21) saw a ≥0.95 "similarity" on EVERY `memory_store` probe
  and silently suppressed the write into whatever memory ranked first —
  however unrelated — producing `written:false` cross-topic data loss, and
  turning the delete+store update pattern into a destroy-both-copies path.
  `minScore` and `flair doctor`'s embed-verify probe carried the same broken
  scale. Hybrid results are still ORDERED by RRF fusion (the recall win is
  untouched; a BM25 rescue can outrank a weak semantic hit), but each
  result's `_score` now reports its true cosine (+ the legacy keyword bump),
  `minScore` filters on that honest scale, BM25-only candidates get a real
  point-lookup cosine instead of a fabricated rank value, and composite
  mode's `_rawScore` reports the absolute value while composite ordering is
  unchanged. Server-side dedup (the #526/#548 never-suppress gate) was never
  the loss vector and is untouched; the #985 report's five cross-topic pair
  shapes are pinned as regression fixtures against its cosine+Jaccard
  co-gate.
