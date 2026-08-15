- **Bootstrap payload quality: no double-serialization, honest token accounting,
  coherent counters, deduped org events, and freshness off `updatedAt`.** The
  `/mcp` bootstrap connector no longer receives every soul and memory body twice
  (once in the prose `context`, once in the structured containers): the
  structured `soul`/`memories`/`predicted` fields are canonical, teammate
  findings now ship in a new structured `teammateFindings` container, and the
  prose `context` is opt-in (`includeContext`, off by default on the `/mcp`
  path). `tokenEstimate` now reflects the actual serialized payload and
  `maxTokens` bounds it. `memoriesIncluded` is own-scoped so it can no longer
  exceed `memoriesAvailable`, with cross-agent hits counted separately as
  `teammateFindingsIncluded`. Byte-identical org events are deduped before the
  scarce-slot cutoff. Trust-block freshness (`ageDays`) now keys off a record's
  own `updatedAt` (falling back to `createdAt`), so a record edited today reads
  as fresh, and each bootstrap trust entry is tagged with its `section` so a
  `matchQuality` of null on a lifecycle load is legible rather than reading as a
  scoring failure.
