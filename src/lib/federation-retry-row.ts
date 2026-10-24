/**
 * federation-retry-row.ts — the sender-convention check for a retry row.
 *
 * Pure and DB-free. The receiver's admin/read resources and the generic-Memory
 * sender both classify rows with this function, so a row the reader calls
 * malformed is never offered. The reason vocabulary differs: the caller passes
 * the predicate its own path uses (`isSkipReason` plus local reasons for a
 * Harper resource; the sender's stricter pending-row list).
 */
import { retryEntryKey } from "./federation-retry-key.js";
import { isRetryBound, isRetryResolution } from "./federation-retry-vocab.js";

/**
 * Why a stored row breaks a sender convention, or null when it keeps them all.
 *
 * The schema does not enforce these rules: `@sealed` refuses undeclared field
 * NAMES only, and every declared field is a plain ID, String or Int. They are
 * the conventions the sender writes by, so the reader and the transition check
 * them and treat a row that breaks one as malformed: never pending, never
 * transitioned.
 *
 * - `id_mismatch` — `id` is not retryEntryKey(peerId, table, recordId).
 * - `unknown_state` — `state` is neither `pending` nor `terminal`.
 * - `unknown_reason` — `lastReason` is set but `isKnownReason` rejects it.
 * - `outcome_mismatch` — a pending row carries a resolution or a bound, or a
 *   terminal row's resolution is unknown or its bound breaks the rule that
 *   `bound` is set exactly for `retry_exhausted`.
 */
export type RetryRowProblem = "id_mismatch" | "unknown_state" | "unknown_reason" | "outcome_mismatch";

export function retryRowProblem(
  row: Record<string, unknown>,
  isKnownReason: (value: unknown) => boolean,
): RetryRowProblem | null {
  let expectedId: string | null = null;
  try {
    expectedId = retryEntryKey(row.peerId as string, row.table as string, row.recordId as string);
  } catch {
    expectedId = null;
  }
  if (expectedId === null || row.id !== expectedId) return "id_mismatch";
  if (row.state !== "pending" && row.state !== "terminal") return "unknown_state";
  if (row.lastReason != null && !isKnownReason(row.lastReason)) return "unknown_reason";
  if (row.state === "pending") {
    if (row.resolution != null || row.bound != null) return "outcome_mismatch";
  } else {
    if (!isRetryResolution(row.resolution)) return "outcome_mismatch";
    const exhausted = row.resolution === "retry_exhausted";
    if (exhausted ? !isRetryBound(row.bound) : row.bound != null) return "outcome_mismatch";
  }
  return null;
}
