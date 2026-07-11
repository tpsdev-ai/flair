# recall-harness — isolated recall-eval harness

Measures Flair's recall precision (p@3, MRR) against a **harder, representative
synthetic corpus**, on a **fully ephemeral Harper instance**. It never touches
`~/ops/flair`, the live `:9926` service, or any production memory.

## Why this exists

Two recall tools already live in `ops/tools/agent-fabric/`:

- **`recall-eval.mjs`** measures against flint's LIVE production memory
  corpus over the network. It's the only tool that's ever caught a real
  regression (it's what found flair#623 — see below) but it can only run
  *on* the live server, it mutates the corpus it measures
  (`retrievalCount` bumps on every query), and its ground truth rots as
  real memories get added/superseded. There was no safe way to try a
  scoring/retrieval change without measuring against production.
- **`recall-bench.mjs`** IS isolated — it seeds a synthetic corpus, measures,
  tears down — but that corpus is 4 maximally-distant topic clusters
  (consensus / coffee / index funds / houseplants). Every distractor is
  topically miles from the query, so precision@3 caps at 1.00 almost
  regardless of embedding/scoring quality — it's a "flattering upper bound"
  documented in its own header, and it can't discriminate between a config
  that helps and one that hurts.

This harness closes that gap: isolated (ephemeral Harper, spawned fresh per
run, killed + wiped after) **and** hard enough to discriminate (a corpus
with near-duplicate clusters, cross-cluster lexical traps, and varied
durability/recency — see `corpus.ts`'s header for the full design rationale).

### It reproduces a real, already-shipped finding

On 2026-07-08, `recall-eval.mjs` run against the **live** corpus found that
`scoring: "composite"` (then the default) was net-harmful to precision once
BM25 hybrid retrieval went live — Δp@3 (composite − raw) ran **-0.38 to
-0.50**. That shipped as commit `624299c` ("default SemanticSearch scoring to
raw, not composite", flair#623), which flipped the default and added one
hand-written unit-test pair (`test/unit/semantic-search-scoping.test.ts`)
pinning the mechanism with mocked Harper.

This harness reproduces the same finding **in isolation**, on a full
embeddings+BM25+RRF pipeline, across 30 queries and 87 records instead of one
mocked pair — see "Measured results" below. Going forward, it's the tool to
run *before* trusting the next scoring/retrieval/rerank config change,
instead of measuring against production again.

## Usage

Requires the repo to be **built** first — Harper loads compiled resources
from `dist/resources/*.js` (see `config.yaml`'s `jsResource.files`), not the
TypeScript source, so a fresh clone/worktree needs a build:

```bash
npm run build   # or: bun run build
```

Then, from the repo root:

```bash
# Full sweep: hybrid on AND off, 3 runs each (~10-15 min)
bun run test/bench/recall-harness/run.ts

# Quick single-run pass (faster, noisier — don't trust a lone run's delta)
bun run test/bench/recall-harness/run.ts --runs 1

# Only the production-default config (hybrid=true)
bun run test/bench/recall-harness/run.ts --hybrid on

# Also spawn one hybrid+rerank config (needs the rerank GGUF present — see below)
bun run test/bench/recall-harness/run.ts --hybrid on --rerank

# Print every query's rank, not just the aggregates
bun run test/bench/recall-harness/run.ts --verbose
```

### Skip re-downloading the embedding/rerank models

Every ephemeral Harper instance needs the embedding model (and, with
`--rerank`, the reranker GGUF). By default `test/helpers/harper-lifecycle.ts`
points `FLAIR_MODELS_DIR` at `<repo>/models`, which is empty in a fresh
worktree — set it to an **existing** Flair install's `models/` directory to
reuse the already-downloaded weights (read-only; the harness never writes
there):

```bash
export FLAIR_MODELS_DIR=/path/to/an/existing/flair/checkout/models
```

### Flags

| Flag              | Default | Meaning |
|-------------------|---------|---------|
| `--runs N`        | `3`     | Independent seed→measure→teardown cycles per config, aggregated as mean ± standard error. |
| `--hybrid on\|off\|both` | `both` | Which `FLAIR_HYBRID_RETRIEVAL` value(s) to spawn instances for. |
| `--rerank`        | off     | Additionally spawn one `hybrid=true, rerank=true` config. Opt-in — see "On the rerank knob" below. |
| `--prefixes on\|off\|both` | `both` | flair#504 Phase 2: which nomic search-prefix state(s) to spawn instances for. `on` = real `inputType='document'`/`'query'` on every `getEmbedding()` call site (the shipped Phase 2 code path); `off` = the harness-only `FLAIR_RECALL_HARNESS_NO_PREFIX` escape hatch (simulates Phase 1 against the SAME dist build — see `resources/embeddings-provider.ts`'s `harnessForceNoPrefix()`). |
| `--canary`        | off     | Run the mixed-space canary instead of the main sweep (see "MIXED-SPACE CANARY" in run.ts) — quantifies flair#504 Phase 2 stage-2 prod-re-embed transient-degradation risk in isolation. |
| `--verbose`       | off     | Print every query's rank (hit/miss, kind, marker) under `--runs`. |
| `--keep-on-fail`  | off     | On a fatal error, print a reminder to inspect (the ephemeral installDir itself is NOT preserved automatically — see caveat below). |

## Interpreting the output

For each `(hybrid, rerank)` config, the harness prints p@3 and MRR for
`scoring=raw` and `scoring=composite` against the **same seeded corpus** (no
reseed between the two — matches `recall-eval.mjs`'s own convention), then:

- **Δ (composite − raw)** — negative means composite underperforms raw on
  this corpus/config. This is the number that matters for "should X be the
  default."
- **by kind** — the same delta broken out by query kind (`stress` / `trap`
  / `hard` / `clean`, see `corpus.ts`). `stress` queries are the deliberate
  durability/recency adversarial pairs; a large negative delta there
  specifically (vs. a flat delta on `clean`) is the signature of the
  `compositeScore` durability-weight × recency-decay mechanism, not some
  other regression.
- **HEADLINE** — the `hybrid=true` (production-default) composite-vs-raw
  comparison, called out explicitly with a discriminates/does-not-discriminate
  verdict.

### If it does NOT discriminate

If a future run shows composite ≈ raw (no meaningful gap) on this corpus,
that's a real signal `compositeScore` changed (e.g. a relevance-gated
durability/recency multiplier, mirroring `retrievalBoost`'s existing
`RBOOST_RELEVANCE_FLOOR` in `resources/scoring.ts`) — re-validate against
`recall-eval.mjs` on the live corpus before reconsidering the default, per
that file's own header. It is NOT a sign this harness's corpus needs to be
made harder — see the numbers below; it already discriminates hard.

## Measured results (2026-07-08, isolated — zero production contact)

`--runs 3`, `FLAIR_HYBRID_RETRIEVAL` swept `true`/`false`, `--rerank` not
exercised (see caveat below). Real numbers from an ephemeral instance on this
corpus — not simulated, and reproducible by re-running the command above
(variance was ±0.000 across all 3 runs in both configs — this corpus's
collapse is not a fluke of one HNSW build):

```
── hybrid=true rerank=false ──
  scoring=raw       p@3=0.967 ± 0.000   MRR=0.892 ± 0.000
  scoring=composite p@3=0.067 ± 0.000   MRR=0.123 ± 0.000
  Δ (composite − raw)   p@3=-0.900   MRR=-0.769
  by kind (composite − raw p@3):
    stress raw=1.000  composite=0.000  Δ=-1.000
    trap   raw=1.000  composite=0.000  Δ=-1.000
    hard   raw=1.000  composite=0.333  Δ=-0.667
    clean  raw=0.929  composite=0.000  Δ=-0.929

── hybrid=false rerank=false ──
  scoring=raw       p@3=0.967 ± 0.000   MRR=0.892 ± 0.000
  scoring=composite p@3=0.067 ± 0.000   MRR=0.120 ± 0.000
  Δ (composite − raw)   p@3=-0.900   MRR=-0.772
  by kind (composite − raw p@3):
    stress raw=1.000  composite=0.000  Δ=-1.000
    trap   raw=1.000  composite=0.000  Δ=-1.000
    hard   raw=1.000  composite=0.167  Δ=-0.833
    clean  raw=0.929  composite=0.071  Δ=-0.857

HEADLINE (hybrid=true, the production default): composite p@3=0.067 vs raw
p@3=0.967; composite MRR=0.123 vs raw MRR=0.892 → corpus DISCRIMINATES,
reproducing flair#623 in isolation.
```

**raw is an excellent scorer on this corpus** (p@3=0.967 — only one query,
a `clean` RATE::1 case, misses top-3, landing rank 4) — the corpus is hard
enough to be meaningful but not so adversarial that a good scorer can't
still nearly ace it. **composite collapses almost everywhere**, not just on
the 7 deliberately-engineered `stress` pairs: `trap` and `clean` queries
(zero durability/recency adversarial design) crater just as hard.

**Why it's worse here than the live corpus's -0.38/-0.50**: inspecting the
actual top results (`_score`/`_rawScore`/durability/age per candidate)
confirms this is the real mechanism, not a harness artifact — for the query
"How does a cluster pick which single node gets to lead for a while?"
(expects `CONSENSUS::1`), raw correctly ranks `CONSENSUS::1` #2 (a
`CONSENSUS::4` rank-1/rank-2 near-tie, both genuinely on-topic). Under
composite, the top 4 results are **`CONSENSUS::8`, `DEPLOY::2`, `FIN::4`,
`PLANT::3`** — four totally unrelated-cluster records that all happen to
share `durability: permanent, ageDays: 2` — before either real consensus
record appears at all. Each carries `dWeight=1.0 × rFactor=1.0` (no
discount), while the correct, standard/persistent-durability, 65-95-day-old
answers get discounted 30-95% by `compositeScore`'s **unconditional**
multiplier (no relevance floor, unlike `retrievalBoost`'s
`RBOOST_RELEVANCE_FLOOR`). This corpus deliberately spreads durability/age
across nearly every record (not just 7 hand-paired queries), and the
Q4/Q8-nomic embedding's known weak tail separation (already flagged
elsewhere as flair's #2 moat risk) is enough that even a topically-unrelated
record clears the semantic-candidate bar — so **any** `permanent`/fresh
record in the corpus acts as a magnet across many queries, not only its
"intended" one. That's a broader, more systemic characterization of
flair#623's root cause than the single-pair unit test shows, and it holds
**identically under `hybrid=false`** (the legacy path) — so the effect is
not specific to BM25/RRF score-banding as the commit's narrative framed it;
it's `compositeScore`'s unconditional multiplier, full stop.

## Phase 2 prefix A/B — measured results (2026-07-11, isolated)

`--runs 3 --hybrid both --prefixes both`, scoring=raw (the production
default; `PHASE1_BASELINE` in run.ts was measured under this same config).
Variance was ±0.000 across all 3 runs in every arm — deterministic on this
corpus/HNSW-build, not a fluke of one run:

```
── hybrid=true ──
  prefixes=off (Phase 1 sim)  p@3=0.967 ± 0.000   MRR=0.892 ± 0.000
  prefixes=on  (Phase 2)      p@3=0.933 ± 0.000   MRR=0.856 ± 0.000
  Δ (on − off)   p@3=-0.033   MRR=-0.036
  by kind (on − off, MRR): stress=+0.000  trap=-0.167  hard=-0.097  clean=+0.000

── hybrid=false ──
  prefixes=off (Phase 1 sim)  p@3=0.967 ± 0.000   MRR=0.892 ± 0.000
  prefixes=on  (Phase 2)      p@3=0.933 ± 0.000   MRR=0.856 ± 0.000
  Δ (on − off)   p@3=-0.033   MRR=-0.036
  by kind (on − off, MRR): stress=+0.000  trap=-0.167  hard=-0.097  clean=+0.000
```

**Prefixes REGRESS on this corpus, in both hybrid modes** — this contradicts
the design hypothesis (prefixes ≥ baseline) and fails the stage-1 merge gate
as originally written (flair#504 spec, checklist item 6: "harness shows a
bump, or at minimum no regression"). The `off` arm reproduces the frozen
`PHASE1_BASELINE` (p@3=0.967/MRR=0.892) exactly, confirming the harness-only
no-prefix escape hatch is faithful — this is a real measured effect of
`inputType`, not a harness artifact.

The regression concentrates in `trap` (queries engineered to share strong
surface vocabulary with a same-corpus decoy cluster — MRR Δ=-0.167, the
single largest hit) and `hard` (near-duplicate-cluster disambiguation, Δ=
-0.097); `stress` (durability/recency) and `clean` (unambiguous) are exactly
flat. One plausible read: nomic's `search_document`/`search_query` prefixes
are trained to improve topical/semantic alignment on large, heterogeneous
corpora, but this harness's `trap`/`hard` categories are deliberately
adversarial on fine *lexical* grounds within a small (87-record), densely
hand-crafted corpus — a regime the prefix training wasn't optimized for and
may not generalize to. That's a hypothesis, not a conclusion: the spec's own
validation tiers include a **live gate** (`recall-eval.mjs` against the real,
large, diverse production corpus) specifically because an isolated
synthetic-corpus result — in either direction — isn't the final word. See
the PR for flair#504 Phase 2 for how this was resolved.

**Mixed-space canary** (`--canary`, hybrid=true, scoring=raw; 44 records
seeded unprefixed then 43 more seeded prefixed after a same-installDir
Harper restart, queries always `'query'`-prefixed — simulates a stage-2
prod re-embed mid-pass):

```
MIXED-SPACE   p@3=0.967   MRR=0.842
  by kind: stress MRR=0.738 (n=7)  trap MRR=0.833 (n=3)  hard MRR=0.833 (n=6)  clean MRR=0.899 (n=14)
```

vs. this session's fully-consistent `prefixes=on hybrid=true`
(p@3=0.933/MRR=0.856) and fully-consistent `prefixes=off`
(p@3=0.967/MRR=0.892, = frozen baseline): the mixed state's p@3 matches the
unprefixed baseline (top-3 hit-rate holds), but MRR is the WORST of all
three conditions (0.842) — ranking quality *within* the top-3 degrades
during the transition window even though the record usually still clears
top-3. Quantifies the stage-2 transient risk at roughly -0.05 MRR
(mixed vs. fully-consistent-off) — bounded to the pass's wall-clock and
self-healing once it completes, consistent with the spec's prediction.

## Caveats

- **retrievalCount drift within a run**: `SemanticSearch` bumps
  `retrievalCount` on every returned doc regardless of `scoring`. Since raw
  is measured first and composite second against the same seeded instance,
  composite's `retrievalBoost` is very slightly influenced by docs the raw
  pass already surfaced. Bounded to +10% (`RBOOST_CAP`) and gated on
  `RBOOST_RELEVANCE_FLOOR` — small next to the durability/recency effect this
  harness targets, and it's the same convention `recall-eval.mjs` already
  uses (see that file's own header caveat).
- **HNSW/embedding run-to-run noise**: a single run can wobble; that's why
  the default is `--runs 3` and results are reported as mean ± SE, mirroring
  `recall-bench.mjs`'s convention.
- **The rerank knob is implemented but not the main validation target.**
  `--rerank` spawns one additional `hybrid=true, rerank=true` config using
  `FLAIR_RERANK_ENABLED=true`. It needs the actual reranker GGUF
  (`Qwen3-Reranker-0.6B-q8_0.gguf` by default) reachable via
  `FLAIR_MODELS_DIR`; if the model is missing, `rerankCandidates()` fails
  open (returns candidates unchanged — see `resources/rerank-provider.ts`)
  and the run silently measures the *non-reranked* config instead of
  erroring. It's slower (generative token-probability scoring per candidate)
  and not this PR's ask (the ask was specifically the composite-vs-raw
  discrimination under hybrid) — treat it as an available lever for whoever
  next needs to validate a reranker change, not a number this PR reports.
- **`--keep-on-fail`** only prints a reminder; it does not currently change
  `stopHarper`'s cleanup behavior. If you need to inspect a failed run's
  Harper installDir, comment out the `stopHarper` call in `runOnce()`
  temporarily — left as a manual step rather than adding an
  installDir-leaking code path that's easy to forget to remove.

## Files

- `corpus.ts` — the 87-record synthetic corpus + 30 ground-truth queries.
  Read its header first; it documents exactly how relevance was assigned and
  why each "stress"/"trap"/"hard" pair exists.
- `run.ts` — the harness: spawns ephemeral Harper via
  `test/helpers/harper-lifecycle.ts`, seeds the corpus via signed
  `TPS-Ed25519` requests (same pattern as
  `test/integration/bm25-hybrid-noquery-listing.test.ts`), measures, tears
  down, aggregates.

Neither file is swept into CI (`bun test test/unit/`,
`test/integration/`, etc. — see `.github/workflows/*.yml` — only ever glob
those specific directories, never `test/bench/`). This is a manually-invoked
benchmark, not a gating test.
