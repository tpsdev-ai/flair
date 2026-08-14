- **`memory_get` no longer inlines the raw embedding vector.** Retrieving a memory
  by ID over the `/mcp` connector returned the record's full 768-float `embedding`
  array inline — thousands of noise tokens per record on chat surfaces with a fixed
  context budget. The vector is now omitted by default; pass `includeEmbedding=true`
  to include it. The `memory_store` and `memory_update` responses are stripped the
  same way; `memory_search` and `bootstrap` already excluded it.
