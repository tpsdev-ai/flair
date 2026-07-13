/**
 * recommend-heuristic.ts — the pure "which model should I use" pick,
 * factored out of index.ts's recommend() so it's unit-testable against
 * fixture BatchResult objects (see test/recommend.test.ts) without ever
 * touching node-llama-cpp or a real GGUF file.
 *
 * See recommend()'s own doc in index.ts for the honesty caveats this
 * heuristic carries (single-request serial measurement, no concurrency
 * model, fixed fraction/ceiling thresholds).
 */

import { basename } from "node:path";
import type { BatchResult, Recommendation } from "./types.js";

export const DEFAULT_RAM_HEADROOM_FRACTION = 0.5; // generous: a model may use up to half of currently-available RAM
export const DEFAULT_LATENCY_THRESHOLD_MS = 500; // generous: 500ms/embed serial is a very permissive ceiling

export interface RecommendHeuristicOptions {
  ramHeadroomFraction?: number;
  latencyThresholdMsPerEmbed?: number;
}

export interface RecommendHeuristicResult {
  recommendation: Recommendation | null;
  notes: string[];
}

export function pickRecommendation(batch: BatchResult, options: RecommendHeuristicOptions = {}): RecommendHeuristicResult {
  const ramHeadroomFraction = options.ramHeadroomFraction ?? DEFAULT_RAM_HEADROOM_FRACTION;
  const latencyThresholdMsPerEmbed = options.latencyThresholdMsPerEmbed ?? DEFAULT_LATENCY_THRESHOLD_MS;

  const notes: string[] = [
    `Heuristic: best measured recall (MRR) among models whose peak RSS delta fits within ${Math.round(ramHeadroomFraction * 100)}% of available RAM (${(batch.host.availableRamGiB * ramHeadroomFraction).toFixed(1)} GiB budget on this host) and whose ms/embed is <= ${latencyThresholdMsPerEmbed}ms. Doesn't know your concurrency, batching, or serving framework — see README for the full limits list.`,
  ];

  if (batch.models.length === 0) {
    return { recommendation: null, notes: [...notes, "No models were benchmarked."] };
  }

  const budgetMiB = batch.host.availableRamGiB * ramHeadroomFraction * 1024;
  const affordable = batch.models.filter((m) => m.peakRssDeltaMiB <= budgetMiB && m.msPerEmbedSerialWarm <= latencyThresholdMsPerEmbed);
  let pool = affordable;
  if (affordable.length === 0) {
    pool = batch.models;
    notes.push(
      `No model fit the RAM/latency budget above — falling back to ranking all ${batch.models.length} benchmarked model(s) by recall alone. Treat this pick as informational, not a "fits your host" claim.`,
    );
  }

  const ranked = [...pool].sort((a, b) => b.aggregate.mrr - a.aggregate.mrr || a.msPerEmbedSerialWarm - b.msPerEmbedSerialWarm);
  const best = ranked[0]!;
  const runnerUp = ranked[1];

  let reason: string;
  if (runnerUp) {
    reason =
      `${basename(best.model.fileName)} because p@3 ${best.aggregate.p3.toFixed(3)} vs ${runnerUp.aggregate.p3.toFixed(3)} ` +
      `(MRR ${best.aggregate.mrr.toFixed(3)} vs ${runnerUp.aggregate.mrr.toFixed(3)}) at ${best.msPerEmbedSerialWarm.toFixed(1)}ms/embed ` +
      `and ${best.peakRssDeltaMiB.toFixed(0)} MiB peak RSS on your ${batch.host.availableRamGiB.toFixed(1)}GiB-available ${batch.host.backend} host.`;
  } else {
    reason =
      `${basename(best.model.fileName)} — the only model benchmarked (p@3 ${best.aggregate.p3.toFixed(3)}, MRR ${best.aggregate.mrr.toFixed(3)}) ` +
      `at ${best.msPerEmbedSerialWarm.toFixed(1)}ms/embed and ${best.peakRssDeltaMiB.toFixed(0)} MiB peak RSS on your ${batch.host.availableRamGiB.toFixed(1)}GiB-available ${batch.host.backend} host. ` +
      `Run with more --model-file flags to get a real comparison.`;
  }

  const recommendation: Recommendation = { fileName: best.model.fileName, reason };
  return { recommendation, notes };
}
