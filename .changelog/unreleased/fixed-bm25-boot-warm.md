- **The BM25 index builds in the background after startup, and `flair status` shows its progress.**
  A restart no longer leaves the lexical index unwarmed until the first text
  search. `flair status` reports building (docs and percent), ready (count,
  duration, age), or disabled with the reason. With more than one Harper
  worker, the line names the worker it describes.

  (Closes #2032)
