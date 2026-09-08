- **Query-time vector-space uniformity guard.** Recall and write-time dedup now
  refuse to cosine a query against stored vectors when the corpus is not uniform
  in the current embedding space (a mixed-space corpus during any re-embed or
  model change). Previously such a corpus served silently-wrong results — Harper
  zero-pads a mismatched-dimension vector and returns a garbage score instead of
  throwing, and health only warned. The recall embedding leg now degrades to
  keyword-only with a structured warning naming both spaces and the `flair
  reembed` remedy; the write-time dedup leg no-ops (never suppressing a write).
  Embedding stamps are now engine-qualified (`gguf:<model>`); today's bare-name
  corpus is treated as the same space, so no re-embed is triggered and the
  default path is unchanged. A memory synced in from a federation peer on a
  different engine/model also trips the guard, so a mixed-space sync degrades
  recall to keyword-only rather than serving garbage.
