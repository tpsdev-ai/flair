- **Re-embedding writes only `embedding`, `embeddingModel` and `updatedAt` and confirms the target before commit (#2465).**

  HTTP re-embedding returns `409 stored_row_changed` when confirmation fails;
  the embedding-stamp migration skips that row.
