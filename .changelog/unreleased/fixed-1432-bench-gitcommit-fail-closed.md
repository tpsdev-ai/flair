- **Benchmark artifacts can no longer silently record `gitCommit: null`.** The
  LongMemEval, payload-A/B and ingest-throughput harnesses resolve the flair
  commit under test from the flair code location — a checkout's `HEAD`, else the
  installed/exported package's `dist/build-info.json` stamp — and FAIL CLOSED
  with an actionable error (run from a checkout, build the package, or set
  `FLAIR_BENCH_COMMIT`) rather than sealing a null-commit artifact. A benchmark
  that cannot name the code it measured now refuses to produce one, so
  reproducibility is not silently lost (flair#1432). The checkout `HEAD` is
  trusted only when the code directory IS the repo root: an export unpacked
  inside an unrelated repo can no longer inherit that repo's `HEAD` via git's
  upward `.git` discovery — a real-but-wrong commit that would otherwise
  self-verify (flair#1477).
