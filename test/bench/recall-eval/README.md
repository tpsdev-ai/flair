# recall-eval — deterministic recall-quality eval (Layer 1, #1216-a)

The authoritative recall-**quality** number for Flair, and the CI gate that
defends it. Fixed corpus, fixed query set, fixed relevance labels, fixed seeds →
the same numbers every run. No LLM judge, no sliding-window cue, no
corpus-derived relevance.

It replaces the noisy recall-quality signal (`flair quality` recall
spot-check) as the number we trust. See "What this fixes" below.

## What it measures

On the curated corpus (`../recall-harness/corpus.ts` — reused verbatim, one
source of truth), for each labelled query it retrieves through Flair's real
BM25+RRF at documented defaults (hybrid on, `scoring=raw`, nomic prefixes on)
and scores the ranking against the query's **fixed, hand-curated** relevant
memory id:

- **recall@1 / recall@5 / recall@10**
- **nDCG@10**
- **MRR**

## What this fixes (#17)

The old recall-quality signal — the `flair quality` recall spot-check
(`src/cli.ts` `deriveRecallCue` + `computeRecallSpotCheck`) — has three defects
this eval removes:

1. **Self-pollution.** The spot-check derives its "query" from a memory's OWN
   text (a sliding partial cue) and counts recall a success when that same
   memory returns. Relevance == query/corpus overlap by construction, so a
   corpus of near-duplicates scores a false "recall collapse" that is really
   duplicate density (flair#967 / #857 / #996). Here the labels are hand-curated
   and provably NOT reproducible from corpus-query overlap
   (`test/unit/recall-eval-labels.test.ts` — 6 of 30 curated labels differ from
   what lexical overlap would pick, and swapping to overlap labels changes the
   metric).
2. **Threshold below the noise.** This eval measures the noise band first
   (±0.000 across runs — fixed corpus + deterministic HNSW build) and sets each
   floor a margin of ≥2 whole queries below the measured value — orders of
   magnitude above the noise, so a breach is a real regression.
3. **Sliding-window noise.** Replaced by the deterministic rank metrics above.

The spot-check itself stays in place as a **live-health cratering probe** (a
different job: catch recall going to zero on a real corpus). This eval is the
**recall-quality** authority. The sibling `../recall-harness` is the
**scoring-config diagnostic** (composite-vs-raw / prefix A/B) — a third,
different question. Three roles, not three competing answers.

## Running it

Requires a build (Harper serves `dist/resources/*.js`) and the embedding model.

```bash
bun run build

# 3 independent runs (default) — reports mean + run-to-run spread + floors
bun run test/bench/recall-eval/run.ts

# more runs / measure without enforcing floors
bun run test/bench/recall-eval/run.ts --runs 5
bun run test/bench/recall-eval/run.ts --no-floor-check
```

Reuse a pre-downloaded model (read-only) to skip a HuggingFace pull:

```bash
export FLAIR_MODELS_DIR=/path/to/an/existing/flair/checkout/models
```

## The CI gate

`test/integration/recall-eval-gate.test.ts` runs this eval on the integration
lane (where the model is pre-downloaded), asserts every metric clears its floor,
and runs the self-pollution mutation-check against real retrieval. It skips
**visibly** when no model is present, so it never falsely passes.

## Measured (this build)

`nomic-embed-text-v1.5-Q4_K_M`, hybrid BM25+RRF on, `scoring=raw`, 3 independent
runs, 87 records / 30 labelled queries:

| metric | value | spread (3 runs) | floor |
|---|---|---|---|
| recall@1  | 0.833 | 0.000 | 0.73 |
| recall@5  | 0.967 | 0.000 | 0.87 |
| recall@10 | 0.967 | 0.000 | 0.90 |
| nDCG@10   | 0.917 | 0.000 | 0.82 |
| MRR       | 0.902 | 0.000 | 0.80 |

## Files

- `labels.ts` — the curated corpus binding (reuses `../recall-harness/corpus`),
  the FIXED relevance labels, the floors, and the lexical-overlap self-pollution
  control used by the mutation-check.
- `eval.ts` — one eval run (ingest → wait-searchable → retrieve → score),
  pure orchestration over `packages/flair-bench/lib`.
- `run.ts` — the multi-run runner (mean + spread + floor check).
