- **A non-admin Memory write never stores a vector the caller supplied.** An agent's POST, PUT
  or PATCH that carries a non-empty `embedding` has the vector and its `embeddingModel` stamp
  discarded before the write; the server then embeds the row's own post-redaction text with the
  configured model and stamps the vector, and stores no vector when the model is unavailable (the
  auto-embed backfill embeds it later). This matches a write that sent no vector. An
  administrator's write, a trusted in-process write, a federation-sync record, and the
  `embedding: null` / `[]` handling are unchanged (flair#2573).
