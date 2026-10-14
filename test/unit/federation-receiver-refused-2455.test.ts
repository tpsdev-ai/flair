// flair#2455 slice 2 — the receiver's added `refused` field is additive.
//
// The sender acts on `refused` only in a later slice. An old sender reads
// exactly `{merged, skipped}` and must keep working against the widened
// response. `parseSyncBatchCounts` is the shipped sender's parser; a
// pre-slice-1 sender casts the JSON to `{merged, skipped}`. Both ignore the
// extra field, so adding it is not a wire break in the send direction.
import { describe, expect, it } from "bun:test";

describe("flair#2455 slice 2 — the added `refused` field is backward compatible", () => {
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

  it("a pre-slice-1 sender's raw `{merged, skipped}` cast also ignores `refused`", () => {
    const body = { merged: 2, skipped: 0, refused: [], total: 2 };
    const cast = body as { merged: number; skipped: number };
    expect(cast.merged).toBe(2);
    expect(cast.skipped).toBe(0);
  });
});
