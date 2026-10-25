/**
 * federation-retry-queue.ts — the generic-Memory sender's retry bookkeeping.
 *
 * Pure and DB-free, so the backoff and the row transitions are unit-testable.
 * `runFederationSyncOnce` (src/commands/federation.ts) reads and writes the
 * `FederationRetry` table through its local operations endpoint; this module
 * decides what a refusal means for one row.
 *
 * The receiver's response names each refused record and its reason
 * (`refused`). A reason in {@link MEMORY_RETRY_REASONS} may clear on a later
 * offer, so the sender keeps one pending row for that (hub, Memory, record)
 * tuple and offers the record again on a later cycle while that pending row is
 * due and the source row is still eligible, independent of its own cursor. A
 * pending row can become private, disappear or fail validation before it is
 * offered again. Any other reason is final: an existing pending row becomes
 * `refused_terminal`, and the retry path in one sender run does not select a
 * terminal row again (a later row update can still select it through the
 * ordinary cursor; concurrent sender runs for one peer are not serialized — a
 * separate issue).
 */
import { retryEntryKey, retryRowProblem } from "./federation-retry-row.js";

/**
 * The global retryable names the sender recognizes. Mirrors the
 * `retryable` entries of SKIP_REASON_CLASS in resources/federation-classify.ts;
 * not every name is raised by the generic Memory path
 * (`presence_agent_not_replicated` comes from the Presence receipt path).
 * test/unit/federation-retry-queue.test.ts fails when the two lists differ.
 */
export const MEMORY_RETRY_REASONS: ReadonlySet<string> = new Set([
  "future_timestamp",
  "unknown_originator_key",
  "merge_target_changed",
  "merge_target_busy",
  "merge_error",
  "presence_agent_not_replicated",
]);

/** Every `lastReason` a pending Memory row may hold: a retryable refusal name,
 *  or the sender's own `retry_unknown`. */
export const MEMORY_PENDING_REASONS: ReadonlySet<string> = new Set([
  ...MEMORY_RETRY_REASONS,
  "retry_unknown",
]);

/** Every field the FederationRetry schema declares, in schema order. */
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

/**
 * The fields a terminal outcome sets (terminalRetryRow) that a pending row
 * leaves null. The operations-API `upsert` merges into the stored row, so the
 * pending-row builders below write each of them as null.
 */
export const RETRY_TERMINAL_FIELDS = ["resolution", "completedAt", "bound"] as const;

/**
 * Wait before offering a pending row again, by the number of attempts it has
 * reserved. The first re-offer is immediate (the lock or change that refused
 * it may already be gone); later ones back off. The last entry repeats.
 */
export const MEMORY_RETRY_BACKOFF_MS = [0, 30_000, 300_000, 1_800_000] as const;

export function retryBackoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), MEMORY_RETRY_BACKOFF_MS.length) - 1;
  return MEMORY_RETRY_BACKOFF_MS[index];
}

export interface RetryQueueRow {
  id: string;
  peerId: string;
  table: string;
  recordId: string;
  state: string;
  attempts?: number;
  lastReason?: string | null;
  lastAttemptAt?: string | null;
  firstRefusedAt?: string;
  createdAt?: string;
  [field: string]: unknown;
}

/** Why a row must not be offered, or null when it keeps the sender's pending-row conventions. */
export type RetryOfferProblem = "wrong_state" | "wrong_table" | "id_mismatch" | "unknown_reason" | "outcome_mismatch";

export function retryOfferProblem(row: RetryQueueRow, table = "Memory"): RetryOfferProblem | null {
  if (row.state !== "pending") return "wrong_state";
  if (row.table !== table) return "wrong_table";
  if (typeof row.peerId !== "string" || typeof row.recordId !== "string") return "id_mismatch";
  try {
    if (retryEntryKey(row.peerId, row.table, row.recordId) !== row.id) return "id_mismatch";
  } catch {
    return "id_mismatch";
  }
  // The reader and the transition call a pending row carrying an outcome
  // malformed; the sender selects rows from the same table, so it applies
  // that shared rule rather than deciding on its own fields alone.
  const sharedProblem = retryRowProblem(
    row as Record<string, unknown>,
    (value) => typeof value === "string" && MEMORY_PENDING_REASONS.has(value),
  );
  if (sharedProblem === "outcome_mismatch") return "outcome_mismatch";
  if (sharedProblem === "id_mismatch") return "id_mismatch";
  if (sharedProblem === "unknown_state") return "wrong_state";
  // `retry_unknown` is legitimate here and is not a SkipReason, so the sender
  // keeps its own stricter pending-reason list.
  if (typeof row.lastReason !== "string" || !MEMORY_PENDING_REASONS.has(row.lastReason)) return "unknown_reason";
  return null;
}

/** The pending rows whose backoff has elapsed at `nowMs`. A malformed row is excluded by this retry selector. */
export function dueRetryRows(rows: readonly RetryQueueRow[], nowMs: number, table = "Memory"): RetryQueueRow[] {
  return rows.filter((row) => {
    const problem = retryOfferProblem(row, table);
    if (problem !== null) {
      // Reported by the caller, not silently treated as absent.
      return false;
    }
    const attempts = typeof row.attempts === "number" && Number.isSafeInteger(row.attempts) && row.attempts > 0 ? row.attempts : 1;
    const last = Date.parse(row.lastAttemptAt ?? "");
    // A pending row with no readable last attempt is due: the alternative is
    // never offering it again.
    if (!Number.isFinite(last)) return true;
    return nowMs >= last + retryBackoffMs(attempts);
  });
}

export interface RefusalRowInput {
  peerId: string;
  recordId: string;
  reason: string;
  nowIso: string;
  existing?: RetryQueueRow | null;
  /** The offer that produced this outcome already reserved its attempt. */
  attemptReserved?: boolean;
}

/**
 * The row to write for a retryable refusal. A first refusal creates a pending
 * row with `attempts: 1`; a later one keeps `firstRefusedAt` and `createdAt`,
 * increments `attempts` and moves `lastAttemptAt`, unless that offer already
 * reserved its attempt before sending. `attempts` counts reserved attempts
 * within one sender run per peer at a time, not wire sends; concurrent sender
 * runs for one peer are not serialized (a separate issue).
 */
export function retryRowForRefusal(input: RefusalRowInput): Record<string, unknown> {
  const id = retryEntryKey(input.peerId, "Memory", input.recordId);
  const prior = input.existing ?? null;
  const priorAttempts = prior && typeof prior.attempts === "number" && Number.isSafeInteger(prior.attempts) && prior.attempts > 0
    ? prior.attempts
    : 0;
  const row: Record<string, unknown> = {
    id,
    peerId: input.peerId,
    table: "Memory",
    recordId: input.recordId,
    state: "pending",
    firstRefusedAt: prior?.firstRefusedAt ?? input.nowIso,
    attempts: priorAttempts + (input.attemptReserved ? 0 : 1),
    lastReason: input.reason,
    lastAttemptAt: input.nowIso,
    createdAt: prior?.createdAt ?? input.nowIso,
    updatedAt: input.nowIso,
  };
  for (const field of RETRY_TERMINAL_FIELDS) row[field] = null;
  return row;
}

/**
 * The row that reserves one offer attempt before a pending row is sent. The
 * caller persists it; an unconfirmed send keeps it, so the next cycle waits
 * out this attempt's backoff instead of re-offering at once.
 */
export function retryRowForAttempt(row: RetryQueueRow, nowIso: string): Record<string, unknown> {
  const id = retryEntryKey(row.peerId, "Memory", row.recordId);
  const priorAttempts = typeof row.attempts === "number" && Number.isSafeInteger(row.attempts) && row.attempts > 0
    ? row.attempts
    : 0;
  const out: Record<string, unknown> = {
    id,
    peerId: row.peerId,
    table: "Memory",
    recordId: row.recordId,
    state: "pending",
    firstRefusedAt: row.firstRefusedAt ?? nowIso,
    attempts: priorAttempts + 1,
    lastAttemptAt: nowIso,
    createdAt: row.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
  if (typeof row.lastReason === "string") out.lastReason = row.lastReason;
  for (const field of RETRY_TERMINAL_FIELDS) out[field] = null;
  return out;
}

/** The fields a persisted retry row must carry back for the obligation to hold. */
const CONFIRM_FIELDS = [
  "id",
  "peerId",
  "table",
  "recordId",
  "state",
  "attempts",
  "lastReason",
  "lastAttemptAt",
  "firstRefusedAt",
  "createdAt",
  "resolution",
  "completedAt",
  "updatedAt",
  "bound",
] as const;

/**
 * The first of `id`, `peerId`, `table`, `recordId`, `state`, `attempts`,
 * `lastReason`, `lastAttemptAt`, `firstRefusedAt`, `createdAt`, `resolution`,
 * `completedAt`, `updatedAt` and `bound` (CONFIRM_FIELDS, in that order) that
 * the written record carries and the stored row does not echo; then, for a
 * stored row in state `pending`, the first of RETRY_TERMINAL_FIELDS it holds a
 * non-null value for, whether or not the record names it; `row` when the
 * stored row is null; otherwise null. A read-back that only agrees on `state`
 * and `lastReason` can hide an attempt that was never incremented.
 */
export function retryRowConfirmation(record: Record<string, unknown>, stored: Record<string, unknown> | null): string | null {
  if (stored === null) return "row";
  for (const field of CONFIRM_FIELDS) {
    if (!(field in record)) continue;
    const expected = record[field] ?? null;
    const actual = stored[field] ?? null;
    if (actual !== expected) return field;
  }
  if (stored.state === "pending") {
    for (const field of RETRY_TERMINAL_FIELDS) {
      if ((stored[field] ?? null) !== null) return field;
    }
  }
  return null;
}

/** A pending row's terminal transition, carrying only declared fields. */
export function terminalRetryRow(
  row: RetryQueueRow,
  resolution: string,
  nowIso: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { id: row.id };
  for (const field of RETRY_ROW_FIELDS) {
    const value = row[field];
    if (value !== undefined) out[field] = value;
  }
  out.state = "terminal";
  out.resolution = resolution;
  out.bound = null;
  out.completedAt = nowIso;
  out.updatedAt = nowIso;
  return out;
}
