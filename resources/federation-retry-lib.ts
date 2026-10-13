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

/** A retry obligation's lifecycle state. `pending` is the only non-terminal state. */
export type RetryState = "pending" | "terminal";

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

/**
 * A reason the SENDER derived locally, never stated by the receiver. Kept out
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

export function isRetryResolution(value: unknown): value is RetryResolution {
  return typeof value === "string" && RETRY_RESOLUTIONS.has(value as RetryResolution);
}

export function isRetryBound(value: unknown): value is RetryBound {
  return typeof value === "string" && RETRY_BOUNDS.has(value as RetryBound);
}

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
 * Encode the (peerId, table, recordId) tuple as the row's primary key.
 *
 * A JSON array join, never a bare concatenation: a naive `${peerId}${table}
 * ${recordId}` collides (peer `a` + table `bc` is peer `ab` + table `c`), and
 * peer and record ids are arbitrary strings off the wire, including legacy
 * `.content`-suffixed ids. JSON quotes and escapes each component, so distinct
 * tuples encode to distinct strings and the components round-trip exactly.
 *
 * Every component must be a non-empty string; a missing component is a caller
 * bug, not a row to write, so this THROWS rather than mint a malformed key.
 */
export function retryEntryKey(peerId: string, table: string, recordId: string): string {
  for (const [name, value] of [
    ["peerId", peerId],
    ["table", table],
    ["recordId", recordId],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`federation retry: ${name} must be a non-empty string`);
    }
  }
  return JSON.stringify([peerId, table, recordId]);
}

/** Decode {@link retryEntryKey}'s output, or null when `id` is not a retry key. */
export function parseRetryEntryKey(id: string): { peerId: string; table: string; recordId: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(id);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return null;
  const [peerId, table, recordId] = parsed;
  if (typeof peerId !== "string" || typeof table !== "string" || typeof recordId !== "string") return null;
  if (peerId.length === 0 || table.length === 0 || recordId.length === 0) return null;
  return { peerId, table, recordId };
}

/**
 * Why a stored row breaks a sender convention, or null when it keeps them all.
 *
 * The schema does not enforce these rules: `@sealed` refuses undeclared field
 * NAMES only, and every declared field is a plain String or Int. They are
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
export type RetryRowProblem = "id_mismatch" | "unknown_state" | "unknown_reason" | "outcome_mismatch";

export function retryRowProblem(row: Record<string, unknown>): RetryRowProblem | null {
  let expectedId: string | null = null;
  try {
    expectedId = retryEntryKey(row.peerId as string, row.table as string, row.recordId as string);
  } catch {
    expectedId = null;
  }
  if (expectedId === null || row.id !== expectedId) return "id_mismatch";
  if (row.state !== "pending" && row.state !== "terminal") return "unknown_state";
  if (row.lastReason != null && !isSkipReason(row.lastReason) && !LOCAL_RETRY_REASONS.has(row.lastReason as LocalRetryReason)) {
    return "unknown_reason";
  }
  if (row.state === "pending") {
    if (row.resolution != null || row.bound != null) return "outcome_mismatch";
  } else {
    if (!isRetryResolution(row.resolution)) return "outcome_mismatch";
    const exhausted = row.resolution === "retry_exhausted";
    if (exhausted ? !isRetryBound(row.bound) : row.bound != null) return "outcome_mismatch";
  }
  return null;
}
