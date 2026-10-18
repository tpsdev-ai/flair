import { describe, expect, it } from "bun:test";

const tables = ["Memory", "Soul", "Agent", "Relationship", "Presence"] as const;

describe("flair#2667 — merged + skipped is at most the records offered", () => {
  it("the shared parser rejects merged 3 + skipped 3 for a 3-record batch", async () => {
    const { parseSyncBatchCounts, describeSyncBatchCountsRejection } = await import("../../src/commands/federation");
    for (const table of tables) {
      expect(parseSyncBatchCounts({ merged: 3, skipped: 3 }, 3), table).toBeNull();
      expect(describeSyncBatchCountsRejection({ merged: 3, skipped: 3 }, 3, table)).toBe(
        `${table}: merged 3 + skipped 3 exceeds 3 records offered`,
      );
    }
  });

  it("the shared parser accepts a sum below the batch size without outcome lists", async () => {
    const { parseSyncBatchCounts } = await import("../../src/commands/federation");
    for (const table of tables) {
      expect(parseSyncBatchCounts({ merged: 1, skipped: 1 }, 3), table).toEqual({ merged: 1, skipped: 1 });
      expect(parseSyncBatchCounts({ merged: 2, skipped: 0 }, 3), table).toEqual({ merged: 2, skipped: 0 });
      expect(parseSyncBatchCounts({ merged: 0, skipped: 0 }, 3), table).toEqual({ merged: 0, skipped: 0 });
    }
  });

  it("names the table and the bound, never a value that is not an in-range count", async () => {
    const { describeSyncBatchCountsRejection } = await import("../../src/commands/federation");
    expect(describeSyncBatchCountsRejection({ merged: 4, skipped: 0 }, 3, "Memory")).toBe(
      "Memory: merged/skipped are not counts from 0 to 3",
    );
    expect(describeSyncBatchCountsRejection({ merged: "3", skipped: 3 }, 3, "Soul")).toBe(
      "Soul: merged/skipped are not counts from 0 to 3",
    );
  });
});
