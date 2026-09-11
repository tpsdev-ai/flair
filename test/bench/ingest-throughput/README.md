# Ingest-only throughput benchmark (flair#1436)

Measures the `FLAIR_EMBED_THREADS` × `gpuLayers` grid on the **ingest path
only** — no retrieval, no reader, no judge, no provider. Embeddings are local;
a run costs zero tokens. That is what makes it repeatable without a cap.

This harness **produces a number**. It does not change any product default
(`threads` or `gpuLayers`). The default-change decision is #1437; this bench
is the measurement it is gated on.

## What it measures

For each `(threads, gpuLayers)` cell it spawns a **fresh** ephemeral Harper
(the lifecycle is not pipelined — `threads` and `gpuLayers` resolve at
module-load), warms the embedder, ingests a LongMemEval_s slice, and reports:

| Field | Meaning |
|---|---|
| requested threads | `FLAIR_EMBED_THREADS` (`default` = unset) |
| requested gpuLayers | `FLAIR_EMBED_GPU_LAYERS` (`0` = unset / HFE default) |
| **observed threads** | Warmup thread-count delta. Unreadable → **refuse**. |
| documents, tokens | Records written; embedder-reported `hdb_model_calls.embedding_tokens` |
| **doc/s + spread** | `documents / wall-s`, `[min, max]` across `--runs` |
| tok/s, tok/s/core | Throughput; core = observed threads |
| peak RSS | `VmHWM` (Linux) or `ps` RSS (Darwin) |
| Metal readback | `ggml_metal_init` + compute-buffer in Harper logs (`gpu=99` only) |

## Gates (refuse rather than lie)

1. **Observed threads.** If the thread count cannot be read, the run exits
   `BLOCKED`. Requested is not used.
2. **Negative control (runs first).** `FLAIR_EMBED_THREADS=1` must be
   **≥1.3× slower** than `8` (tok/s). If it is not, the env var is not
   reaching the embedder and ranking is refused.
3. **Positive control.** On an **8-core Linux x86_64** host the unset-default
   cell must reproduce ~159 tok/s/core **inside the measured `[min, max]`**.
   Darwin, other arches, and other core counts skip — that number is the
   published tps-bench baseline, not a Darwin figure. No Darwin number is
   invented.
4. **Metal-engaged.** Every `gpuLayers=99` cell must show `ggml_metal_init`
   **and** a `compute-buffer` / `compute buffer` line. No log → that cell
   refuses; no invented GPU numbers.
5. **Variance.** Overlapping `[min, max]` intervals → `inconclusive`. The
   harness does not pick a winner.
6. **`gitCommit`.** Non-null 40-hex or refuse (flair#1432).
7. **Quiet box (first).** `ps` + 1-min loadavg before any Harper spawn.
   Competing `harper` / `llama` / `embed-server` processes, or load ≥ 0.75×
   cores, refuse. Elevated load caveats and refuses ranking. `--allow-noisy`
   measures anyway with ranking refused.

## Run

```sh
# CPU-only (Linux, CI, this cloud VM). gpuLayers=99 is skipped.
bun run test/bench/ingest-throughput/run.ts run \
  --dataset /path/to/longmemeval_s \
  --n 500 --seed 0 --runs 3 \
  --out test/bench/ingest-throughput/artifacts

# Darwin Metal (Apple Silicon) — the #1437 paired measurement.
# Default --gpu-layers is auto: {0, 99} on darwin-arm64.
bun run test/bench/ingest-throughput/run.ts run \
  --dataset /path/to/longmemeval_s \
  --n 500 --seed 0 --runs 3 \
  --gpu-layers 0,99 \
  --out test/bench/ingest-throughput/artifacts
```

| Flag | Default | |
|---|---|---|
| `--dataset` | (required) | LongMemEval_s file, pinned by sha256 |
| `--n` | `500` | Slice size (same as the #1436 baseline) |
| `--seed` | `0` | Slice seed |
| `--runs` | `3` | Repeats per cell (variance) |
| `--out` | `test/bench/ingest-throughput/artifacts` | Artifact directory |
| `--gpu-layers` | `auto` | `auto` → `{0,99}` on darwin-arm64, `{0}` elsewhere. `0,99` forces the Metal cells (they still refuse without the log). |
| `--allow-noisy` | off | Measure on a busy box; ranking is refused |

The dataset is pinned by sha256 (see `config.ts`); fetch it as the
LongMemEval_s bench does (`../longmemeval/README.md`). The model is pinned
by GGUF sha256 at `models/nomic-embed-text-v1.5.Q4_K_M.gguf`.

`FLAIR_EMBED_GPU_LAYERS` is the env pin the runner sets per cell. **Unset
leaves HFE's default of 0.** This issue does not change that default.

## Darwin / Metal (mac-arm64)

A Linux VM cannot produce Metal numbers. Do not copy CPU throughput into a
GPU cell. On an Apple Silicon Mac:

1. Quiet the box (`pgrep -fl harper`; `pgrep -fl llama`; Activity Monitor).
2. Confirm the Metal addon is present (`@node-llama-cpp/mac-arm64-metal`).
3. Run the command above with `--gpu-layers 0,99`.
4. In the artifact, every `gpu=99` run must have `metalEngaged: true` and
   `metalEvidence` containing `ggml_metal_init` plus a compute-buffer line.
5. Read `ranking["gpu@threads=7"]` (and the other thread keys). If
   `verdict` is `inconclusive`, the intervals overlapped — do not claim a
   winner for #1437.

## Artifact

Schema `ingest-throughput.artifact/2`. Content-addressed: hashed CONTENT
(schema, gitCommit, configHash, config, runHashes, settings,
negativeControl, positiveControl, ranking, gpuSweep) vs unhashed
PROVENANCE (generatedAt, host including quietBox, notice, artifactHash).
`configHash` is the anchor. `artifactHash` is a seal.

Per-cell summary printed at the end:

```
threads  gpu  obs  doc/s  spread           tok/s  tok/s/core  metal
6        0    6    12.30  12.10–12.50      1080   180         —
7        0    7    12.80  12.60–13.00      1100   157         —
8        0    8    12.40  12.20–12.70      1090   136         —
7        99   7    28.10  27.80–28.40      2400   343         yes
```

## Host notes

- **Linux:** thread count and RSS from `/proc/<pid>/status` (`Threads`, `VmHWM`).
- **Darwin:** `ps -o thcount=` (fallback `ps -M`) and `ps -o rss=`.
- Other platforms refuse at observe time.
- The `{6,7,8}` sweep is only separable on a host with ≥8 cores:
  node-llama-cpp caps threads at `max(4, cores)`. The #1436 baseline
  (~159 tok/s/core) was measured on an 8-core Linux x86_64 host.
