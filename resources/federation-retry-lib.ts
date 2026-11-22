/**
 * federation-retry-lib.ts — pure types and helpers for the sender-owned
 * federation retry table (`FederationRetry`), flair#2455 design rev 2 K2/2.1.
 *
 * No Harper imports: the tuple-key encoding and the state/outcome vocabulary
 * are unit-testable directly, the same reason federation-classify.ts is
 * DB-free. The Harper resource, the admin gates and the atomic transition live
 * in resources/FederationRetry.ts.
 */
import { isSkipReason, type SkipReason } from "./federation-classify.js";
import {
  RETRY_BOUNDS,
  RETRY_RESOLUTIONS,
  isRetryBound,
  isRetryResolution,
  parseRetryEntryKey,
  retryEntryKey,
  retryRowProblem as retryRowProblemShared,
  type RetryBound,
  type RetryResolution,
  type RetryRowProblem,
} from "../src/lib/federation-retry-row.js";

export { parseRetryEntryKey, retryEntryKey };
export { RETRY_BOUNDS, RETRY_RESOLUTIONS, isRetryBound, isRetryResolution };
export type { RetryBound, RetryResolution };

/** A retry obligation's lifecycle state. `pending` is the only non-terminal state. */
export type RetryState = "pending" | "terminal";

/** A reason the SENDER derived locally, never stated by the receiver. Kept out
 * of {@link SkipReason} because it describes the transfer, not the record.
 */
export type LocalRetryReason = "transport_failure" | "invalid_response" | "retry_unknown";

export const LOCAL_RETRY_REASONS: ReadonlySet<LocalRetryReason> = new Set<LocalRetryReason>([
  "transport_failure",
  "invalid_response",
  "retry_unknown",
]);

/** What a retry row's `lastReason` may hold: the closed SkipReason union, or a local reason. */
export type RetryLastReason = SkipReason | LocalRetryReason;

/**
 * Every field the `FederationRetry` schema declares (schemas/federation.graphql),
 * in schema order. The table is `@sealed`, so Harper refuses a write that
 * names any other field; the transition builds its write from this list rather
 * than spreading a stored row.
 */
export const RETRY_ROW_FIELDS = [
  "id",
  "peerId",
  "table",
  "recordId",
  "state",
  "firstRefusedAt",
  "attempts",
  "episodeId",
  "recordFingerprint",
  "lastReason",
  "lastAttemptSyncId",
  "lastAttemptAt",
  "completedAt",
  "resolution",
  "bound",
  "createdAt",
  "updatedAt",
] as const;

export type RetryRowField = (typeof RETRY_ROW_FIELDS)[number];

/** Copy only the declared fields of `row` that hold a value; anything else is dropped. */
export function pickRetryRowFields(row: Record<string, unknown>): Partial<Record<RetryRowField, unknown>> {
  const out: Partial<Record<RetryRowField, unknown>> = {};
  for (const field of RETRY_ROW_FIELDS) {
    const value = row[field];
    if (value !== undefined) out[field] = value;
  }
  return out;
}

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
 * - `unknown_reason` — `lastReason` is set but is neither a SkipReason nor a
 *   local reason.
 * - `outcome_mismatch` — a pending row carries a resolution or a bound, or a
 *   terminal row's resolution is unknown or its bound breaks the rule that
 *   `bound` is set exactly for `retry_exhausted`.
 */
export type { RetryRowProblem };

/**
 * See {@link retryRowProblemShared}: the shared convention check, with the
 * receiver's full reason vocabulary.
 */
export function retryRowProblem(row: Record<string, unknown>): RetryRowProblem | null {
  return retryRowProblemShared(
    row,
    (value) => isSkipReason(value) || LOCAL_RETRY_REASONS.has(value as LocalRetryReason),
  );
}
