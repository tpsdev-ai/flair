- **`record_usage` merges `memoryId` and `memoryIds` on every surface** (flair#1410).
  Native `/mcp` previously preferred `memoryIds` and silently dropped
  `memoryId` when both were supplied; `POST /RecordUsage` did the same
  (`data?.memoryIds ?? …`). Both now union, matching stdio `flair-mcp`.
  Anti-gaming bounds (RPM, one contribution per `(agentId, memoryId)`,
  capped boost) are unchanged.
