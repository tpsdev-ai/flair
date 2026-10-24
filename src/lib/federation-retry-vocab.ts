/**
 * federation-retry-vocab.ts — the retry row's outcome vocabulary.
 *
 * Pure and DB-free. Lives under src/lib so the generic-Memory sender (which
 * the CLI build compiles from src/) and the Harper resources share one copy of
 * the state/outcome names; resources/federation-retry-lib.ts re-exports them.
 */

/**
 * Why a terminal row stopped being offered, using the names the design gives
 * (rev 2 K2/S5 plus rev 2.1 N1's rename of `no_retry_required` to `merged`).
 *
 * - `merged` — a validated response that carries a per-key refusal list omitted
 *   the offered key: the receiver acknowledged it. The configured hub is
 *   trusted for that acknowledgement; it is not proof of delivery (design rev
 *   2.1 N4).
 * - `refused_terminal` — the receiver listed the key with a non-retryable reason.
 * - `source_deleted` — the source row is gone.
 * - `source_ineligible` — the source row is no longer eligible to send (e.g. private).
 * - `peer_unavailable` — the sender's own peer listing shows the hub absent or revoked.
 * - `retry_exhausted` — an N/T bound fired before the record was confirmed:
 *   either the receiver still refused it, or the last send was unconfirmed (a
 *   transport failure or an invalid response, `lastReason` says which). An
 *   unconfirmed send means the sender stopped offering, NOT that the record is
 *   missing: the receiver may already hold it. `bound` names the bound that
 *   fired, and is set for this resolution only.
 */
export type RetryResolution =
  | "merged"
  | "refused_terminal"
  | "source_deleted"
  | "source_ineligible"
  | "peer_unavailable"
  | "retry_exhausted";

export const RETRY_RESOLUTIONS: ReadonlySet<RetryResolution> = new Set<RetryResolution>([
  "merged",
  "refused_terminal",
  "source_deleted",
  "source_ineligible",
  "peer_unavailable",
  "retry_exhausted",
]);

/** Which bound ended a `retry_exhausted` obligation; null for every other row. */
export type RetryBound = "attempts" | "age" | "both";

export const RETRY_BOUNDS: ReadonlySet<RetryBound> = new Set<RetryBound>(["attempts", "age", "both"]);

export function isRetryResolution(value: unknown): value is RetryResolution {
  return typeof value === "string" && RETRY_RESOLUTIONS.has(value as RetryResolution);
}

export function isRetryBound(value: unknown): value is RetryBound {
  return typeof value === "string" && RETRY_BOUNDS.has(value as RetryBound);
}
