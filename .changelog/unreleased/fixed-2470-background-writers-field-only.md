- **Each converted Memory write names only its patch fields; it does not write the rest of the row.**

  The embedding backfill, usage-count bump, maintenance archive, feed dedup
  repair, last-reflected stamp, and synthetic boot migration now update only
  their respective Memory fields. Each still confirms the committed row before
  committing.

  The re-embed and the embedding-stamp fallback are converted separately
  (#2465): they write only `embedding`, `embeddingModel` and `updatedAt`.
