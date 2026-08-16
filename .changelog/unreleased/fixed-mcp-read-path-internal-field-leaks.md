- **`/mcp` read paths no longer leak internal fields or throw a misdirecting
  error.** `memory_get` now strips `embeddingModel` alongside `embedding` (the
  write tools already dropped both, so the read path was the last leak), and
  `memory_update` against a non-existent id now returns a clean `not found`
  instead of throwing `Invalid primary key of null`. Nothing to do — connectors
  simply stop seeing an internal model-id field and get a parseable 404.
