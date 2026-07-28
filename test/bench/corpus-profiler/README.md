# corpus-profiler — measure what makes retrieval hard, without moving the text

Stage 1a of the recall-instrument work (flair#893). It reads a **real** memory
corpus and emits **only distributions**: counts, quantiles, histograms, moments
and fitted parameters. No memory text, no query text, no identifier that maps
back to a record.

A later stage generates a synthetic corpus matching these distributions. The
generated text is content-free; the difficulty is real because the *structure*
is real.

## Why this shape, and not "redact and commit"

`corpus-v2` scores **p@3 0.976**. That is close enough to ceiling that a real
improvement and no improvement read identically — which is exactly what
happened when the cross-encoder reranker measured **Δp@3 0.000** across 126
queries. The honest reading of that zero is "the instrument cannot see", not
"the feature does nothing". So the eval corpus has to match the difficulty of
real memories.

Real memories cannot leave the host, and **redaction is not a viable control**.
Architecture and security review reached that independently and in nearly the
same words: it is a *negative* constraint ("remove all secrets") and negative
constraints are unbounded — you can never prove you finished. The things that
leak are not secret in **form**: a project codename, an internal hostname
pattern, a person's name in an unusual context, a timestamp that correlates
with a calendar entry. No regex or NER pass catches those, and redaction
composes badly — a redacted note next to an unredacted one tells you what was
removed.

So the constraint is inverted into a positive one that can actually be checked:
**the output is numbers.** Anything that is not a number is a failure, and
`guard.ts` decides that mechanically rather than by review attention.

## Files

| File | What it is |
|---|---|
| `compute.ts` | The measurement. Pure, Harper-free, network-free: records in, numbers out. |
| `guard.ts` | The privacy guard. Numeric-only assertion plus a closed `meta` allowlist. |
| `fetch.ts` | Read-only enumeration of a live instance over TPS-Ed25519. |
| `profile.ts` | CLI: fetch a live corpus → compute → guard → write. |
| `profile-bench-corpus.ts` | CLI: embed + profile the synthetic `corpus-v1`/`v2` through the **same** instrument, so the live numbers have a referent. |
| `profiles/*.json` | Committed outputs. Every one is re-validated by the guard test. |

The guard test is **`test/unit/corpus-profile-privacy-guard.test.ts`**, not a
file in this directory. CI runs `bun test test/unit/` and does not sweep
`test/bench/`; a privacy guard that only runs when someone remembers to run it
is the same failure shape as a benchmark nobody runs. It is hermetic — no
network, no Harper, no live instance — so it belongs in that job.

## Usage

### Against a live instance (read-only)

```bash
bun run test/bench/corpus-profiler/profile.ts --out profiles/live-<label>.json
```

| Flag | Default | Meaning |
|---|---|---|
| `--url <base>` | `http://127.0.0.1:9926` | Live instance base URL. |
| `--agent-id <id>` | `$FLAIR_AGENT_ID` or `flint` | Signing identity. |
| `--key <path>` | `~/.tps/secrets/flair/<agent-id>-priv.key` | PKCS#8 Ed25519 key. |
| `--owner <agentId>` | unset | Restrict to one owner. Unset = the signing agent's whole read scope. |
| `--include-archived` | off | Profile all rows rather than only retrievable ones. |
| `--clusters <k>` | `round(sqrt(n/2))` clamped to `[4,64]` | k for k-means. |
| `--seed <n>` | `20260728` | PRNG seed. Profiles reproduce exactly from the same snapshot. |
| `--out <path>` | stdout | Where to write. |

Two things it deliberately does **not** do:

- **It never calls `POST /SemanticSearch`.** That endpoint bumps
  `retrievalCount`/`lastRetrieved` on every record it returns, so enumerating a
  corpus through it would write to every row and pollute a live ranking signal
  — the profiler would be changing the corpus in the act of measuring it. It
  issues one `GET /Memory/` instead, which has no side effect.
- **It never re-embeds.** Vectors are read as stored (`Memory.embedding`). A
  profile computed with a different embedding model measures a different space,
  and the point is that the geometry corresponds to production retrieval.
  `meta.embeddingSource` records which path ran.

### Archived records are excluded by default

Production `SemanticSearch` pushes `archived != true`, so archived rows are
unreachable by any query. Profiling them by default would describe a corpus
retrieval never sees — and because archived rows are frequently
supersedes-chain predecessors (near-duplicates of the row that replaced them),
including them would **inflate** near-duplicate density with pairs no query can
ever confuse. `meta.scope` records which corpus was measured either way.

### Against the synthetic bench corpora

```bash
bun run test/bench/corpus-profiler/profile-bench-corpus.ts --corpus v2 \
  --models-dir /path/to/an/existing/flair/checkout/models \
  --addon-path /path/to/@node-llama-cpp/<platform>/bins/<platform>/llama-addon.node \
  --sample-size 251 \
  --out test/bench/corpus-profiler/profiles/corpus-v2.json
```

Embeds with the same model, the same `mean` pooling and the same
`inputType: 'document'` prefixing production uses, so the two profiles are
directly comparable. `--models-dir` follows the recall harness's
`FLAIR_MODELS_DIR` convention (point at an existing install, read-only, to skip
a download); `--addon-path` is needed because the `@node-llama-cpp` platform
package is an optional dependency and is often absent in a fresh worktree.

Use `--sample-size` to match record counts before comparing. Nearest-neighbour
similarity rises with `n` purely because there are more candidates to be close
to, so an unmatched comparison credits the larger corpus with difficulty that is
really just size.

## Output schema

`schemaVersion: 1`. Every field below is a finite number or an array of finite
numbers, except `meta`, which is a closed enum. The **privacy rationale** column
says why each field cannot be inverted back to a record.

### `meta` — the only strings in the document

Enumerated in `guard.ts`'s `META_ALLOWLIST`. Widening it requires editing that
file, which means review. A gate that can be widened silently is not a gate.

| Field | Values | Privacy rationale |
|---|---|---|
| `embeddingSource` | `stored` \| `computed` | Provenance of the vectors, not of the content. |
| `embeddingModel` | closed set of public model ids | A published model identifier. Enumerated anyway so a space change cannot pass unnoticed — a profile from a different space is not comparable to the committed ones. |
| `tokenizer` | `flair-bm25` | Names `resources/bm25.ts`'s own `tokenize()`, so the vocabulary numbers correspond to the retrieval path rather than to an approximation of it. |
| `clusterAlgorithm` | `kmeans++-seeded` | Algorithm name. |
| `pairwiseMode` | `exhaustive` \| `sampled` | Which statistic was computed. Only `exhaustive` is currently produced — see "Refusals". |
| `scope` | `retrievable` \| `all-records` | Which corpus was measured. |
| `firstMonth`, `lastMonth`, `profiledMonth` | `YYYY-MM` | **Month granularity is the finest allowed.** A day-level stamp correlates with calendar entries; a month does not. Enforced by an anchored pattern, not by convention. |

### `scale` — how big, how long, how spread over time

| Field | Privacy rationale |
|---|---|
| `recordCount` | A count. Every fraction in this document is relative to it. |
| `distinctAgentCount` | A count of writers. No identity. |
| `recordsPerAgentSorted` | Descending counts with the identities dropped. Order carries no mapping back to an agent. |
| `distinctEmbeddingModelCount` | A count. `> 1` means mixed spaces — see "Refusals". |
| `recordsPerMonth` | Contiguous monthly series, `firstMonth` → `lastMonth`, gaps filled with 0. An activity volume curve at the granularity explicitly permitted. |
| `durabilityCounts` | Counts in the **fixed order** `[permanent, persistent, standard, ephemeral, other]`. Emitting the order as data would mean emitting labels, so it lives here and in `DURABILITY_ORDER`. Unrecognised values fall into `other` rather than being echoed. |
| `contentChars`, `contentTokens` | Length quantiles. Lengths do not reconstruct text. |
| `tagsPerRecord`, `distinctTagCount` | How many tags, never which. A tag name is exactly the kind of internal codename that redaction misses. |

### `nearDuplicate` — the load-bearing section

This is what makes a corpus confusable, and the reason the whole profile exists.

| Field | Privacy rationale |
|---|---|
| `nearestNeighborCosine` | Quantiles of each record's cosine to its single nearest other record. A similarity value identifies neither endpoint. |
| `nearestNeighborCosineHistogram` | Bucket **counts**. A bucket is safe; a bucket labelled with what it counts would not be. |
| `thresholds`, `fractionWithNeighborAbove` | Parallel numeric arrays. The fraction of the corpus with a neighbour at or above each cosine threshold. |
| `componentThreshold`, `componentSizes`, `recordsInComponents` | Connected components of the graph of pairs at or above the top threshold, as descending **sizes**. Says how many tight duplicate groups exist and how large, never which records or what they are about. |
| `nearestNeighborJaccard` | Lexical overlap (BM25 token sets) between each record and its embedding-nearest neighbour. A ratio of set sizes; the sets themselves never leave `compute.ts`. This is the number that says whether BM25 and the vector leg agree — half the hybrid pipeline. |

### `clusters` — is the corpus topically separable

| Field | Privacy rationale |
|---|---|
| `k`, `sizesSorted` | Cluster count and descending sizes. **No cluster is described**, only sized. What a cluster is *about* is exactly what must not be emitted. |
| `intraClusterCosine`, `interClusterCosine` | Within- vs across-cluster similarity distributions. Aggregate over hundreds of thousands of pairs. |
| `intraClusterCosineHistogram`, `interClusterCosineHistogram` | Bucket counts. |
| `silhouette` | Exact silhouette over cosine distance, per record, reported as a distribution. Near 0 = clusters barely separated. |

### `geometry` — the shape of the embedding space itself

| Field | Privacy rationale |
|---|---|
| `dimension`, `pairsEvaluated` | Scalars describing the computation. |
| `pairwiseCosine`, `pairwiseCosineHistogram` | Distribution over **every** pair, not a sample. Aggregate by construction. |
| `storedVectorNorm` | L2 norms of the stored vectors before normalisation. Confirms whether the pipeline stores unit vectors. |
| `centroidNorm` | Norm of the mean unit vector — anisotropy. Near 1 means every vector points roughly the same way, which compresses the cosine range and makes retrieval harder for reasons that have nothing to do with content. One scalar over the whole corpus. |
| `participationRatio` | `trace(C)² / ‖C‖_F²` — effective dimensionality. **Exact, no truncation**: for symmetric `C`, `Σλ = trace(C)` and `Σλ² = ‖C‖_F²`, so it needs no spectrum. |
| `varianceExplainedAtK`, `varianceExplainedCumulative` | Cumulative variance from the top principal components. Eigenvalues of a covariance matrix are aggregate second moments; recovering a record from them is not a thing you can do. |
| `varianceFractions`, `dimensionsForVarianceFraction` | Components needed to reach each fraction. **`0` means "not reached within the computed spectrum"**, not "zero components" — the spectrum is truncated at `spectrumComponentsComputed`. |
| `spectrumComponentsComputed` | How many eigenvalues were actually computed, so a `0` above can be read correctly. |

### `vocabulary` — Zipf shape without the terms

This is where the invariant is easiest to violate, so it is worth naming: we
want the term-frequency **shape** (is this corpus Zipfian, how heavy is the
tail) without the terms.

| Field | Privacy rationale |
|---|---|
| `tokenCount`, `typeCount`, `typeTokenRatio`, `hapaxFraction` | Counts and ratios over the vocabulary. |
| `zipfSlope`, `zipfIntercept`, `zipfR2` | Least-squares fit of `log10(freq)` on `log10(rank)`. Fitted parameters of a curve. |
| `zipfSampleRanks`, `zipfSampleFrequencies` | Frequencies **sorted by rank**, sampled log-spaced. Parallel numeric arrays. **Never a rank → term mapping** — that is the specific bad idea this schema most invites, and it is what the guard test's substring check exists to catch. |
| `typesPerRecord` | Distinct types per record, as a distribution. |
| `documentFrequency` | Document frequency of each type, as a distribution **over types** — the values are df counts with the terms dropped, so the highest-df bucket says "some term appears in 830 documents" and nothing about which. |

## Refusals

The profiler stops rather than emitting a number that looks fine:

- **More than one embedding model in the corpus.** Cosines across different
  embedding spaces are arithmetic without meaning; the near-duplicate fraction
  would be an artefact of the mix. Override with
  `allowMixedEmbeddingSpaces` only alongside a stated caveat.
- **Non-uniform embedding dimension.** Same reason.
- **More records than `maxExhaustiveRecords`** (default 12000). This is a
  refusal rather than a fallback to sampling **on purpose**: near-duplicate
  density is the load-bearing metric here, and a nearest neighbour estimated
  from a random sample of pairs is biased **low** by construction — you only
  find the best neighbour you happened to draw. A profile that quietly
  understates confusability is worse than no profile, because the generator
  downstream would build an easier corpus and we would be back to measuring
  0.000 without knowing why. Raise the cap deliberately and budget O(n²) time.

Every pairwise statistic is otherwise **exact**, not sampled — nearest
neighbours, the full pairwise distribution, intra/inter cluster distributions,
silhouette, and the duplicate components. Streaming accumulators keep memory at
O(n), so exactness costs time rather than RAM.

## The guard

`guard.ts` walks a serialised profile and asserts every leaf is a finite number
apart from the `meta` enum. `profile.ts` calls it **before writing**, so a leak
fails the run rather than producing a file someone then commits.

Two details that make it load-bearing rather than decorative:

1. **The `meta` allowlist is a closed enum, not a permissive pattern.** A
   free-form string field is exactly where a hostname or a path would eventually
   be parked "just for debugging".
2. **Violation reports carry the path and the type — never the value.** A guard
   that prints the string it caught has published it to the terminal, the CI
   log, and the PR comment quoting the CI log. That is the same failure shape as
   redacting a secret with `sed`: the control leaks the thing it exists to
   contain. There is a test asserting this specifically.

`NaN` and `Infinity` are rejected too, and not merely on principle:
`JSON.stringify` turns both into `null`, so a profile containing them changes
shape on serialisation, and a downstream generator reading `null` cannot tell a
missing metric from a broken one.
