/**
 * config.ts — pinned configuration for the ingest-only throughput benchmark
 * (flair#1436).
 *
 * The benchmark measures the FLAIR_EMBED_THREADS axis (6 vs 7 vs 8) on the
 * ingest path only: spawn an ephemeral Harper, ingest a LongMemEval_s slice,
 * and report tokens/s and tokens/s/core. It does NOT retrieve, read, or judge —
 * that is the whole point of "ingest-only" (the reader/judge are a separate
 * cost that would confound the thread measurement).
 *
 * Everything that determines the measured number is pinned here and folded
 * into `configManifest()` → `hashConfig()` → `configHash`, the content-address
 * anchor (flair#1368). Pin by DIGEST, never by tag: the dataset is pinned by
 * sha256, the model by its GGUF sha256.
 */
import { createHash } from "node:crypto";
import { DATASET } from "../longmemeval/config";

/** The embedding model under test. Pinned by GGUF file digest, never by name.
 *  `name` is what embeddings-boot.ts passes to HFE (`modelName`); `file` +
 *  `sha256` pin the exact bytes HFE loads from `models/`. */
export const MODEL = {
  name: "nomic-embed-text",
  file: "nomic-embed-text-v1.5.Q4_K_M.gguf",
  sha256: "d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac",
  pooling: "mean",
} as const;

/** The thread axis under test. The default (unset) is `max(1, cores - 1)` per
 *  `resolveEmbedThreads()`; on an 8-core host that is 7. We sweep 6/7/8 to see
 *  whether the current default (7) is optimal or whether 6 or 8 is better. */
export const THREAD_SWEEP = [6, 7, 8] as const;

/** Negative control: FLAIR_EMBED_THREADS=1 must be materially slower than 8.
 *  If it is not, the env var is not reaching the embedder and the sweep is
 *  untrustworthy. Run FIRST, before the sweep. */
export const NEGATIVE_CONTROL = { low: 1, high: 8 } as const;

export const DEFAULT_RUNS = 3;
export const DEFAULT_SLICE_N = 500; // match the #1436 baseline (n=500)
export const DEFAULT_SEED = 0;
export const INGEST_CONCURRENCY = 6; // matches longmemeval's INGEST_CONCURRENCY

/** How "tokens ingested" is counted. The embedder's own reported token count
 *  (`hdb_model_calls.embedding_tokens`, nomic-embed-text BERT WordPiece) is the
 *  ground truth and matches the #1436 baseline (86,550 tokens / n=500). */
export const TOKEN_COUNTING = "hdb_model_calls.embedding_tokens" as const;

/** Seconds to wait after ingest for the `hdb_model_calls` analytics writer to
 *  flush its buffered rows (10s flush interval + margin). */
export const FLUSH_WAIT_MS = 12_000;

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

/** The content-address of a config manifest. */
export function hashConfig(manifest: unknown): string {
  return sha256hex(canonicalJson(manifest));
}

export interface SliceSpec {
  n: number;
  seed: number;
  runs: number;
}

export function configManifest(slice: SliceSpec) {
  return {
    schema: "ingest-throughput.config/1",
    dataset: DATASET,
    model: MODEL,
    threadSweep: THREAD_SWEEP,
    negativeControl: NEGATIVE_CONTROL,
    slice,
    ingestConcurrency: INGEST_CONCURRENCY,
    tokenCounting: TOKEN_COUNTING,
  };
}
