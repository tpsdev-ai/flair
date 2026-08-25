- **stdio MCP clients can record usage.** `@tpsdev-ai/flair-mcp` now exposes
  `record_usage` (POST `/RecordUsage`: memory id + optional one-line
  how-it-was-used) and an optional `usedMemoryIds` passthrough on
  `memory_store` / `memory_update`. `memory_search` and `bootstrap` append a
  one-line nudge to cite what you actually use — a search hit is not usage.
  Native `/mcp` already had this surface; the stdio package the issue named
  did not (flair#1147).
