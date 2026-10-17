- **A non-admin Memory write never stores a vector the caller supplied, and never relabels a
  stored one.** An agent's POST, PUT or PATCH whose body carries a non-empty `embedding` has the
  caller's vector and `embeddingModel` stamp discarded before the write, and a body-level
  `embeddingModel` with no `embedding` is discarded too, so the caller can neither store a supplied
  vector nor change the stamp of a stored one. On POST and PUT the write then stores the vector the
  server computes for the row's own post-redaction text, or no vector when the model is unavailable
  — exactly as a write that sent no vector; a vector-only PATCH keeps the stored vector. A vector
  that `prepareSkillBody` carried from a stored skill row keeps the stamp stored beside it. An
  administrator's write, a trusted in-process write, a federation-sync record, and the
  `embedding: null` / `[]` handling are unchanged (flair#2573).
