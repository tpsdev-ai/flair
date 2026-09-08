# BM25 metadata update measurement

Run the isolated HTTP comparison after building the server and CLI:

```sh
bun run build
bun run build:cli
bun test test/integration/bm25-metadata-updates.test.ts
```

The fixture seeds 1,000 synthetic memories with supplied 768-dimensional vectors,
then runs 64 five-hit hybrid searches per arm at concurrency 1 and 8. It reverses
arm order to expose warm-up bias. The test-only probe runs in Flair’s component
scope and instruments actual Memory puts and BM25 feed updates. Each search is a
separate HTTP request so its transaction can commit before feed delivery.

The control forces the previous tombstone/re-tokenize path on the same index.
Assertions cover write attempts, observed feed updates, lexical replacements and
result membership. Request timing includes local HTTP and test assertions; no
latency threshold gates CI. Existing lexical equivalence tests cover exact ranking;
the real-Harper equivalence suite accounts for HNSW tie/order jitter separately.

## Recorded sample

[Raw observations](bm25-metadata-measurements.json) were collected on macOS,
Node 24.15.0, Bun 1.3.13, Harper 5.2.8. The baseline source is cd6d24d.
Each range below spans the two arm orders, not a confidence interval.

| Measurement | Replacement control | Bounded exact-body cache |
|---|---:|---:|
| Sequential writes / 64 searches | 320 | 320 |
| Sequential lexical replacements | 320 | 0 |
| Sequential total lexical update time | 5.81–5.99 ms | 0.57–0.75 ms |
| Sequential request p95 | 2.58–6.86 ms | 2.51–2.76 ms |
| Sequential request p99 | 2.75–7.84 ms | 2.86–2.92 ms |
| Concurrent total lexical update time | 2.09–2.58 ms | 0.26–0.32 ms |
| Concurrent request p95 | 16.80–20.95 ms | 16.95–18.38 ms |
| Concurrent request p99 | 17.47–27.95 ms | 19.49–22.63 ms |
| Concurrent event-loop p99 | 4.37–5.81 ms | 4.73–5.02 ms |

Index-update work falls clearly; this small fixture does **not** establish an
end-to-end latency improvement. In concurrent arms, 320 successful put calls
produced 124–134 observed feed updates. One arm advanced the counters by 310;
the others advanced them by 320. These observations do not establish atomicity,
one event per call, or a fix for counter loss. Storage writes and counters are
unchanged by this optimization and remain work for #1528.

## Retention cost

The cache holds at most 1,024 bodies totaling 512 Ki UTF-16 code units. It compares
exact strings and snapshots of every indexed metadata field. An evicted or
oversized body takes the original rebuild path. No content hash can authorize a
skip, and cache state never changes query scope or results.

To measure retained heap in a separate process on either revision, place the
same script under `test/bench/`, build that revision, then run:

```sh
node --expose-gc test/bench/bm25-metadata-retention.mjs
```

The 20,000-row fixture has 16,870,000 bytes of body text and 2,000,000 postings.
Across three fresh Node processes per revision, retained heap delta was about
7.32 MB for baseline and 7.95 MB with the bounded cache (about 0.63 MB extra).
RSS delta was 85.6–86.0 MB versus 125.9–128.4 MB: allocator/high-water behavior
is materially larger than retained JS heap and must not be presented as a
sub-megabyte process-memory claim. These are synthetic cold-build measurements,
not a production capacity forecast or a growing-store benchmark.
