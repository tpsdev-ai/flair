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

## Recorded sample

Real Harper 5.2.8, Node 22.22.2, Bun 1.3.10, 1,000 synthetic rows, 64 five-hit
searches per arm, both arm orders, concurrency 1 and 8. Probe wraps Memory.put
and MemoryHitStat.put and reads counters from MemoryHitStat.

| Measurement | Sequential (c=1) | Concurrent (c=8) |
|---|---:|---:|
| Memory puts | 0 | 0 |
| BM25 feed updates / replacements | 0 | 0 |
| MemoryHitStat successful puts | 320 | 315–320 |
| Counter increase | 320 | 320 |
| Request p95 | 5.13–6.68 ms | 28.77–34.41 ms |
| Request p99 | 5.54–9.93 ms | 30.07–36.11 ms |
| Event-loop p99 | 4.46–6.86 ms | 6.62–8.48 ms |

Every arm — including concurrency 8 — advanced counters by exactly 320. One
concurrent arm coalesced to 315 stat puts while still accounting 320 increments.
#1545 recorded a 310/320 counter miss on a concurrent arm; that miss is gone
without rewriting Memory.

Request p95/p99 and event-loop delay remain observational; this slice claims
write-amp and counter-accounting, not an end-to-end latency win.

Unit coverage of the coalescer (no Harper): 64 concurrent hits on one id and
320 hits across five ids increment exactly and write fewer times than hits.
