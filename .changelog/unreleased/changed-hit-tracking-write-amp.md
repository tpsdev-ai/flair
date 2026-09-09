- **Search hit-tracking no longer rewrites Memory rows.** Each returned hit
  increments a dedicated `MemoryHitStat` row instead of `patchRecord`-ing the
  full memory (embeddings included). Concurrent searches coalesce per id so
  overlapping hits add instead of losing increments. `GET /Memory/{id}` and
  Memory search still return `retrievalCount` and `lastRetrieved`.
