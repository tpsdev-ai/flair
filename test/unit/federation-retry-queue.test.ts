/**
 * federation-retry-queue.test.ts — the sender's generic-Memory retry decisions
 * (flair#2797). Pure: no Harper, no filesystem.
 *
 * The list contents are compared with the receiver's own classification
 * (RETRYABLE_SKIP_REASONS): the test fails when the two name sets differ. The
 * comparison does not exercise the sender's branch, so a change there that
 * leaves the list intact passes.
 */
import { describe, expect, test } from "bun:test";
import {
  MEMORY_RETRY_BACKOFF_MS,
  MEMORY_RETRY_REASONS,
  dueRetryRows,
  retryBackoffMs,
  retryOfferProblem,
  retryRowConfirmation,
  retryRowForAttempt,
  retryRowForRefusal,
  terminalRetryRow,
  type RetryQueueRow,
} from "../../src/lib/federation-retry-queue.js";
import { retryEntryKey } from "../../src/lib/federation-retry-row.js";
import { RETRYABLE_SKIP_REASONS } from "../../resources/federation-classify.js";

const PEER = "peer-a";
const ROW = "record-a";
const NOW = "2026-10-23T12:00:00.000Z";

function pending(over: Partial<RetryQueueRow> = {}): RetryQueueRow {
  return {
    id: retryEntryKey(PEER, "Memory", ROW),
    peerId: PEER,
    table: "Memory",
    recordId: ROW,
    state: "pending",
    firstRefusedAt: NOW,
    attempts: 1,
    lastReason: "merge_target_busy",
    createdAt: NOW,
    lastAttemptAt: NOW,
    ...over,
  };
}

describe("flair#2797 — the sender's retryable reason list matches the receiver's", () => {
  test("every retryable SkipReason is in the sender list and nothing else is", () => {
    expect([...MEMORY_RETRY_REASONS].sort()).toEqual([...RETRYABLE_SKIP_REASONS].sort());
  });
});

describe("flair#2797 — retry backoff and due selection", () => {
  test("the first re-offer is immediate and later ones back off", () => {
    expect(retryBackoffMs(1)).toBe(0);
    expect(retryBackoffMs(2)).toBe(MEMORY_RETRY_BACKOFF_MS[1]);
    expect(retryBackoffMs(3)).toBe(MEMORY_RETRY_BACKOFF_MS[2]);
    expect(retryBackoffMs(99)).toBe(MEMORY_RETRY_BACKOFF_MS[MEMORY_RETRY_BACKOFF_MS.length - 1]);
    expect(retryBackoffMs(0)).toBe(0);
  });

  test("a due pending row is offered; a backoff, a terminal row and a wrong tuple are not", () => {
    const at = Date.parse(NOW);
    expect(dueRetryRows([pending()], at).map((r) => r.recordId)).toEqual([ROW]);
    expect(dueRetryRows([pending({ attempts: 2 })], at)).toEqual([]);
    expect(dueRetryRows([pending({ attempts: 2 })], at + retryBackoffMs(2))).toHaveLength(1);
    expect(dueRetryRows([pending({ state: "terminal" })], at)).toEqual([]);
    expect(dueRetryRows([pending({ id: retryEntryKey(PEER, "Memory", "another") })], at)).toEqual([]);
    expect(dueRetryRows([pending({ table: "Soul" })], at)).toEqual([]);
  });

  test("a pending row with no readable last attempt is due", () => {
    expect(dueRetryRows([pending({ lastAttemptAt: null })], Date.parse(NOW))).toHaveLength(1);
    expect(dueRetryRows([pending({ lastAttemptAt: "not-a-date" })], Date.parse(NOW))).toHaveLength(1);
  });

  test("a pending row with an unknown lastReason is not offered and is reported", () => {
    const malformed = pending({ lastReason: "not_a_reason" });
    expect(retryOfferProblem(malformed)).toBe("unknown_reason");
    expect(dueRetryRows([malformed], Date.parse(NOW) + 60_000)).toEqual([]);
    expect(retryOfferProblem(pending({ lastReason: "retry_unknown" }))).toBeNull();
    expect(dueRetryRows([pending({ lastReason: "retry_unknown" })], Date.parse(NOW))).toHaveLength(1);
  });

  test("every pending-row outcome mismatch the shared validator knows is not offered", () => {
    const at = Date.parse(NOW) + 60_000;
    // The validator's pending `outcome_mismatch` branches: a resolution, and a bound.
    for (const malformed of [
      pending({ resolution: "merged" }),
      pending({ resolution: "refused_terminal" }),
      pending({ bound: "attempts" }),
    ]) {
      expect(retryOfferProblem(malformed)).toBe("outcome_mismatch");
      expect(dueRetryRows([malformed], at)).toEqual([]);
    }
    // Its other problem kinds: wrong key, unknown state and unknown reason.
    const otherKinds: Array<[RetryQueueRow, "id_mismatch" | "wrong_state" | "unknown_reason"]> = [
      [pending({ id: retryEntryKey(PEER, "Memory", "another") }), "id_mismatch"],
      [pending({ state: "half-open" }), "wrong_state"],
      [pending({ lastReason: "not_a_reason" }), "unknown_reason"],
    ];
    for (const [malformed, problem] of otherKinds) {
      expect(retryOfferProblem(malformed)).toBe(problem);
      expect(dueRetryRows([malformed], at)).toEqual([]);
    }
  });
});

describe("flair#2797 — retry row transitions", () => {
  test("a first refusal creates a pending row with attempts 1", () => {
    const row = retryRowForRefusal({ peerId: PEER, recordId: ROW, reason: "merge_target_busy", nowIso: NOW });
    expect(row).toEqual({
      id: retryEntryKey(PEER, "Memory", ROW),
      peerId: PEER,
      table: "Memory",
      recordId: ROW,
      state: "pending",
      firstRefusedAt: NOW,
      attempts: 1,
      lastReason: "merge_target_busy",
      lastAttemptAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  test("a later refusal keeps the first timestamp and increments attempts", () => {
    const first = pending({ attempts: 2, firstRefusedAt: "2026-10-20T00:00:00.000Z", createdAt: "2026-10-20T00:00:00.000Z" });
    const row = retryRowForRefusal({ peerId: PEER, recordId: ROW, reason: "merge_target_busy", nowIso: NOW, existing: first });
    expect(row.firstRefusedAt).toBe("2026-10-20T00:00:00.000Z");
    expect(row.createdAt).toBe("2026-10-20T00:00:00.000Z");
    expect(row.attempts).toBe(3);
  });

  test("an attempt is reserved before the send and kept if the send is unconfirmed", () => {
    const reserved = retryRowForAttempt(pending({ attempts: 1, firstRefusedAt: "2026-10-20T00:00:00.000Z" }), NOW);
    expect(reserved.attempts).toBe(2);
    expect(reserved.lastAttemptAt).toBe(NOW);
    expect(reserved.firstRefusedAt).toBe("2026-10-20T00:00:00.000Z");
    expect(reserved.lastReason).toBe("merge_target_busy");
    expect(reserved.state).toBe("pending");
  });

  test("a refusal of an offer whose attempt was reserved does not count it twice", () => {
    const reserved = retryRowForAttempt(pending({ attempts: 1 }), NOW) as unknown as RetryQueueRow;
    const row = retryRowForRefusal({
      peerId: PEER,
      recordId: ROW,
      reason: "merge_target_busy",
      nowIso: NOW,
      existing: reserved,
      attemptReserved: true,
    });
    expect(row.attempts).toBe(2);
  });

  test("a read-back must echo the compared fields, including attempts", () => {
    const record = retryRowForAttempt(pending({ attempts: 1 }), NOW);
    const stored = { ...record, attempts: 1 };
    expect(retryRowConfirmation(record, stored)).toBe("attempts");
    expect(retryRowConfirmation(record, { ...record })).toBeNull();
    expect(retryRowConfirmation(record, { ...record, state: "terminal", attempts: 1 })).toBe("state");
    const terminal = terminalRetryRow(pending({ attempts: 4 }), "merged", NOW);
    expect(retryRowConfirmation(terminal, { ...terminal, resolution: "refused_terminal" })).toBe("resolution");
    expect(retryRowConfirmation(terminal, { ...terminal })).toBeNull();
  });

  test("a terminal row carries the declared fields and a null bound", () => {
    const row = terminalRetryRow(pending({ attempts: 4 }), "merged", NOW);
    expect(row.state).toBe("terminal");
    expect(row.resolution).toBe("merged");
    expect(row.bound).toBeNull();
    expect(row.completedAt).toBe(NOW);
    expect(row.attempts).toBe(4);
    expect(Object.keys(row).sort()).toEqual(
      ["attempts", "bound", "completedAt", "createdAt", "firstRefusedAt", "id", "lastAttemptAt", "lastReason", "peerId", "recordId", "resolution", "state", "table", "updatedAt"].sort(),
    );
  });
});
