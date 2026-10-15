/**
 * memory-id-checkpoint.test.ts — flair#2218 unit lane.
 *
 * The comparison and the checkpoint file. The real-Harper end-to-end case
 * (a row deleted between checkpoint and verify → integrity failure; an
 * unreachable instance → unknown; nothing deleted → verified) lives in
 * test/integration/memory-id-checkpoint.test.ts.
 *
 * Fixtures use neutral names (agent-a, node-a) — never a real fleet host.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCheckpoint,
  compareCheckpoint,
  readCheckpointFile,
  readMemoryRowsPaged,
  unknownVerify,
  verifyCheckpoint,
  writeCheckpointFile,
  MAX_MEMORY_PAGES,
  type MemoryCheckpoint,
} from "../../src/memory-id-checkpoint.ts";

function rows(...spec: [string, string][]): { id: string; durability: string }[] {
  return spec.map(([id, durability]) => ({ id, durability }));
}

const NODE_A = "https://node-a.example.invalid";

function checkpointOf(spec: [string, string][], node = NODE_A): MemoryCheckpoint {
  return buildCheckpoint({ node, at: "2026-10-15T00:00:00.000Z", rows: rows(...spec) });
}

describe("flair#2218 — Memory id checkpoint comparison", () => {
  test("every checkpointed id still present → verified (new ids are fine)", () => {
    const cp = checkpointOf([["mem-1", "permanent"], ["mem-2", "standard"]]);
    const result = compareCheckpoint(cp, rows(["mem-1", "permanent"], ["mem-2", "standard"], ["mem-3", "standard"]));
    expect(result.outcome).toBe("verified");
    expect(result.missing).toEqual([]);
    expect(result.tierDrops).toEqual([]);
  });

  test("a checkpointed id gone → integrity failure naming it", () => {
    const cp = checkpointOf([["mem-1", "permanent"], ["mem-2", "standard"]]);
    const result = compareCheckpoint(cp, rows(["mem-1", "permanent"]));
    expect(result.outcome).toBe("integrity-failure");
    expect(result.missing).toEqual(["mem-2"]);
    expect(result.detail).toContain("mem-2");
  });

  test("a durability tier that dropped → integrity failure even when every id is present", () => {
    const cp = checkpointOf([["mem-1", "permanent"], ["mem-2", "permanent"]]);
    // Both ids still present, but one is no longer permanent.
    const result = compareCheckpoint(cp, rows(["mem-1", "permanent"], ["mem-2", "standard"]));
    expect(result.outcome).toBe("integrity-failure");
    expect(result.missing).toEqual([]);
    expect(result.tierDrops).toEqual([{ tier: "permanent", dropped: 1 }]);
  });

  test("tier counts rising (a new id) is not a failure", () => {
    const cp = checkpointOf([["mem-1", "standard"]]);
    const result = compareCheckpoint(cp, rows(["mem-1", "standard"], ["mem-2", "standard"], ["mem-3", "ephemeral"]));
    expect(result.outcome).toBe("verified");
  });

  test("the missing-id sample is capped at 10 ids", () => {
    const cp = checkpointOf(Array.from({ length: 25 }, (_, i) => [`mem-${i}`, "permanent"] as [string, string]));
    const result = compareCheckpoint(cp, rows());
    expect(result.outcome).toBe("integrity-failure");
    expect(result.missing).toHaveLength(25);
    const sampleIds = result.detail.match(/mem-\d+/g) ?? [];
    expect(sampleIds).toHaveLength(10);
  });

  test("unknown is never verified", () => {
    expect(unknownVerify("instance unreachable").outcome).toBe("unknown");
  });
});

describe("flair#2218 — paged admin read", () => {
  function pager(pages: { id: string; durability: string }[][]) {
    const calls: any[] = [];
    const opsPost = async (body: Record<string, unknown>) => {
      calls.push(body);
      return pages[Number(body.offset) / Number(body.limit)] ?? [];
    };
    return { opsPost, calls };
  }

  test("walks pages with limit/offset until a short page", async () => {
    const { opsPost, calls } = pager([
      [{ id: "a", durability: "standard" }, { id: "b", durability: "standard" }],
      [{ id: "c", durability: "permanent" }],
    ]);
    const out = await readMemoryRowsPaged(opsPost, { pageSize: 2 });
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(calls[0]).toMatchObject({ operation: "search_by_conditions", table: "Memory", limit: 2, offset: 0 });
    expect(calls[1]).toMatchObject({ offset: 2 });
  }, 5_000);

  test("a row count the pages do not add up to is a read failure, not a short list", async () => {
    const { opsPost } = pager([[{ id: "a", durability: "standard" }]]);
    await expect(readMemoryRowsPaged(opsPost, { pageSize: 1, expected: 5 })).rejects.toThrow(/did not see every row/);
  }, 5_000);

  test("a duplicate id across pages is a read failure", async () => {
    const { opsPost } = pager([
      [{ id: "a", durability: "standard" }],
      [{ id: "a", durability: "standard" }],
    ]);
    await expect(readMemoryRowsPaged(opsPost, { pageSize: 1 })).rejects.toThrow(/duplicate id/);
  }, 5_000);

  test("a body that is not a row array is a read failure", async () => {
    const opsPost = async () => ({ nope: true });
    await expect(readMemoryRowsPaged(opsPost, { pageSize: 1 })).rejects.toThrow(/neither a row array/);
  }, 5_000);

  test("the page walk has a hard upper bound", async () => {
    const opsPost = async (body: Record<string, unknown>) =>
      Array.from({ length: Number(body.limit) }, (_, i) => ({ id: `p${body.offset}-${i}`, durability: "standard" }));
    await expect(readMemoryRowsPaged(opsPost, { pageSize: 1, maxPages: MAX_MEMORY_PAGES })).rejects.toThrow(/exceeded/);
  }, 5_000);
});

describe("flair#2218 — verify refuses a different instance", () => {
  test("a checkpoint from another node is unknown, never verified", async () => {
    const cp = checkpointOf([["mem-1", "standard"]], "https://node-a.example.invalid");
    const result = await verifyCheckpoint({
      checkpoint: cp,
      target: "https://node-b.example.invalid",
      opsPost: async () => {
        throw new Error("must not be called");
      },
    });
    expect(result.outcome).toBe("unknown");
    expect(result.reason).toMatch(/node-a.*node-b/);
  });
});

describe("flair#2218 — checkpoint file", () => {
  test("the checkpoint file is written mode 0600 and round-trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-2218-unit-"));
    try {
      const path = join(dir, "checkpoint.json");
      const cp = checkpointOf([["mem-1", "permanent"], ["mem-2", "ephemeral"]]);
      writeCheckpointFile(path, cp);

      // Read first, stat LAST (a check-then-use on the same path is a race the
      // CodeQL rule flags even in tests).
      const read = readCheckpointFile(path);
      expect(read.kind).toBe("ok");
      if (read.kind === "ok") {
        expect(read.checkpoint.ids).toEqual(["mem-1", "mem-2"]);
        expect(read.checkpoint.byDurability).toEqual({ permanent: 1, persistent: 0, standard: 0, ephemeral: 1 });
        expect(read.checkpoint.host).toBe("node-a.example.invalid");
      }
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a malformed checkpoint file is unreadable, not 'absent'", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-2218-unit-"));
    try {
      const path = join(dir, "broken.json");
      writeFileSync(path, JSON.stringify({ version: 1, node: NODE_A }));
      const read = readCheckpointFile(path);
      expect(read.kind).toBe("unreadable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no Memory content is written to the checkpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-2218-unit-"));
    try {
      const path = join(dir, "checkpoint.json");
      writeCheckpointFile(path, checkpointOf([["mem-1", "standard"]]));
      const raw = readFileSync(path, "utf-8");
      expect(raw).not.toContain("content");
      expect(raw).not.toContain("durability");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
