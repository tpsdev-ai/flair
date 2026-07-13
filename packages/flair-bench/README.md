# @tpsdev-ai/flair-bench

A standalone embedding recall benchmark for [flair](https://github.com/tpsdev-ai/flair). Run real recall numbers — precision@3, MRR — against any GGUF embedding model, batch-compare several, get a host-aware recommendation, and (optionally) save a redacted, shareable result. **No flair install required.**

```
npx @tpsdev-ai/flair-bench run --model-file ./nomic-embed-text-v1.5.Q4_K_M.gguf
```

## Why this exists

flair ships nomic-embed-text-v1.5 (Q4_K_M by default) for local semantic memory search. The question "would a different model/quant actually recall better *for flair's use case*, on *my* hardware?" used to require a full flair checkout, its recall-eval harness, and an ephemeral Harper instance. flair-bench packages the same corpus and the same scoring math into a small, dependency-light CLI/library you can point at any GGUF, anywhere.

## Install / run

```bash
npx @tpsdev-ai/flair-bench run --model-file /path/to/model.gguf
```

or install it:

```bash
npm install -g @tpsdev-ai/flair-bench
flair-bench run --model-file /path/to/model.gguf
```

Requires Node.js >= 22. Downloads no models itself — point it at GGUF files you already have.

## Commands

### `run` — benchmark one or more models

```bash
flair-bench run --model-file a.gguf --model-file b.gguf --model-file c.gguf
flair-bench run --manifest models.txt          # one path per line, # comments allowed
flair-bench run --model-file a.gguf --json      # machine-readable output
flair-bench run --model-file a.gguf --label "local-m4-mini"   # freeform host/infra tag
```

Reports, per model: p@3/MRR (aggregate and per-kind — stress/trap/hard/clean, see "The corpus" below), ms/embed (serial, warm, N≥64), peak RSS delta, GGUF file size/BPW, embedding dimensions, and load time. A batch (more than one `--model-file`) ends with a ranked comparison table.

### `recommend` — pick a model for this host

```bash
flair-bench recommend --model-file a.gguf --model-file b.gguf --model-file c.gguf
```

Fingerprints the host (platform, arch, RAM, CPU model, and the **actual compute backend node-llama-cpp loaded** — Metal/CUDA/Vulkan/CPU, plus GPU device name(s) when present — not inferred from the OS), runs the batch, and recommends the best measured recall the host can plausibly afford. See "Recommend heuristic, and its limits" below — this is deliberately simple and says so.

### `--share` — save a redacted, shareable result

```bash
flair-bench run --model-file a.gguf --share
```

Writes a canonical JSON file per model (see "Share schema" below) and prints where the eventual hosted-submission endpoint would receive it — **no network call is made**; the endpoint is a config placeholder (`SUBMISSION_ENDPOINT_PLACEHOLDER` in `src/share.ts`) for a hosted site that doesn't exist yet.

## `--label`: benchmarking infra, not just models

flair-bench's core use case extends past "which model" to "which model on which infra" — comparing a GGUF across, say, a free-tier Fabric host, a GPU-backed Fabric host, and a local Mac. `--label <string>` is a **freeform, user-chosen** string (e.g. `"fabric-free-gcp"`, `"fabric-gpu-a"`, `"local-m4-mini"`) that becomes the grouping key in `run`/`recommend` output and in `--share`'s `hardware.label` field. It is never auto-filled from the machine's real hostname — real hostnames never need to appear in a shared result. Combined with the measured `hardware.backend`/`hardware.gpu` fields (see below), a set of `--share` outputs across labeled hosts is a model × infra matrix.

## Comparable to flair, with a caveat

flair-bench uses **exactly the same corpus, the same p@3/MRR scoring math, and the same nomic search-prefix convention** flair's own isolated recall-eval harness (`test/bench/recall-harness/`) uses — see "What's shared vs. copied" below. The one deliberate difference: Harper's live `/SemanticSearch` endpoint ranks candidates through an **HNSW approximate index**; flair-bench has no HNSW graph, so it ranks every query against **every** corpus record by exact cosine similarity instead. For a corpus this size (251 records), exact search is strictly more informative, not less — but it means a number from this tool and a number from the harness aren't guaranteed to be bit-identical, only very close. See this repo's PR for the validation that quantifies exactly how close (spoiler: they match).

## What's shared vs. copied (and how it's kept honest)

- **Corpus** (`src/corpus-v2.ts`): a **build-time copy** of `test/bench/recall-harness/corpus-v2.ts`. A standalone, npx-able package can't import from the monorepo's `test/` directory at runtime (it isn't published), so the corpus is copied at commit time via `scripts/sync-corpus.mjs` and kept honest by `test/corpus-sync.test.ts`, which deep-equals this copy's exported `CORPUS`/`QUERIES` against the live harness source on every `bun test` run inside the monorepo checkout. Any drift fails CI loudly.
- **Scorer** (`src/scorer.ts`): a **faithful hand-replication** of the harness's `statsFor()` (which isn't exported, so it can't be imported directly). `test/scorer-sync.test.ts` reads the harness source's raw text and asserts it still contains the exact formula fragments this package replicated — a tripwire against silent drift.
- **Prefix convention** (`src/prefixes.ts`): re-implements the same `search_document: `/`search_query: ` string-prepend `resources/embeddings-provider.ts` gets from harper-fabric-embeddings' engine, since flair-bench talks to node-llama-cpp directly and has no HFE wrapper in the loop. Keyed on model filename today (see the file's own header) — there's an upstream proposal to carry this convention in the GGUF/HFE registration surface itself instead of every consumer re-deriving it from a filename pattern: `harper-fabric-embeddings#4`.

## The corpus

251 synthetic records across 30 topic clusters, 126 hand-written ground-truth queries in four kinds:

- **stress** — durability/recency adversarial pairs (does a fresher-but-wrong record outrank an older-but-correct one?)
- **trap** — cross-cluster lexical traps (the same ambiguous term used in two different domains, e.g. "transaction" in database internals vs. finance ops)
- **hard** — near-duplicate-cluster disambiguation
- **clean** — unambiguous single-best-answer sanity floor

See `test/bench/recall-harness/corpus-v2.ts`'s header (in the main flair repo) for the full design rationale.

## Recommend heuristic, and its limits

`recommend` picks the model with the best measured MRR among those whose peak RSS delta fits within a RAM headroom budget (default: 50% of currently-available RAM) and whose ms/embed is under a latency ceiling (default: 500ms — deliberately generous). Ties broken by faster ms/embed. If nothing fits the budget, it falls back to ranking the full set and says so explicitly rather than returning nothing.

**What it doesn't know**, stated plainly rather than hidden behind a confident-sounding number:

- RSS is measured for a single model loaded and queried **serially, one request at a time**, in this one process. A real server holding the model resident under concurrent requests will use more memory than this measurement shows.
- Latency is single-request serial ms/embed — not throughput under concurrency, not batched-request latency.
- The RAM/latency thresholds are simple fixed fractions/ceilings (`--ram-headroom`, `--latency-threshold`), not a learned or host-class-aware model.
- "Available RAM" comes from Node's `os.freemem()`, which on macOS in particular tends to report far less than what's actually usable — macOS treats most inactive/file-cache pages as reclaimable-but-not-"free", so `os.freemem()` can read a couple of GiB on a machine that's actually got plenty of headroom. On Linux, `os.freemem()` is closer to the truth (`MemFree`, not `MemAvailable`) but still not identical to it. Treat the RAM-budget gate as directionally useful, not authoritative — a "didn't fit the budget" fallback note is worth a second look on macOS specifically before concluding a model genuinely doesn't fit.

The recommendation always cites the actual measured numbers it's based on (e.g. *"X because p@3 0.984 vs 0.976 (MRR 0.950 vs 0.946) at 22.1ms/embed and 612 MiB peak RSS on your 40.0GiB-available metal host"*) — never a bare model name with no evidence.

## Share schema

`--share` writes one JSON file per model:

```jsonc
{
  "toolVersion": "0.1.0",
  "timestamp": "2026-07-12T00:00:00.000Z",
  "model": {
    "name": "nomic-embed-text-v1.5",
    "fileBasename": "nomic-embed-text-v1.5.Q4_K_M.gguf",
    "sha256": "…",
    "quant": "Q4_K_M",
    "paramsApprox": 136731648,
    "dims": 768
  },
  "hardware": {
    "label": "local-m4-mini",
    "platform": "darwin",
    "arch": "arm64",
    "cpuModel": "Apple M4 Pro",
    "ramGiB": 48,
    "gpu": "Apple M4 Pro",
    "backend": "metal"
  },
  "results": {
    "aggregate": { "n": 126, "p3": 0.976, "mrr": 0.946 },
    "perKind": { "stress": { … }, "trap": { … }, "hard": { … }, "clean": { … } },
    "msPerEmbedSerialWarm": 22.1,
    "peakRssMiB": 612.1
  }
}
```

**Privacy**: this document NEVER includes a hostname, a filesystem path, or a username. `model.fileBasename` is a basename only (never the directory it lives in); `hardware.label` is whatever freeform string you passed to `--label` — it defaults to nothing, never your machine's real hostname. `test/share-schema.test.ts` gates this contract.

**Stubbed**: the eventual hosted submission endpoint (a site to browse shared results — Nathan's "an option to share benchmarks") doesn't exist yet. `--share` writes the file locally and prints `submission endpoint not yet configured — file saved at <path>`; the endpoint URL in the code is a placeholder constant, and no network call is ever made.

## Library use

The public API (`src/index.ts`) has **no `process.exit`, no `console.*` calls** anywhere in its call graph — `runBenchmark()`/`recommend()` return structured data (`BatchResult`/`RecommendResult`); progress is reported via an optional `onProgress` callback; rendering (pretty text / JSON) lives separately in `src/format.ts`. `src/cli.ts` is a thin argv-parsing layer on top, and is the *only* place in the package that prints or sets an exit code.

This shape is deliberate: a future `flair bench` subcommand on the main flair CLI is expected to import `runBenchmark`/`recommend` directly and drive its own UI, rather than shelling out to this package's bin.

```ts
import { runBenchmark, recommend } from "@tpsdev-ai/flair-bench";

const batch = await runBenchmark({ modelFiles: ["./model.gguf"], label: "my-host" });
console.log(batch.models[0].aggregate); // { n: 126, p3: 0.976, mrr: 0.946 }

const picked = await recommend({ modelFiles: ["./a.gguf", "./b.gguf"] });
console.log(picked.recommendation?.reason);
```

## Development

```bash
bun test                 # unit tests (scorer, prefixes, cosine, recommend heuristic, share schema, sync checks)
bun run build             # tsc build to dist/
bun run sync:corpus       # regenerate src/corpus-v2.ts from the harness source (run after editing the harness corpus)
```

`test/corpus-sync.test.ts` and `test/scorer-sync.test.ts` only pass inside a full monorepo checkout (they read `test/bench/recall-harness/` two levels up) — that's expected; they're the drift guard for maintainers, not something a consumer of the published package ever runs.
