/**
 * config.ts — pinned configuration for the ingest-only throughput benchmark
 * (flair#1436 / Flint addendum).
 *
 * Measures the FLAIR_EMBED_THREADS × gpuLayers grid on the ingest path only:
 * no reader, no judge, no provider. Everything that determines the measured
 * number is pinned here and folded into `configManifest()` → `hashConfig()`
 * → `configHash`. Pin by DIGEST, never by tag.
 *
 * This config does NOT change any product default (threads or gpuLayers).
 * #1437 is the default-change decision; this file only names the sweep.
 */
import { createHash } from "node:crypto";
import { DATASET } from "../longmemeval/config";
import {
  NEGATIVE_CONTROL_MIN_SLOWDOWN,
  POSITIVE_CONTROL_HOST_CORES,
  POSITIVE_CONTROL_TOK_PER_SEC_PER_CORE,
} from "../../unit/ingest-throughput-control";

/** The embedding model under test. Pinned by GGUF file digest, never by name. */
export const MODEL = {
  name: "nomic-embed-text",
  file: "nomic-embed-text-v1.5.Q4_K_M.gguf",
  sha256: "d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac",
  pooling: "mean",
} as const;

/** The thread axis under test. Default (unset) is `max(1, cores - 1)`. */
export const THREAD_SWEEP = [6, 7, 8] as const;

/**
 * GPU-layer axis. 0 = CPU (HFE default). 99 = full offload (Metal cell).
 * On non-Metal hosts the runner skips 99 rather than inventing GPU numbers.
 */
export const GPU_LAYER_SWEEP = [0, 99] as const;

/** Negative control: FLAIR_EMBED_THREADS=1 must be ≥1.3× slower than 8. */
export const NEGATIVE_CONTROL = { low: 1, high: 8 } as const;

export { NEGATIVE_CONTROL_MIN_SLOWDOWN };

export const POSITIVE_CONTROL = {
  tokPerSecPerCore: POSITIVE_CONTROL_TOK_PER_SEC_PER_CORE,
  hostCores: POSITIVE_CONTROL_HOST_CORES,
} as const;

export const DEFAULT_RUNS = 3;
export const DEFAULT_SLICE_N = 500;
export const DEFAULT_SEED = 0;
export const INGEST_CONCURRENCY = 6;

/** Embedder-reported token count — matches the #1436 baseline (86,550 / n=500). */
export const TOKEN_COUNTING = "hdb_model_calls.embedding_tokens" as const;

/** Seconds to wait after ingest for the analytics writer to flush (10s + margin). */
export const FLUSH_WAIT_MS = 12_000;

export const CONFIG_SCHEMA = "ingest-throughput.config/2";
export const ARTIFACT_SCHEMA = "ingest-throughput.artifact/2";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}
function sortDeep(v: any): any {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

export function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function hashConfig(manifest: unknown): string {
  return sha256hex(canonicalJson(manifest));
}

export interface SliceSpec {
  n: number;
  seed: number;
  runs: number;
}

export function configManifest(slice: SliceSpec, gpuLayerSweep: readonly number[]) {
  return {
    schema: CONFIG_SCHEMA,
    dataset: DATASET,
    model: MODEL,
    threadSweep: THREAD_SWEEP,
    gpuLayerSweep: [...gpuLayerSweep],
    negativeControl: { ...NEGATIVE_CONTROL, minSlowdown: NEGATIVE_CONTROL_MIN_SLOWDOWN },
    positiveControl: POSITIVE_CONTROL,
    slice,
    ingestConcurrency: INGEST_CONCURRENCY,
    tokenCounting: TOKEN_COUNTING,
  };
}
