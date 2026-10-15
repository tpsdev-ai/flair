import { describe, expect, it } from "bun:test";

describe("flair#2455 slice 2 — the shipped sender count parser", () => {
  it("the shipped sender's count parser ignores `refused`", async () => {
    const { parseSyncBatchCounts } = await import("../../src/commands/federation");
    const body = {
      merged: 1,
      skipped: 3,
      skippedReasons: { future_timestamp: 1, no_op_same_hash: 1, unknown_table: 1 },
      refused: [
        { table: "Memory", id: "a", reason: "future_timestamp" },
        { table: "Memory", id: "b", reason: "no_op_same_hash" },
        { table: "Presence", id: "c", reason: "unknown_table" },
      ],
      total: 4,
    };
    expect(parseSyncBatchCounts(body, 4)).toEqual({ merged: 1, skipped: 3 });
  });

});
