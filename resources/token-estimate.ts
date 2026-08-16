/**
 * token-estimate.ts — the ONE token estimator the bootstrap payload budget and
 * `tokenEstimate` report are computed with.
 *
 * Extracted to a harper-free module (no `import ... from "harper"`) for two
 * reasons:
 *
 *   1. Single source of truth. `MemoryBootstrap` computes both its content-
 *      selection budget and the reported `tokenEstimate` with THIS function, so
 *      there is exactly one definition of "how many tokens is this text".
 *   2. The flair#1213 connector-conformance suite asserts the tokenEstimate
 *      invariant — `tokenEstimate === estimateTokens(JSON.stringify(deliveredPayload))`
 *      — with the SAME estimator, not a byte length or a different tokenizer
 *      (Kern #1 / Sherlock #2). Importing this module (which never pulls in
 *      Harper) lets a plain bun:test process reconstruct the estimate exactly,
 *      so the invariant catches the flair#1199 double-serialization class
 *      without being brittle to a future estimator change: change the formula
 *      here and both the report and the invariant move together.
 *
 * The estimate is deliberately coarse (~4 chars per token for English text). It
 * is a budgeting/reporting heuristic, never a billing figure.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
