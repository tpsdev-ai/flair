- **LongMemEval_s end-to-end benchmark (Layer 2).** A new `flair-bench`
  harness (`test/bench/longmemeval/`) that ingests each LongMemEval_s question's
  multi-session history into real Flair, retrieves via Flair's real BM25+RRF
  retrieval, has a pinned reader answer, and has a pinned local judge grade it —
  across four arms (flair, vector-only, full-context, no-context). Everything is
  pinned for local reproducibility: the dataset (HF commit + sha256), the judge
  and reader (Ollama manifest digests), num_ctx, retrieval config, and the exact
  grading prompts — all folded into a content-addressed run artifact. Judge and
  reader run locally via Ollama, so anyone re-runs the exact number with no
  external API key or spend. The harness produces numbers; publishing one is a
  separate, gated human decision recorded against the artifact hash. Repo-
  internal tooling — not part of the published `@tpsdev-ai/flair-bench` package.
