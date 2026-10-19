- **Embedding writers write under the per-id Memory lock shared with owner PUT and PATCH.**

  The HTTP re-embed (`PATCH /Memory/<id>` with both embedding fields `null`)
  holds the id's lock from its first read through its commit, under its own
  hold-warning phase name, `patch-reembed`. It writes only the embedding
  fields, as before (#2478).
