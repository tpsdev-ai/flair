# recall-harness — isolated recall-eval harness

Measures Flair's recall precision (p@3, MRR) against a **harder, representative
synthetic corpus**, on a **fully ephemeral Harper instance**. It never touches
any live checkout, the live `:9926` service, or any production memory.

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
| `--prefixes on\|off\|both` | `both` | flair#504 Phase 2 (**FLIPPED ON** — see "The gate, the flip decision, and BASELINE.json" below): which nomic search-prefix state(s) to spawn instances for. `on` = the real, unmodified shipped default (`EMBEDDING_PREFIXES_ENABLED = true` in `resources/embeddings-provider.ts` — no hatch needed, this IS production behavior); `off` = the harness-only `FLAIR_RECALL_HARNESS_FORCE_PREFIX` escape hatch (set to the literal string `"false"`), which force-disables the SAME gate against the SAME dist build (see `resources/embeddings-provider.ts`'s `harnessPrefixOverride()`) — this is how the harness keeps measuring the comparison arm even though production never exercises it. The hatch is bidirectional (reads `"true"`/`"false"`, not just presence), so it stays correct if the gate's default ever flips again. |
| `--canary`        | off     | Run the mixed-space canary instead of the main sweep (see "MIXED-SPACE CANARY" in run.ts) — quantifies flair#504 Phase 2 stage-2 prod-re-embed transient-degradation risk in isolation. |
| `--verbose`       | off     | Print every query's rank (hit/miss, kind, marker) under `--runs`. |
| `--keep-on-fail`  | off     | On a fatal error, print a reminder to inspect (the ephemeral installDir itself is NOT preserved automatically — see caveat below). |
| `--corpus v1\|v2` | `v1`    | Which eval instrument to run against — see "Eval instrument v2" below. `v1` (`corpus.ts`) is the default so a bare invocation with no flag reproduces every number already published in this file, byte-for-byte, forever. `v2` (`corpus-v2.ts`) is the larger, harder standing gate for future embedding/scoring changes. |

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

**History — this section and the "v2 measured results" section below record
the v1/v2 measurements that led to PR #689's original park decision.** THE
GATE has since flipped ON (see "The gate, the flip decision, and
BASELINE.json" further down for the current state, the post-flip
re-baseline, and why the flip happened on strategic grounds despite this
section's own numbers never showing a real win). Left here verbatim as
history — the numbers below are real and reproducible, just no longer the
current gate state.

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

**Resolved, twice (PR #689, then this PR):** the v2 A/B below reproduced this
same small delta at 4× the query count, and PR #689's K&S review ratified
parking the flip on it. This PR (see "The gate, the flip decision, and
BASELINE.json" further down) revisits that decision and flips
`EMBEDDING_PREFIXES_ENABLED` to `true` — the delta itself never changed, only
the read of what it means (noise-scale, not a real regression) and the
strategic case for shipping anyway. This section's numbers and the
`FLAIR_RECALL_HARNESS_NO_PREFIX` hatch they were originally measured with are
preserved here as history — the harness's current mechanism is the
bidirectional `FLAIR_RECALL_HARNESS_FORCE_PREFIX` (see "Flags" above), which
now force-disables prefixes (the `off` comparison arm) rather than
force-enabling them, matching the gate's new on-by-default shape.

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

## Eval instrument v2

### Why v2 exists

The Phase 2 prefix A/B above (measured on v1, `corpus.ts`) found a small
regression — p@3 0.967→0.933, MRR 0.892→0.856 — but at v1's N=30 queries that
is **1-2 queries shifting rank**, not enough for the instrument to tell
"ship" from "park" apart from ordinary run-to-run noise. v2 exists to have
enough queries per "kind" (see `QueryKind` in `corpus-v2.ts`) that a
kind-level delta is a real signal. **v2 does not replace v1** — `corpus.ts`
is never modified by this change, so every number already published in this
file above stays reproducible verbatim forever (`--corpus v1`, the default).
v2 is additive, and becomes **the standing gate for future
embedding/scoring changes** — run it (not just v1) before trusting the next
prefix/hybrid/rerank/scoring config change.

### Size and design

`corpus-v2.ts` (see its own header for the full rationale):

- **251 records across 30 topic clusters** (6-10 records/cluster), spanning
  genuinely different domains: distributed systems, medical scheduling,
  logistics, cooking, astronomy, legal contracts, fitness, team process,
  home renovation, marine biology, typography, database internals, finance
  operations, git workflow, horticulture, music production, sports
  analytics, cloud infrastructure, winemaking, ornithology, carpentry,
  meteorology, chess, photography, aviation, insurance, archaeology,
  perfumery, ceramics, linguistics.
- **126 ground-truth queries**: 17 stress, 34 trap, 46 hard, 29 clean.
  (The spec this instrument was built against gave individual per-kind
  ceilings — stress≤15, trap≤30, hard≤40, clean≤25 — that sum to at most
  110, ten short of the spec's own 120 total floor. Every kind was scaled up
  modestly and roughly proportionally to close that gap rather than either
  breaching the 120 floor or concentrating the extra 16 queries into a
  single kind — see the "Deviations" note in `corpus-v2.ts` and the
  flair#504 checkpoint-2 PR description for the full reasoning.)
- **17 stress pairs** (one per stress-tagged cluster) — same durability/
  recency composite-vs-raw discriminator design as v1's 7 pairs, just more
  of them.
- **3 genuine cross-cluster lexical trap pairs**, each with real, prominent
  token overlap on a pivotal ambiguous term (not shoehorned in — see
  `corpus-v2.ts`'s header for the "used naturally and prominently" bar):
  - `DBSTORE` (database internals) ↔ `FINOPS` (finance operations) — **"transaction"**
  - `GITWF` (git branching workflows) ↔ `HORTIC` (horticulture) — **"branch"**
  - `MUSICPROD` (music production) ↔ `SPORTAN` (sports analytics) — **"score"**

  34 trap queries total (12 + 11 + 11 across the three pairs), split roughly
  evenly between "answer is in cluster A, phrased with cluster B's sense of
  the shared term nearby" and the reverse.
- **46 hard queries** — genuine same-cluster near-duplicate disambiguation,
  2 per cluster in 16 of the 30 clusters and 1 per cluster in the other 14.
- **29 clean queries** — unambiguous single-best-answer sanity floor, one
  per cluster in 29 of the 30 clusters.

### Validating the instrument itself

Before trusting any measurement off `corpus-v2.ts`, its own internal
invariants are checked by a validation script (kind counts hit target, every
`expectMarker` resolves to a real record, no duplicate record markers, no
record reused as an answer more than ~2× within the same kind, and — the
one that actually proves the traps are real — every trap query's shared
term appears in its own answer record AND in at least 2 records of the
paired trap cluster). This is a one-off check, not part of the harness
itself; if you're extending `corpus-v2.ts`, re-derive an equivalent check
before trusting a new trap pair or a large batch of new queries.

### Running v2

```bash
# Full v2 sweep — same shape as the v1 sweep above, just pass --corpus v2
bun run test/bench/recall-harness/run.ts --corpus v2 --runs 3 --hybrid both --prefixes both

# Single config, quick pass
bun run test/bench/recall-harness/run.ts --corpus v2 --runs 1 --hybrid on --prefixes on

# Mixed-space canary on v2
bun run test/bench/recall-harness/run.ts --corpus v2 --canary
```

v2's corpus is ~3× v1's size, so `SEARCH_LIMIT` (the `limit` sent to
`/SemanticSearch`, which controls candidate-pool coverage — see run.ts's
comment above its definition) scales up automatically for `--corpus v2`
only; `--corpus v1`'s `SEARCH_LIMIT` is left at exactly its original value
of `20` so v1 numbers stay byte-identical to every previous measurement.

### Per-cluster reporting

Both the composite-vs-raw report and the PREFIX A/B report now also print a
**per-cluster MRR movers** section (gained / lost, sorted by |Δ|, capped to
the top 5 each way) alongside the existing per-kind breakdown — necessary at
v2's 30 clusters where dumping every cluster's numbers on every run would
bury the signal. This works for both `--corpus v1` (12 clusters) and
`--corpus v2` (30 clusters) since both corpora tag every record with a
`cluster` field.

### v2 measured results (2026-07-11, isolated — zero production contact)

`--corpus v2 --runs 3 --hybrid both --prefixes both`, scoring=raw for the
prefix A/B (the production default). Variance was ±0.000 across all 3 runs
in every arm — deterministic on this corpus, matching v1's behavior. The
v1 baseline reproduction ran first in the same session (1 run, `--corpus
v1`, hybrid=true, prefixes=off) and reproduced the frozen v1 baseline
exactly: raw p@3=0.967 / MRR=0.892.

```
── PREFIX A/B, hybrid=true (identical numbers under hybrid=false) ──
  prefixes=off (Phase 1 sim)  p@3=0.992 ± 0.000   MRR=0.949 ± 0.000
  prefixes=on  (Phase 2)      p@3=0.976 ± 0.000   MRR=0.946 ± 0.000
  Δ (on − off)   p@3=-0.016   MRR=-0.003
  by kind (on − off, MRR):
    stress (n=17) off=0.971  on=0.961  Δ=-0.010
    trap   (n=34) off=0.943  on=0.930  Δ=-0.013
    hard   (n=46) off=0.924  on=0.946  Δ=+0.022
    clean  (n=29) off=0.983  on=0.957  Δ=-0.026
  per-cluster MRR movers (on − off, 23 of 30 clusters flat):
    gained: CERAMICS +0.250, PERFUMERY +0.250, FINOPS +0.017
    lost:   WINEMAKING -0.375, AVIATION -0.250, MUSICPROD -0.017, GITWF -0.010
```

**Reading at v2's N=126**: the prefix regression v1 flagged (Δp@3 -0.033 at
N=30 = 1 query) is still present but SMALLER at v2 scale — Δp@3 -0.016 is
exactly 2 of 126 queries dropping out of top-3, and ΔMRR -0.003 is near
zero. The per-kind story v1 told (traps hit hardest, -0.167 MRR) does NOT
replicate at v2 N: trap Δ is only -0.013 (n=34), while `hard` — v2's
largest kind (n=46) — actually IMPROVES +0.022 under prefixes. The
regression that remains concentrates in a handful of specific clusters
(WINEMAKING, AVIATION) rather than in a query kind, and is exactly offset
by equal-sized gains in others (CERAMICS, PERFUMERY) — consistent with
prefixes perturbing near-tie rankings in both directions rather than
systematically degrading a retrieval capability. hybrid=true and
hybrid=false produce byte-identical prefix deltas, same as v1.

**Composite-vs-raw on v2** (context — measured in the same sweep): with the
relevance-gated `compositeScore` now on main (#662) plus usageBoost (#683),
composite is nearly flat vs raw on v2 (worst config Δp@3 -0.008 / ΔMRR
-0.013 at hybrid=true+prefixes=on, driven by SPORTAN/HORTIC stress pairs) —
the v1-era collapse documented above predates the relevance gate and is
preserved there as history, not as the current state.

**Mixed-space canary on v2** (`--corpus v2 --canary`, hybrid=true,
scoring=raw; 126 records seeded unprefixed, then 125 seeded prefixed after
a same-installDir restart):

```
MIXED-SPACE   p@3=0.984   MRR=0.954
  by kind: stress p@3=0.941 MRR=0.956 (n=17)   trap p@3=0.971 MRR=0.954 (n=34)
           hard  p@3=1.000 MRR=0.946 (n=46)   clean p@3=1.000 MRR=0.966 (n=29)
```

The mixed state lands BETWEEN the two consistent endpoints (off
0.992/0.949, on 0.976/0.946) on p@3 and marginally above both on MRR — at
v2 scale the stage-2 re-embed transition window shows **no degradation
below either endpoint**, tightening v1's earlier estimate (v1's canary had
MRR dip 0.05 below the off-arm; at 4× the query count that dip does not
reproduce).

## The gate, the flip decision, and BASELINE.json

**History (PR #689):** the v2 A/B above (N=126, the largest and most
reliable measurement this harness had produced at the time) is what decided
flair#504 Phase 2's original outcome: prefixes=off p@3=0.992/MRR=0.949 vs
prefixes=on p@3=0.976/MRR=0.946, Δ −0.016/−0.003 — small, reproducible
(±0.000 variance across 3 runs), and the design hypothesis had been that
prefixes would *help*, not merely "not hurt." K&S reviewed this evidence and
ratified parking the flip rather than shipping it.

**This PR flips it.** Read plainly, that Δ −0.016 p@3 / −0.003 MRR at N=126
is 2 of 126 queries moving rank — noise-scale for this instrument, not a
directional regression in either direction. The recall measurement alone was
a wash either way, so this PR flips `EMBEDDING_PREFIXES_ENABLED` to `true` on
strategic grounds instead: nomic-embed-text-v1.5 is trained expecting these
prefixes (running it unprefixed indefinitely is the actual departure from
convention), and the flip is the first real payload for the boot-keyed
auto-migration machinery (flair#690, flair#695) — exercising the
detect-stale/re-embed path now, on a change with a proven noise-scale recall
floor, is lower-risk than letting that machinery sit unexercised until some
future higher-stakes change needs it first, and avoids two unrelated
stamp-bumping changes compounding into one migration debt pile. See the PR
description for the full context.

`resources/embeddings-provider.ts` still has a single module-level constant,
`EMBEDDING_PREFIXES_ENABLED`, that atomically gates BOTH `inputType`
forwarding to `models.embed()` and the `+searchprefix` suffix `getModelId()`
stamps — the two can never diverge, enforced at that one chokepoint (see the
constant's own doc for why a stamp/behavior mismatch would silently corrupt
dedup and stale-detection). It now defaults `true`. `src/cli.ts`'s
`--stale-only` duplicates the same gate-then-suffix logic (separate build
target) and must be kept in sync manually — see its own comment.

The `--prefixes on\|off\|both` flag documented above still measures both
arms: `on` needs no hatch (it's simply the real default now), `off` uses the
bench-only `FLAIR_RECALL_HARNESS_FORCE_PREFIX` escape hatch (bidirectional —
reads `"true"`/`"false"`, not just presence) to force-disable the same gate
against the same dist build — so this harness stays able to validate the
comparison arm without a second build config, in whichever direction the
gate defaults.

### Post-flip re-baseline (measured on this PR's build, isolated)

`--corpus v2 --runs 3 --hybrid both --prefixes both`, scoring=raw for the
prefix A/B (the production default). Variance was ±0.000 across all 3 runs
in every arm — deterministic, same as every prior measurement in this file.
Both hybrid modes produced byte-identical prefix deltas, same as every prior
sweep:

```
── PREFIX A/B, hybrid=true (identical numbers under hybrid=false) ──
  prefixes=off (comparison, via force-off hatch)  p@3=0.992 ± 0.000   MRR=0.949 ± 0.000
  prefixes=on  (shipped default)                  p@3=0.976 ± 0.000   MRR=0.946 ± 0.000
  Δ (on − off)   p@3=-0.016   MRR=-0.003
  by kind (on − off, MRR):
    stress (n=17) off=0.971  on=0.961  Δ=-0.010
    trap   (n=34) off=0.943  on=0.930  Δ=-0.013
    hard   (n=46) off=0.924  on=0.946  Δ=+0.022
    clean  (n=29) off=0.983  on=0.957  Δ=-0.026
  per-cluster MRR movers (on − off, 23 of 30 clusters flat):
    gained: CERAMICS +0.250, PERFUMERY +0.250, FINOPS +0.017
    lost:   WINEMAKING -0.375, AVIATION -0.250, MUSICPROD -0.017, GITWF -0.010
```

These numbers reproduce PR #689's original v2 A/B byte-for-byte (same Δ,
same per-kind breakdown, same per-cluster movers) — expected and reassuring,
not a coincidence: this flip changes which arm the production code path
takes by default, not the embedding math either arm computes. The decision
to flip rests on the strategic case in "This PR flips it" above, not on a
changed recall number — there isn't one.

`BASELINE.json` (in this directory) now freezes the production-config
numbers — `corpus=v2, hybrid=true, prefixes=true, scoring=raw` — as the
reference point a future CI ratchet gates on. It carries an explicit
`config` block so a mismatched invocation (wrong corpus version, wrong
hybrid/prefix/scoring combination) fails loudly instead of silently
comparing against the wrong arm. Flipping `EMBEDDING_PREFIXES_ENABLED` back
to `false` in the future requires the same process in reverse: a fresh,
re-baselined A/B through that ratchet showing staying on is actively worse,
not just unproven — not a unilateral code change.

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

- `corpus.ts` — eval instrument v1: the 87-record synthetic corpus + 30
  ground-truth queries. Read its header first; it documents exactly how
  relevance was assigned and why each "stress"/"trap"/"hard" pair exists.
  Frozen — never modified by the v2 work, so every number in this file
  published against it stays reproducible verbatim.
- `corpus-v2.ts` — eval instrument v2: the 251-record, 126-query standing
  gate for future embedding/scoring changes (see "Eval instrument v2"
  above). Same `CorpusRecord`/`GroundTruthQuery` shapes as v1, selected via
  `run.ts --corpus v2`.
- `run.ts` — the harness: spawns ephemeral Harper via
  `test/helpers/harper-lifecycle.ts`, seeds the selected corpus (`--corpus
  v1|v2`, default `v1`) via signed `TPS-Ed25519` requests (same pattern as
  `test/integration/bm25-hybrid-noquery-listing.test.ts`), measures, tears
  down, aggregates — including the per-kind and per-cluster breakdowns.

None of these files are swept into CI (`bun test test/unit/`,
`test/integration/`, etc. — see `.github/workflows/*.yml` — only ever glob
those specific directories, never `test/bench/`). This is a manually-invoked
benchmark, not a gating test.
