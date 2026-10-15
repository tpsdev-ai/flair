## BM25 Harper indexed-terms spike (flair#2047)

Recommendation: **do-not-adopt**.

Query p95 misses the 2× bar on every cell at 100k. That includes head queries, where the in-memory index is already walking a large posting list (about 6–14×), not only mid queries whose memory p95 is sub-millisecond and whose ratio is mostly fixed search overhead. Ingest here is the lexical row only — content, scope columns, and the terms index — with no embedding. The absolute add at 100k is about a quarter of a millisecond per put. That delta would be a small fraction of an embedding-bound `Memory.put`, but the query gate fails on its own, so the recommendation does not depend on reading the ingest percentage as an end-to-end Memory.put regression.

Decision rule: adopt unless ingest regresses by more than ~20% OR query p95 exceeds ~2× today's warm in-memory index at 100k.

### Environment

- Host: Intel(R) Xeon(R) Processor × 4, 15.6 GiB RAM, linux 6.12.94+ x64
- Harper Node v22.22.2, Harper 5.2.8. Runner /home/ubuntu/.bun/bin/bun v24.3.0. Flair git e4c8aeaec5f342b974bc682a6f4e45ac14f770d5.
- Isolated Harper, THREADS_COUNT=1, no embedding. Puts are one transaction each, sequential.
- Corpus: corpus-v2 token length (mean 26.32, stdev 2.90, clamp 19–33) and Zipf slope -0.6903414125045878. Vocabulary grows with Heaps beta 0.5 from the profile's 2809 types / 6607 tokens. Scope skew is live-flint recordsPerAgentSorted [898,64,46,41,21,4,4,2] (single = a0, the dominant share).

### Ingest

| n | arm | docs/s | put p50 ms | put p95 ms | put+tokenize p50 | put+tokenize p95 | mean unique terms |
|---|---|---:|---:|---:|---:|---:|---:|
| 1000 | baseline | 4933 | 0.14 | 0.35 | 0.14 | 0.35 | 25.9 |
| 1000 | terms | 2171 | 0.38 | 0.72 | 0.39 | 0.72 | 25.9 |
| 1000 | terms-noagg | 4161 | 0.19 | 0.33 | 0.19 | 0.33 | 25.9 |
| 1000 | terms-df | 475 | 2.01 | 2.66 | 2.02 | 2.67 | 25.9 |
| 10000 | baseline | 9370 | 0.07 | 0.15 | 0.07 | 0.15 | 26.1 |
| 10000 | terms | 2979 | 0.28 | 0.51 | 0.28 | 0.52 | 26.1 |
| 10000 | terms-noagg | 4594 | 0.18 | 0.23 | 0.18 | 0.24 | 26.1 |
| 10000 | terms-df | 435 | 2.20 | 2.86 | 2.21 | 2.87 | 26.1 |
| 100000 | baseline | 11078 | 0.07 | 0.10 | 0.07 | 0.10 | 26.2 |
| 100000 | terms | 2680 | 0.32 | 0.49 | 0.32 | 0.50 | 26.2 |

### Query p50 / p95 (ms), warmed

| n | scope | band | terms | memory p50 | memory p95 | harper hybrid p50 | harper hybrid p95 | ratio p95 |
|---|---|---|---:|---:|---:|---:|---:|---:|
| 1000 | single | head | 1 | 0.222 | 0.687 | 3.047 | 4.534 | 6.60 |
| 1000 | single | mid | 1 | 0.011 | 0.012 | 0.420 | 0.449 | 38.0 |
| 1000 | single | head | 3 | 0.325 | 0.370 | 4.982 | 5.756 | 15.6 |
| 1000 | single | mid | 3 | 0.019 | 0.022 | 1.105 | 1.251 | 56.0 |
| 1000 | single | head | 8 | 0.238 | 0.448 | 9.517 | 10.5 | 23.5 |
| 1000 | single | mid | 8 | 0.019 | 0.019 | 2.961 | 3.783 | 196 |
| 1000 | broad | head | 1 | 0.114 | 0.120 | 1.820 | 2.181 | 18.2 |
| 1000 | broad | mid | 1 | 0.007 | 0.007 | 0.310 | 0.408 | 56.9 |
| 1000 | broad | head | 3 | 0.188 | 0.204 | 3.847 | 4.437 | 21.7 |
| 1000 | broad | mid | 3 | 0.014 | 0.025 | 0.823 | 0.928 | 36.5 |
| 1000 | broad | head | 8 | 0.247 | 0.268 | 7.086 | 7.418 | 27.7 |
| 1000 | broad | mid | 8 | 0.020 | 0.025 | 2.047 | 2.615 | 106 |
| 10000 | single | head | 1 | 1.617 | 2.249 | 21.4 | 26.7 | 11.9 |
| 10000 | single | mid | 1 | 0.016 | 0.020 | 2.909 | 8.506 | 428 |
| 10000 | single | head | 3 | 2.309 | 3.018 | 36.1 | 37.5 | 12.4 |
| 10000 | single | mid | 3 | 0.029 | 0.032 | 8.186 | 8.382 | 258 |
| 10000 | single | head | 8 | 3.115 | 4.539 | 70.3 | 72.3 | 15.9 |
| 10000 | single | mid | 8 | 0.056 | 0.498 | 21.4 | 22.6 | 45.3 |
| 10000 | broad | head | 1 | 1.255 | 1.619 | 14.5 | 15.9 | 9.84 |
| 10000 | broad | mid | 1 | 0.017 | 0.022 | 1.680 | 1.850 | 82.4 |
| 10000 | broad | head | 3 | 2.216 | 3.165 | 28.4 | 29.1 | 9.19 |
| 10000 | broad | mid | 3 | 0.029 | 0.382 | 4.857 | 5.614 | 14.7 |
| 10000 | broad | head | 8 | 3.165 | 4.000 | 49.3 | 50.1 | 12.5 |
| 10000 | broad | mid | 8 | 0.060 | 0.703 | 12.4 | 13.6 | 19.3 |
| 100000 | single | head | 1 | 14.7 | 24.9 | 144 | 153 | 6.17 |
| 100000 | single | mid | 1 | 0.086 | 0.251 | 28.7 | 29.5 | 117 |
| 100000 | single | head | 3 | 24.4 | 26.2 | 317 | 330 | 12.6 |
| 100000 | single | mid | 3 | 0.123 | 0.140 | 84.8 | 86.1 | 614 |
| 100000 | single | head | 8 | 40.8 | 46.6 | 610 | 639 | 13.7 |
| 100000 | single | mid | 8 | 0.290 | 0.307 | 226 | 245 | 798 |
| 100000 | broad | head | 1 | 13.8 | 16.8 | 145 | 152 | 9.03 |
| 100000 | broad | mid | 1 | 0.051 | 0.072 | 15.8 | 16.6 | 230 |
| 100000 | broad | head | 3 | 25.2 | 43.4 | 299 | 320 | 7.36 |
| 100000 | broad | mid | 3 | 0.129 | 0.152 | 46.7 | 47.5 | 312 |
| 100000 | broad | head | 8 | 37.4 | 42.9 | 522 | 588 | 13.7 |
| 100000 | broad | mid | 8 | 0.283 | 1.395 | 124 | 129 | 92.2 |

### Cold build (what adoption removes) and disk

| n | cold build ms | baseline footprint bytes | terms-table bytes | estimated same-row growth bytes | term index entries |
|---|---:|---:|---:|---:|---:|
| 1000 | 35.5 | 190885 | 621949 | 431064 | 25903 |
| 10000 | 247 | 2025114 | 6622526 | 4597412 | 260916 |
| 100000 | 2648 | 32458877 | 137003887 | 104545010 | 2619653 |

`estimatedSameRowGrowth` = (du after the terms table) − (du after the baseline table) − (baseline table footprint). The terms table repeats content and the scope columns, so subtracting the baseline footprint estimates the bytes a same-row `terms` index would add. Negative values mean fixed overhead dominated; use the raw du fields in the JSON.

### Per-scope statistics

Three ways df / N / avgdl can come out of Harper, timed separately from the ranking formula:

1. **Hybrid (decision query).** N and sum(dl) are point reads of a per-scope aggregate written in the same transaction as the row. df is the length of the term's posting list, which the scorer reads anyway. Scoped df is therefore not a second pass.
2. **Scope scan.** N and avgdl come from walking every row in the scope (`docLen` only) on each query. df still comes from postings. See `harperScopeScan` in the JSON.
3. **Global index count.** `terms` index `getValuesCount(term)` counts index entries for one token. It is global df, not scoped df, so it is the wrong idf for a single-agent query. At n=50 it was ~0.01ms; at 100k, df(t1)=24906, it was ~3.8ms p50. Cost is `globalDfCount`.
4. **Maintained per-(scope, term) df.** Extra counter rows, one per unique term per scope plus a global counter. Ingest cost is the `terms-df` arm (1k and 10k). Query cost is two point reads (`dfProbe`).

Measured at 100k unless noted:

| strategy | cost |
|---|---|
| scope aggregate point read (agent + `__all__`) | 0.020ms p50 |
| `getValuesCount("t1")` global df=24906 | 3.81ms p50 |
| maintained df point reads (10k, two gets) | 0.016ms p50 |
| scope scan for N/avgdl, broad head 1-term | 819ms p95 (hybrid posting path for the same query is 152ms p95) |
| `terms-df` ingest at 10k | 435 docs/s vs 2979 docs/s for terms+scope-aggregate vs 9370 docs/s baseline |
| `terms-noagg` ingest at 10k | 4594 docs/s, put p95 0.23ms (index entries alone, no scope aggregate) |

Harper's planner leads head queries with the `terms` index (`estimated_count` 24906 for `t1`), then filters scope. Single scope `a0` is 83129/100000 docs, the live profile's dominant share. Cold build of the in-memory index at 100k is 2.6s (what adoption would remove).

### Ranking equivalence

- n=1000: 12/12 query/scope cells bit-identical on top-50 scores; memory-index id match 12/12.
- n=10000: 12/12 query/scope cells bit-identical on top-50 scores; memory-index id match 12/12.
- n=100000: 12/12 query/scope cells bit-identical on top-50 scores; memory-index id match 12/12.

### Federation

Store `terms` on the memory row and let it replicate with the row. Harper builds the secondary index locally from the replicated values, so the receiver does not re-tokenize. Recomputing on receive would duplicate that index build and would drift if `tokenize()` ever diverged between peers. The attribute is a pure function of `content`, but the durable copy is the one written in the author's transaction.

### Gates

- FAIL `ingest-throughput`: terms docs/s 2680 vs baseline 11078 (75.8% regression, gate 20%)
- FAIL `ingest-p95`: terms put+tokenize p95 0.50ms vs baseline put p95 0.10ms (5.05×, gate 1.2×)
- FAIL `query-single-head-1`: single head 1-term p95 153ms vs memory 24.9ms (6.17×)
- FAIL `query-single-mid-1`: single mid 1-term p95 29.5ms vs memory 0.25ms (117×)
- FAIL `query-single-head-3`: single head 3-term p95 330ms vs memory 26.2ms (12.6×)
- FAIL `query-single-mid-3`: single mid 3-term p95 86.1ms vs memory 0.14ms (614×)
- FAIL `query-single-head-8`: single head 8-term p95 639ms vs memory 46.6ms (13.7×)
- FAIL `query-single-mid-8`: single mid 8-term p95 245ms vs memory 0.31ms (798×)
- FAIL `query-broad-head-1`: broad head 1-term p95 152ms vs memory 16.8ms (9.03×)
- FAIL `query-broad-mid-1`: broad mid 1-term p95 16.6ms vs memory 0.07ms (230×)
- FAIL `query-broad-head-3`: broad head 3-term p95 320ms vs memory 43.4ms (7.36×)
- FAIL `query-broad-mid-3`: broad mid 3-term p95 47.5ms vs memory 0.15ms (312×)
- FAIL `query-broad-head-8`: broad head 8-term p95 588ms vs memory 42.9ms (13.7×)
- FAIL `query-broad-mid-8`: broad mid 8-term p95 129ms vs memory 1.39ms (92.2×)

Ingest gate uses wall-clock docs/s and p95 of (Harper put + tokenize) versus today's put of the same row without a terms index. Tokenize is inside the indexed arm because the attribute cannot be written without it; it is also reported separately.
Query gate uses warmed p95. Head queries include the most frequent term. Mid queries sit off the head. Single scope is the dominant agent share from the live profile. Broad scope is the whole corpus.
Stats on the decision query are maintained per-scope N and sum(dl), plus df taken from the posting list the scorer has to read anyway.
