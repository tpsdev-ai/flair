# Ingest-only throughput benchmark (flair#1436)

Measures the `FLAIR_EMBED_THREADS` axis on the **ingest path only** — no
retrieval, no reader, no judge. The reader/judge are a separate cost that would
confound the thread measurement, so this benchmark isolates the one thing the
issue is about: how many llama.cpp CPU threads the embedder uses, and what that
does to ingest throughput.

## What it measures

For each thread setting it spawns a fresh ephemeral Harper, warms the embedder
(loads the model + creates the worker threads), ingests a LongMemEval_s slice,
and reports:

- **requested threads** — the `FLAIR_EMBED_THREADS` value (or `default` = unset).
- **observed threads** — the *actual* thread count, read as the `/proc/<pid>/status`
  `Threads:` delta before/after warmup. This is the number the sweep is really
  about: it asserts the env var reached the embedder, not just that it was set.
- **tokens ingested** — the embedder's own reported count
  (`system.hdb_model_calls.embedding_tokens`, nomic-embed-text BERT WordPiece),
  summed via the ops `sql` operation after the analytics writer flushes.
- **tok/s** and **tok/s/core** — throughput, where "core" is the observed thread
  count (each embedder thread ≈ one core of CPU work).
- **peak RSS** — `VmHWM` of the Harper process.

## Negative control (runs first, hard gate)

`FLAIR_EMBED_THREADS=1` must be **materially slower** than `8`. If it is not, the
env var is not reaching the embedder and the sweep would be untrustworthy — the
run aborts with `BLOCKED` instead of emitting a misleading number. The threshold
is `low.tokPerSec < 0.75 * high.tokPerSec` (low ≥25% slower); on a real host the
ratio is far lower (1 vs 8 threads ≈ 0.125).

## Run

```sh
bun run test/bench/ingest-throughput/run.ts run \
  --dataset /path/to/longmemeval_s \
  --n 500 --seed 0 --runs 3 --out test/bench/ingest-throughput/artifacts
```

- `--n` — slice size (default 500, matching the #1436 baseline).
- `--runs` — runs per setting (default 3).
- `--out` — artifact output directory.

The dataset is pinned by sha256 (see `config.ts`); fetch it exactly as the
LongMemEval_s bench does (see `../longmemeval/README.md`). The model is pinned by
GGUF sha256 and must be present at `models/nomic-embed-text-v1.5.Q4_K_M.gguf`.

## Artifact

Content-addressed, same partition as `../longmemeval/artifact.ts`: hashed CONTENT
(schema, gitCommit, configHash, config, runHashes, settings, negativeControl) vs
unhashed PROVENANCE (generatedAt, host, notice, artifactHash). `configHash` is the
anchor — re-derivable by anyone with the repo. `artifactHash` is a seal
(tamper-evidence), not a reproducibility proof.

## Host requirement

The sweep `{6, 7, 8}` is only meaningful on a host with ≥8 cores: node-llama-cpp
caps the thread count at `max(4, cores)`, so on a smaller host every sweep value
collapses to the same cap. The #1436 baseline (86,550 tokens / 80.1s ≈ 159
tok/s/core) was measured on an 8-core host (`rockit`).
