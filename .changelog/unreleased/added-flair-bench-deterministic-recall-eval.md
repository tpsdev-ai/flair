- **Deterministic recall-quality eval + CI gate (flair-bench Layer 1).** A new
  fixed-corpus, fixed-label, fixed-seed recall eval computes recall@1/5/10,
  nDCG@10 and MRR against hand-curated relevant-memory labels, through Flair's
  real BM25+RRF retrieval at documented defaults — no LLM judge, no
  corpus-derived relevance. It is measured ±0.000 across runs and gates CI on
  per-metric floors set a margin of ≥2 whole queries above that noise band, so a
  breach is a real regression rather than sampling wobble. This is now the
  authoritative recall-quality number; the `flair quality` recall spot-check
  remains a live-health cratering probe (its self-pollution caveats are tracked
  in flair#967 / #857 / #996), and the composite-vs-raw recall-harness remains
  the scoring-config diagnostic. The shared ingest/retrieve/metrics plumbing
  (`packages/flair-bench/lib/`) is the foundation the LongMemEval_s harness
  (Layer 2) builds on unchanged.
