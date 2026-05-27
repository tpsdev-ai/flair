import { describe, expect, test } from "bun:test";
import { classifyRecord } from "../../resources/federation-classify.js";

// classifyRecord is the pure decision function extracted from FederationSync.post.
// Centralizing the skip-vs-merge decision lets us categorize skips for
// observability — previously every skip path collapsed into `skipped++` with
// no operator-visible reason ("green dashboard while burning").

describe("classifyRecord — skip categorization", () => {
  const knownTables = new Set(["Memory", "Soul", "Agent", "Relationship"]);
  const receiverId = "flair_hub_1";
  const now = new Date("2026-05-27T00:00:00Z");

  function makeRecord(over: Record<string, any> = {}): any {
    return {
      table: "Memory",
      id: "mem-1",
      data: { id: "mem-1", content: "hi" },
      updatedAt: "2026-05-27T00:00:00Z",
      originatorInstanceId: receiverId,
      ...over,
    };
  }

  test("merges valid spoke-originated record", () => {
    const r = makeRecord({ originatorInstanceId: "spoke-1" });
    const result = classifyRecord(r, "spoke", "spoke-1", null, knownTables, now);
    expect(result).toEqual({ action: "merge", originator: "spoke-1" });
  });

  test("hub may relay records originated by another peer", () => {
    const r = makeRecord({ originatorInstanceId: "spoke-2" });
    // Receiver is hub; sender is a hub-role peer (e.g., spokes' shared hub
    // relaying spoke-2's record).
    const result = classifyRecord(r, "hub", receiverId, null, knownTables, now);
    expect(result).toEqual({ action: "merge", originator: "spoke-2" });
  });

  test("skip: unknown_table when table name not in tableMap", () => {
    const r = makeRecord({ table: "NotARealTable" });
    const result = classifyRecord(r, "spoke", receiverId, null, knownTables, now);
    expect(result).toEqual({ action: "skip", reason: "unknown_table" });
  });

  test("skip: non_originator when spoke pushes a record it didn't originate", () => {
    const r = makeRecord({ originatorInstanceId: "some-other-spoke" });
    // peer is a spoke (not hub), so it cannot relay records.
    const result = classifyRecord(r, "spoke", receiverId, null, knownTables, now);
    expect(result).toEqual({ action: "skip", reason: "non_originator" });
  });

  test("skip: future_timestamp when updatedAt > 5min in the future", () => {
    const tenMinFromNow = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    const r = makeRecord({ updatedAt: tenMinFromNow });
    const result = classifyRecord(r, "spoke", receiverId, null, knownTables, now);
    expect(result).toEqual({ action: "skip", reason: "future_timestamp" });
  });

  test("allows: timestamps within the 5-minute ceiling", () => {
    const fourMinFromNow = new Date(now.getTime() + 4 * 60 * 1000).toISOString();
    const r = makeRecord({ updatedAt: fourMinFromNow });
    const result = classifyRecord(r, "spoke", receiverId, null, knownTables, now);
    expect(result.action).toBe("merge");
  });

  test("skip: no_op_same_hash when contentHash matches and remote not strictly newer", () => {
    const r = makeRecord({
      data: { id: "mem-1", content: "hi", contentHash: "h1" },
      updatedAt: "2026-05-27T00:00:00Z",
    });
    const local = { id: "mem-1", contentHash: "h1", updatedAt: "2026-05-27T00:00:00Z" };
    const result = classifyRecord(r, "spoke", receiverId, local, knownTables, now);
    expect(result).toEqual({ action: "skip", reason: "no_op_same_hash" });
  });

  test("merges: same contentHash but remote is strictly newer (LWW progress)", () => {
    const r = makeRecord({
      data: { id: "mem-1", content: "hi", contentHash: "h1" },
      updatedAt: "2026-05-27T00:00:01Z",
    });
    const local = { id: "mem-1", contentHash: "h1", updatedAt: "2026-05-27T00:00:00Z" };
    const result = classifyRecord(r, "spoke", receiverId, local, knownTables, now);
    expect(result.action).toBe("merge");
  });

  test("merges: different contentHash even if remote not newer (LWW field overwrites)", () => {
    const r = makeRecord({
      data: { id: "mem-1", content: "hi", contentHash: "h2" },
      updatedAt: "2026-05-27T00:00:00Z",
    });
    const local = { id: "mem-1", contentHash: "h1", updatedAt: "2026-05-27T00:00:00Z" };
    const result = classifyRecord(r, "spoke", receiverId, local, knownTables, now);
    expect(result.action).toBe("merge");
  });

  test("originator defaults to receiverInstanceId when record omits it", () => {
    // If the spoke didn't include originatorInstanceId, FederationSync treats
    // the record as if the SENDER originated it — that's the spoke's own ID.
    const r = makeRecord({ originatorInstanceId: undefined });
    const result = classifyRecord(r, "spoke", "spoke-1", null, knownTables, now);
    // receiverInstanceId is spoke-1 in this test, so default originator is spoke-1
    // → spoke-1 === receiver, NOT non_originator skip.
    expect(result).toEqual({ action: "merge", originator: "spoke-1" });
  });
});
