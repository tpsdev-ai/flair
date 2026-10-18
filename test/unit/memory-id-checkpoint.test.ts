/** Memory checkpoint comparison, paging and file tests. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCheckpoint,
  compareCheckpoint,
  readCheckpointFile,
  readMemoryRowsPaged,
  readTableByIdPaged,
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
  test("ids present without a tier-count drop → verified (new ids are fine)", () => {
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
  function pager(pages: { id: string; durability: string }[][], after?: number) {
    const calls: any[] = [];
    let page = 0;
    const count = pages.flat().length;
    const opsPost = async (body: Record<string, unknown>) => {
      calls.push(body);
      if (body.operation === "describe_table") return { record_count: page === 0 ? count : after ?? count };
      return pages[page++] ?? [];
    };
    return { opsPost, calls };
  }

  test("walks primary-key pages and projects only id and durability", async () => {
    const { opsPost, calls } = pager([
      [{ id: "a", durability: "standard" }, { id: "b'quoted", durability: "standard" }],
      [{ id: "c", durability: "permanent" }],
    ]);
    const out = await readMemoryRowsPaged(opsPost, { pageSize: 2 });
    expect(out.map((r) => r.id)).toEqual(["a", "b'quoted", "c"]);
    expect(calls).toEqual([
      { operation: "describe_table", database: "flair", table: "Memory", exact_count: true },
      { operation: "sql", sql: "SELECT id, durability FROM flair.Memory ORDER BY id LIMIT 2" },
      { operation: "sql", sql: "SELECT id, durability FROM flair.Memory WHERE id > 'b''quoted' ORDER BY id LIMIT 2" },
      { operation: "describe_table", database: "flair", table: "Memory", exact_count: true },
    ]);
  }, 5_000);

  test("a row-count mismatch refuses the checkpoint", async () => {
    const { opsPost } = pager([[{ id: "a", durability: "standard" }]]);
    await expect(readMemoryRowsPaged(opsPost, { pageSize: 1, expected: 5 })).rejects.toThrow("writes during checkpoint");
  }, 5_000);

  test("a backslash cursor is refused before it can alter the SQL predicate", async () => {
    const { opsPost, calls } = pager([[{ id: "x\\' OR 1=1 --", durability: "standard" }]]);
    await expect(readMemoryRowsPaged(opsPost, { pageSize: 1 })).rejects.toThrow("unsupported backslash");
    expect(calls.filter((body) => body.operation === "sql")).toHaveLength(1);
  }, 5_000);

  test("a changed exact count after the final page refuses the checkpoint", async () => {
    const { opsPost } = pager([[{ id: "a", durability: "standard" }]], 2);
    await expect(readMemoryRowsPaged(opsPost)).rejects.toThrow("writes during checkpoint");
  }, 5_000);

  test("a duplicate id across pages is a read failure", async () => {
    const { opsPost } = pager([
      [{ id: "a", durability: "standard" }],
      [{ id: "a", durability: "standard" }],
    ]);
    await expect(readMemoryRowsPaged(opsPost, { pageSize: 1 })).rejects.toThrow(/duplicate id/);
  }, 5_000);

  test("a body that is not a row array is a read failure", async () => {
    const opsPost = async (body: Record<string, unknown>) => body.operation === "describe_table" ? { record_count: 1 } : { nope: true };
    await expect(readMemoryRowsPaged(opsPost, { pageSize: 1 })).rejects.toThrow(/neither a row array/);
  }, 5_000);

  test("the page walk has a hard upper bound", async () => {
    let counter = 0;
    const opsPost = async (body: Record<string, unknown>) =>
      body.operation === "describe_table" ? { record_count: MAX_MEMORY_PAGES + 1 } : [{ id: String(counter++).padStart(4, "0"), durability: "standard" }];
    await expect(readMemoryRowsPaged(opsPost, { pageSize: 1, maxPages: MAX_MEMORY_PAGES })).rejects.toThrow(/page cap/);
  }, 5_000);
});

describe("flair#2670 — parity between capped and uncapped walks under a balanced behind-cursor write (shared no-snapshot limit, #2679)", () => {
  function store(count: number, mutate?: (live: Map<string, { id: string; durability: string }>, page: number) => void) {
    const initial = Array.from({ length: count }, (_, i) => ({ id: `mem-${String(i).padStart(4, "0")}`, durability: "standard" }));
    const live = new Map(initial.map(row => [row.id, row]));
    const queries: string[] = [];
    const opsPost = async (body: Record<string, unknown>) => {
      if (body.operation === "describe_table") return { record_count: live.size };
      const sql = String(body.sql);
      const match = /^SELECT (?:id|id, durability) FROM flair\.Memory(?: WHERE id > '((?:[^']|'')*)')? ORDER BY id LIMIT (\d+)$/.exec(sql);
      if (!match) throw new Error(`unexpected SQL: ${sql}`);
      const cursor = match[1]?.replace(/''/g, "'");
      const batch = [...live.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        .filter(row => cursor === undefined || row.id > cursor).slice(0, Number(match[2]));
      queries.push(sql);
      mutate?.(live, queries.length);
      return batch;
    };
    return { initial, live, queries, opsPost };
  }

  test("a full final page at the cap is accepted when a read after its last id returns no row and the rows read equal the count, the same evidence an uncapped walk ends on", async () => {
    const { initial, queries, opsPost } = store(MAX_MEMORY_PAGES * 2);
    const out = await readMemoryRowsPaged(opsPost, { pageSize: 2 });
    expect(out.map(row => row.id)).toEqual(initial.map(row => row.id));
    expect(queries).toHaveLength(MAX_MEMORY_PAGES + 1);
    expect(queries.at(-1)).toBe("SELECT id FROM flair.Memory WHERE id > 'mem-0199' ORDER BY id LIMIT 1");
  }, 5_000);

  test("pins parity between capped and uncapped walks under a balanced behind-cursor write (shared no-snapshot limit, #2679)", async () => {
    async function walk(pageSize: number) {
      const { initial, live, queries, opsPost } = store(MAX_MEMORY_PAGES * 2, (live, page) => {
        if (page !== 1) return;
        live.delete("mem-0000");
        live.set("a-replacement", { id: "a-replacement", durability: "standard" });
      });
      const result = await verifyCheckpoint({
        checkpoint: buildCheckpoint({ node: NODE_A, at: "2026-10-15T00:00:00.000Z", rows: initial }),
        target: NODE_A, pageSize, opsPost,
      });
      expect(live.has("mem-0000")).toBe(false);
      expect(live.size).toBe(initial.length);
      return { result, queries };
    }
    const capped = await walk(2);
    const uncapped = await walk(3);
    expect(capped.result.outcome).toBe(uncapped.result.outcome);
    expect(uncapped.result.outcome).toBe("verified");
    expect(capped.queries).toHaveLength(MAX_MEMORY_PAGES + 1);
    expect(uncapped.queries).toHaveLength(Math.ceil(MAX_MEMORY_PAGES * 2 / 3));
  }, 5_000);

  test("a balanced insert ahead of the final full page is UNKNOWN when the probe sees it", async () => {
    const { initial, live, queries, opsPost } = store(MAX_MEMORY_PAGES * 2, (live, page) => {
      if (page !== MAX_MEMORY_PAGES) return;
      live.delete("mem-0000");
      live.set("z-replacement", { id: "z-replacement", durability: "standard" });
    });
    const result = await verifyCheckpoint({
      checkpoint: buildCheckpoint({ node: NODE_A, at: "2026-10-15T00:00:00.000Z", rows: initial }),
      target: NODE_A, pageSize: 2, opsPost,
    });
    expect(live.size).toBe(initial.length);
    expect(result.outcome).toBe("unknown");
    expect(result.reason).toMatch(/page cap/);
    expect(queries).toHaveLength(MAX_MEMORY_PAGES + 1);
    expect(queries.at(-1)).toBe("SELECT id FROM flair.Memory WHERE id > 'mem-0199' ORDER BY id LIMIT 1");
  }, 5_000);

  test.each([{}, { results: null }])("a malformed cap probe refuses with the cap error: %j", async probe => {
    let reads = 0;
    const opsPost = async () => ++reads === 1 ? [{ id: "a" }] : probe;
    await expect(readTableByIdPaged(opsPost, { table: "Memory", select: "id", expected: 1, pageSize: 1, maxPages: 1 }))
      .rejects.toThrow(/page cap/);
    expect(reads).toBe(2);
  });

  test("an empty cap probe with a count mismatch refuses with the cap error", async () => {
    let reads = 0;
    await expect(readTableByIdPaged(async () => ++reads === 1 ? [{ id: "a" }] : [], {
      table: "Memory", select: "id", expected: 2, pageSize: 1, maxPages: 1,
    })).rejects.toThrow(/page cap/);
    expect(reads).toBe(2);
  });

  test("the cap probe preserves the filter and quotes its cursor", async () => {
    const calls: Record<string, unknown>[] = [];
    await readTableByIdPaged(async body => {
      calls.push(body);
      return calls.length === 1 ? [{ id: "b'quoted" }] : [];
    }, { table: "MemoryDeletionHistory", select: "id, at", filter: "at >= '2026-09-01'", expected: 1, pageSize: 1, maxPages: 1 });
    expect(calls).toEqual([
      { operation: "sql", sql: "SELECT id, at FROM flair.MemoryDeletionHistory WHERE (at >= '2026-09-01') ORDER BY id LIMIT 1" },
      { operation: "sql", sql: "SELECT id FROM flair.MemoryDeletionHistory WHERE (at >= '2026-09-01') AND id > 'b''quoted' ORDER BY id LIMIT 1" },
    ]);
  });

  test("a backslash cursor at the cap is refused before the probe", async () => {
    let reads = 0;
    await expect(readTableByIdPaged(async () => { reads++; return [{ id: "a\\b" }]; }, {
      table: "Memory", select: "id", expected: 1, pageSize: 1, maxPages: 1,
    })).rejects.toThrow("unsupported backslash");
    expect(reads).toBe(1);
  });

  test("one row beyond the cap is UNKNOWN", async () => {
    // At pageSize 2 the hard MAX_MEMORY_PAGES bound covers 200 rows; for 201 rows the
    // allowance formula computes ceil(201 / 2) + 1 = 102 pages, which exceeds the hard cap
    // of 100, so the hard cap (not the count) ends the walk.
    let counter = 0;
    const opsPost = async (body: Record<string, unknown>) =>
      body.operation === "describe_table" ? { record_count: 201 } : [
        { id: String(counter++).padStart(4, "0"), durability: "standard" },
        { id: String(counter++).padStart(4, "0"), durability: "standard" },
      ];

    const result = await verifyCheckpoint({
      checkpoint: checkpointOf([]),
      target: NODE_A,
      pageSize: 2,
      opsPost,
    });
    expect(result.outcome).toBe("unknown");
    expect(result.reason).toMatch(/page cap/);
  }, 5_000);

  test("a short read still refuses", async () => {
    const opsPost = async (body: Record<string, unknown>) =>
      body.operation === "describe_table" ? { record_count: 5 } : [{ id: "mem-0", durability: "standard" }];
    await expect(readMemoryRowsPaged(opsPost, { pageSize: 2 })).rejects.toThrow("writes during checkpoint");
  }, 5_000);

  test("an unknown expected count keeps the count read and refuses without record_count", async () => {
    let pageReads = 0;
    const opsPost = async (body: Record<string, unknown>) => {
      if (body.operation === "sql") pageReads++;
      return {};
    };
    await expect(readMemoryRowsPaged(opsPost, { pageSize: 2 })).rejects.toThrow(/no record_count/);
    expect(pageReads).toBe(0);
  }, 5_000);
});

describe("flair#2218 — origin comparison", () => {
  test.each(["https://node-b.example.invalid", "http://node-a.example.invalid", "https://node-a.example.invalid:8443"])("refuses a different origin: %s", async (target) => {
    let called = false;
    const result = await verifyCheckpoint({
      checkpoint: checkpointOf([["mem-1", "standard"]]), target,
      opsPost: async () => { called = true; throw new Error("must not be called"); },
    });
    expect(result.outcome).toBe("unknown");
    expect(called).toBe(false);
  });

  test("normalizes scheme, hostname and default port", async () => {
    const result = await verifyCheckpoint({
      checkpoint: checkpointOf([], "https://NODE-A.example.invalid:443/"),
      target: NODE_A,
      opsPost: async (body) => body.operation === "describe_table" ? { record_count: 0 } : [],
    });
    expect(result.outcome).toBe("verified");
  });

  test("the origin guard compares the resolved ops target", async () => {
    let called = false;
    const result = await verifyCheckpoint({
      checkpoint: checkpointOf([]), target: NODE_A, opsTarget: "http://node-a.example.invalid",
      opsPost: async () => { called = true; return []; },
    });
    expect(result.outcome).toBe("unknown");
    expect(called).toBe(false);
  });

  test("a served URL and its matching ops origin can differ", async () => {
    const result = await verifyCheckpoint({
      checkpoint: checkpointOf([]), target: "https://served.example.invalid", opsTarget: NODE_A,
      opsPost: async (body) => body.operation === "describe_table" ? { record_count: 0 } : [],
    });
    expect(result.outcome).toBe("verified");
  });

  test("rejects a non-HTTP origin", () => {
    expect(() => checkpointOf([], "file:///some/path")).toThrow();
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
        expect(Object.getPrototypeOf(read.checkpoint)).toBeNull();
        expect(read.checkpoint.ids).toEqual(["mem-1", "mem-2"]);
        expect(read.checkpoint.byDurability).toEqual({ permanent: 1, persistent: 0, standard: 0, ephemeral: 1 });
        expect(read.checkpoint.host).toBe("node-a.example.invalid");
      }
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a checkpoint read carries only the version-1 fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-2218-unit-"));
    try {
      const path = join(dir, "extra.json");
      const cp = checkpointOf([["mem-1", "permanent"]]);
      writeFileSync(path, `{"__proto__":{"polluted":true},"extra":"x",${JSON.stringify({ ...cp, byDurability: { ...cp.byDurability, other: 3 } }).slice(1)}`);
      const read = readCheckpointFile(path);
      expect(read.kind).toBe("ok");
      if (read.kind === "ok") {
        expect(Object.getPrototypeOf(read.checkpoint)).toBeNull();
        expect(Object.keys(read.checkpoint).sort()).toEqual(["at", "byDurability", "host", "ids", "node", "version"]);
        expect(Object.getPrototypeOf(read.checkpoint.byDurability)).toBeNull();
        expect(Object.keys(read.checkpoint.byDurability).sort()).toEqual(["ephemeral", "permanent", "persistent", "standard"]);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      }
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

  test("a dangling symlink is unreadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-2218-unit-"));
    try {
      const path = join(dir, "dangling.json");
      symlinkSync(join(dir, "absent"), path);
      expect(readCheckpointFile(path).kind).toBe("unreadable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed JSON returns a static error without source bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-2218-unit-"));
    try {
      const path = join(dir, "malformed.json");
      writeFileSync(path, '{"secret":"SECRET_MARKER", broken');
      expect(readCheckpointFile(path)).toEqual({ kind: "unreadable", reason: "checkpoint is not valid JSON or has an invalid origin" });
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
