/**
 * index.ts — flair-bench's public library API.
 *
 * CORE CONTRACT (so a future `flair bench` CLI subcommand — see README
 * "Library use" — can consume this package directly): no `process.exit`,
 * no `console.*` calls anywhere in this file or the modules it drives
 * (engine.ts, hostinfo.ts, scorer.ts, cosine.ts, prefixes.ts, share.ts).
 * Progress is reported via the optional `onProgress` callback
 * (BenchOptions.onProgress); errors are thrown as real Error objects, never
 * swallowed into an exit code. Rendering (pretty tables / JSON strings) and
 * printing both live in cli.ts + format.ts — this file only computes and
 * returns structured data.
 */

import { benchModel, corpusInfo, getSharedLlama } from "./engine.js";
import { fingerprintHost } from "./hostinfo.js";
import { TOOL_VERSION } from "./version.js";
import { buildShareDocument, writeShareDocument, type WrittenShare } from "./share.js";
import { pickRecommendation } from "./recommend-heuristic.js";
import type { BatchResult, BenchOptions, ModelBenchResult, RecommendOptions, RecommendResult } from "./types.js";

export * from "./types.js";
export { buildShareDocument, writeShareDocument, SUBMISSION_ENDPOINT_PLACEHOLDER } from "./share.js";
export type { WrittenShare } from "./share.js";
export { TOOL_VERSION } from "./version.js";
export { resolvePrefixConvention } from "./prefixes.js";
export { pickRecommendation, DEFAULT_RAM_HEADROOM_FRACTION, DEFAULT_LATENCY_THRESHOLD_MS } from "./recommend-heuristic.js";
export type { RecommendHeuristicOptions, RecommendHeuristicResult } from "./recommend-heuristic.js";

/**
 * Run the embedding benchmark for one or more GGUF files. Batch = more than
 * one entry in `options.modelFiles`. Models are loaded and disposed one at
 * a time (see engine.ts's benchModel) so peak-RSS measurement stays
 * per-model rather than accumulating across the whole batch.
 */
export async function runBenchmark(options: BenchOptions): Promise<BatchResult> {
  if (!options.modelFiles || options.modelFiles.length === 0) {
    throw new Error("runBenchmark: options.modelFiles must contain at least one GGUF file path");
  }

  const llama = await getSharedLlama();
  const host = await fingerprintHost(llama, options.label);
  options.onProgress?.({ type: "host-fingerprinted", host });

  const models: ModelBenchResult[] = [];
  for (let i = 0; i < options.modelFiles.length; i++) {
    const filePath = options.modelFiles[i]!;
    const result = await benchModel(llama, filePath, {
      warmupN: options.warmupN,
      onProgress: options.onProgress,
      index: i,
      total: options.modelFiles.length,
    });
    models.push(result);
  }

  return {
    toolVersion: TOOL_VERSION,
    timestamp: new Date().toISOString(),
    corpus: corpusInfo(),
    host,
    models,
  };
}

/**
 * Runs the batch, then recommends the model with the best measured recall
 * (MRR, tie-broken by faster ms/embed) among those that fit the host's RAM
 * headroom and latency threshold. HONEST ABOUT WHAT IT DOESN'T KNOW (see
 * README "Recommend heuristic, and its limits"):
 *   - RSS is measured for THIS process's single-model-at-a-time load, not a
 *     concurrent multi-request serving load — a real server's memory
 *     footprint under concurrency will be higher.
 *   - Latency is single-request serial ms/embed, not throughput under
 *     concurrent load or with batching.
 *   - The RAM/latency thresholds are simple fixed fractions/ceilings, not a
 *     learned or host-class-specific model — see the two options below to
 *     tune them.
 * If nothing fits the budget, recommend() falls back to ranking the full
 * set and says so explicitly in `notes` rather than silently returning null.
 *
 * The actual pick logic is pickRecommendation() (recommend-heuristic.ts) —
 * factored out so it's unit-testable against fixture BatchResult objects
 * without touching node-llama-cpp (see test/recommend.test.ts).
 */
export async function recommend(options: RecommendOptions): Promise<RecommendResult> {
  const batch = await runBenchmark(options);
  const { recommendation, notes } = pickRecommendation(batch, {
    ramHeadroomFraction: options.ramHeadroomFraction,
    latencyThresholdMsPerEmbed: options.latencyThresholdMsPerEmbed,
  });
  return { batch, recommendation, notes };
}
