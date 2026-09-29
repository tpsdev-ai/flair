- **The BM25 index builds in the background after startup, and `flair status` shows its progress.**
  A restart no longer leaves the lexical index unwarmed until the first text
  search. `flair status` reports building (docs and percent), ready (count,
  duration, age), or disabled with the reason. With more than one Harper
  worker, the line names the worker it describes. With `FLAIR_BM25_INDEX=false`
  or vector-only retrieval the index is not built, and that setting is not
  reported as a warning. Public `/Health` uses coarse wording when a background
  warm was skipped or an index became stale, without exposing internal reasons.

  (Closes #2032)
