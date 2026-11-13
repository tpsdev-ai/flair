# Harper indexed-terms spike (flair#2047)

Measures a Harper secondary index of BM25 tokens against today's per-worker
in-memory index (`resources/bm25-index.ts`). This is a spike harness. It does
not change retrieval.

The Harper process is a separate application in this directory. Flair's
`config.yaml` does not load it, and nothing here is added to `schemas/`.

## What it compares

Corpus shape comes from `test/bench/corpus-profiler/profiles`:

- Token length and Zipf slope: `corpus-v2.json` (mean about 26 tokens).
- Agent skew: `live-flint-2026-07.json` `recordsPerAgentSorted`, so a single
  scope is the dominant agent rather than an even split.

Vocabulary size grows from that profile's type/token counts with Heaps' law
at beta 0.5 (a spike assumption). Terms are synthetic (`t1`, `t2`, …) and
round-trip through the shipped `tokenize()`.

| Arm | What is written |
|---|---|
| `baseline` | Row with content and scope columns. No terms index. |
| `terms` | Same row plus `terms: [String] @indexed`, packed per-doc tf, and per-scope N / sum(dl) updated in the same transaction. This is the decision arm. |
| `terms-noagg` | Terms index without the scope aggregate. Run at 1k and 10k. |
| `terms-df` | Terms index plus a counter row per (scope, term). Run at 1k and 10k. |

Queries are in-process. "Today" is `Bm25Index.rank` after a cold corpus scan.
The Harper arm searches the `terms` index and scores with the shipped BM25
constants. Ranking is checked for bit-identical top-50 scores against an
oracle that matches `buildBM25`.

## Run

```bash
bun run test/bench/harper-terms-index/run.ts --sizes 1000,10000,100000
```

| Flag | Default | |
|---|---|---|
| `--sizes` | `1000,10000,100000` | Corpus sizes, fresh Harper each. |
| `--seed` | `2047` | Corpus seed. |
| `--reps` | auto (20 / 12 / 8) | Timed query reps after 2 warmups. |
| `--extras-max` | `10000` | Also run `terms-noagg` and `terms-df` at sizes at or below this. |
| `--out` | `results/spike-2047.json` | JSON plus a sibling `.md` table. |

The runner checks the copied profile numbers against the JSON, checks the
oracle against `buildBM25` and `Bm25Index`, then bundles `src/resource.ts`
into `resources/Bm25TermsSpike.js` (gitignored). Harper is started under
Node with `THREADS_COUNT=1`. Embeddings are not loaded.

There is no new unit-lane test. The self-check is part of the harness and
refuses to measure if ranking drifts.

## Decision rule

Adopt unless, at 100k, ingest regresses by more than about 20% (wall-clock
docs/s, or p95 of put+tokenize versus today's put) or warmed query p95
exceeds 2× the in-memory index on any head/mid × 1/3/8-term × single/broad
cell. The numbers and the recommendation are in `results/spike-2047.md`
after a run.
