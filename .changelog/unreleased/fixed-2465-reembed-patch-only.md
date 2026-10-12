- **Background re-embedding via Memory PATCH and the migration fallback updates only `embedding`, `embeddingModel` and `updatedAt`, confirming the target before commit (#2465).**

  HTTP re-embedding returns `409 stored_row_changed` when confirmation fails;
  the embedding-stamp migration skips that row.
