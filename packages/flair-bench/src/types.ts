/**
 * types.ts — shared types for the flair-bench public API.
 *
 * Kept dependency-free (no node-llama-cpp types leak here) so a future
 * `flair bench` CLI subcommand (see README "Library use") can import just
 * the shapes it needs without pulling in the embedding engine.
 */

import type { QueryKind } from "./corpus-v2.js";

export type { QueryKind };

/** "metal" | "cuda" | "vulkan" — the backend node-llama-cpp actually loaded, or "cpu" if none. */
export type ComputeBackend = "metal" | "cuda" | "vulkan" | "cpu";

/**
 * Host fingerprint. `label` is a freeform, user-chosen grouping key (e.g.
 * "fabric-free-gcp", "local-m4-mini") — NOT a hostname. Real hostnames never
 * appear here; see share.ts for the privacy contract that leans on this.
 */
export interface HostFingerprint {
  label?: string;
  platform: string;
  arch: string;
  cpuModel: string;
  totalRamGiB: number;
  availableRamGiB: number;
  backend: ComputeBackend;
  /** GPU device name(s) node-llama-cpp reports, e.g. ["Apple M4 Pro"]. Empty when backend is "cpu". */
  gpuDeviceNames: string[];
}

/** Everything about the GGUF file identifying the model under test. */
export interface ModelIdentity {
  /** Basename only — never the full path (privacy: no local filesystem layout in shared results). */
  fileName: string;
  sha256: string;
  sizeBytes: number;
  /** e.g. "Q4_K_M" — read from GGUF metadata when present, else parsed from the filename. */
  quant: string;
  quantSource: "gguf-metadata" | "filename-fallback";
  /** Embedding vector dimensionality. */
  dims: number;
  /**
   * Approximate total parameter count, computed by summing every tensor's
   * element count from the GGUF's own tensor index (the same method
   * llama.cpp's own CLI reports "params" with) — not read from a
   * general.parameter_count field, which embedding-architecture GGUFs don't
   * reliably carry.
   */
  paramsApprox: number;
  /** Bits per weight: (file size in bits) / paramsApprox. */
  bpw: number;
}

export interface PerKindStat {
  n: number;
  p3: number;
  mrr: number;
}

export interface AggregateStat {
  n: number;
  p3: number;
  mrr: number;
}

export interface ModelBenchResult {
  model: ModelIdentity;
  loadTimeMs: number;
  /** Serial, warm (post-warmup), N>=64 embed calls; mean ms/embed. */
  msPerEmbedSerialWarm: number;
  /** process.memoryUsage().rss peak observed during this model's load+embed phase, minus the pre-load baseline. */
  peakRssDeltaMiB: number;
  aggregate: AggregateStat;
  perKind: Record<QueryKind, PerKindStat>;
}

export interface CorpusInfo {
  version: "v2";
  records: number;
  queries: number;
}

export interface BatchResult {
  toolVersion: string;
  timestamp: string;
  corpus: CorpusInfo;
  host: HostFingerprint;
  models: ModelBenchResult[];
}

export interface BenchOptions {
  /** One or more GGUF file paths. Batch = multiple entries. */
  modelFiles: string[];
  /** Freeform host-grouping label — see HostFingerprint.label. */
  label?: string;
  /** Number of corpus texts embedded during warmup before timing starts. Default 8. */
  warmupN?: number;
  /** Progress/diagnostic callback — core never calls console.*; a caller (e.g. the CLI) wires this to stderr. */
  onProgress?: (event: BenchProgressEvent) => void;
}

export type BenchProgressEvent =
  | { type: "host-fingerprinted"; host: HostFingerprint }
  | { type: "model-start"; fileName: string; index: number; total: number }
  | { type: "model-loaded"; fileName: string; loadTimeMs: number }
  | { type: "model-embedding"; fileName: string; done: number; total: number }
  | { type: "model-done"; fileName: string; result: ModelBenchResult };

export interface RecommendOptions extends BenchOptions {
  /** Fraction of *available* RAM a model's peak RSS delta may use. Default 0.5 (generous headroom). */
  ramHeadroomFraction?: number;
  /** ms/embed ceiling for a model to be considered "usable" on this host. Default 500 (generous). */
  latencyThresholdMsPerEmbed?: number;
}

export interface Recommendation {
  fileName: string;
  reason: string;
}

export interface RecommendResult {
  batch: BatchResult;
  recommendation: Recommendation | null;
  /** Human-readable lines explaining the heuristic's inputs/limits — always populated, even with no pick. */
  notes: string[];
}

export interface ShareDocument {
  toolVersion: string;
  timestamp: string;
  model: {
    name: string;
    fileBasename: string;
    sha256: string;
    quant: string;
    paramsApprox: number;
    dims: number;
  };
  hardware: {
    label?: string;
    platform: string;
    arch: string;
    cpuModel: string;
    ramGiB: number;
    gpu: string | null;
    backend: ComputeBackend;
  };
  results: {
    aggregate: AggregateStat;
    perKind: Record<QueryKind, PerKindStat>;
    msPerEmbedSerialWarm: number;
    peakRssMiB: number;
  };
}
