/**
 * flair-bench/lib — shared eval plumbing for the flair-bench evaluation layers.
 *
 * This directory is the FOUNDATION referenced by #1216: the one ingest + one
 * retrieve + one metrics implementation that Layer 1 (deterministic recall
 * eval, #17 / #1216-a) and Layer 2 (LongMemEval_s end-to-end, #1216-b) both
 * build on, so the two layers can never diverge on how memories are written to
 * or read from Flair (a divergence would be a silent confound — Kern's design).
 *
 * It is REPO-INTERNAL tooling: not part of the published @tpsdev-ai/flair-bench
 * tarball (the package's `files` ships only dist/ built from src/, and this
 * lives outside src/). It is consumed by bench runners and tests via bun's
 * runtime TypeScript resolution, and it spawns nothing itself — callers supply
 * a running ephemeral Harper (test/helpers/harper-lifecycle) plus a bench
 * identity.
 */
export * from "./types.js";
export * from "./signed-fetch.js";
export { ingestSessionHistory } from "./ingest.js";
export { retrieveContext, suggestRetrieveLimit } from "./retrieve.js";
export {
  recallAtK,
  ndcgAtK,
  reciprocalRank,
  scoreQuery,
  aggregate,
  type PerQueryScore,
  type AggregateScore,
} from "./metrics.js";
