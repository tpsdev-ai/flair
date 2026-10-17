- **A non-admin Memory write never stores a vector the caller supplied, and never relabels a
  stored one.** An agent's POST, PUT or PATCH whose body carries a non-empty `embedding` has the
  caller's vector and `embeddingModel` stamp discarded before the write; a body-level
  `embeddingModel` with no `embedding` is discarded too. On POST and PUT the stored vector is then
  the server's (computed from the row's own post-redaction text when the model is available, the
  stored one an unchanged skill update carried, or none when the model is unavailable); a
  vector-only PATCH keeps the stored vector. A vector that `prepareSkillBody` carried from a stored
  skill row keeps the stamp stored beside it. An administrator's write, a trusted in-process write,
  a federation-sync record, and the `embedding: null` / `[]` handling are unchanged (flair#2573).
