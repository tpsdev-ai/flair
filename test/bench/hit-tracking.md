# Hit-tracking write amplification and counter accounting

Remaining slice of [#1528](https://github.com/tpsdev-ai/flair/issues/1528) after
merged [#1545](https://github.com/tpsdev-ai/flair/pull/1545) (BM25 metadata-skip).
This path does **not** change lexical skip/cache behavior.

Search hits used to `patchRecord` the full Memory row. That is a Harper put of
the embedding-bearing record, feeds BM25/HNSW, and computes `retrievalCount`
from the already-retrieved snapshot — concurrent arms can lose increments
(Dex: 310 vs 320 puts).

Increments now go to `MemoryHitStat`. Per-id promise tails serialize flushes and
coalesce pending deltas. Memory.get/search overlay the stat row so the
observable Memory fields stay the same.

## Reproduction

```sh
bun run build
bun run build:cli
bun test test/unit/hit-tracking.test.ts
bun test test/integration/bm25-metadata-updates.test.ts
```

The Harper fixture is the same 1,000-row / 64 five-hit search harness as
[bm25-metadata.md](bm25-metadata.md). The probe now also instruments
`MemoryHitStat.put` and reads counters from that table.

## Expected contract

| Measurement | Before (#1545 head) | This slice |
|---|---:|---:|
| Memory puts / 64 five-hit searches | 320 | 0 |
| BM25 feed updates from those searches | 0 warm / 320 forced-legacy | 0 |
| Counter increase (seq and concurrency 8) | 310–320 | 320 |
| MemoryHitStat puts | — | \> 0 and ≤ 320 (coalesced under concurrency) |

Request p95/p99 and event-loop delay remain observational; this slice claims
write-amp and counter-accounting, not an end-to-end latency win.

Unit coverage of the coalescer (no Harper): 64 concurrent hits on one id and
320 hits across five ids increment exactly and write fewer times than hits.
