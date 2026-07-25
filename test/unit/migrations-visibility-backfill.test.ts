/**
 * migrations-visibility-backfill.test.ts —
 * resources/migrations/visibility-backfill.ts. Exercises detect/
 * countPending/run against an in-memory fake Memory table (no real Harper
 * needed — the write path here is a direct table.put(), unlike
 * embedding-stamp's HTTP loopback, so there is no separate mechanism left
 * to fake). Proves: the durability -> visibility derivation table
 * (including every absent/garbage durability -> "private"), that an
 * existing visibility value is NEVER overwritten (including a garbage
 * third value), idempotency, and the exact query-condition shape.
 */
import { describe, it, expect, mock } from "bun:test";

// visibility-backfill.ts imports `{ databases } from "@harperfast/harper"`
// for its DEFAULT table accessor only (never used here — every test injects
// its own fake table via createVisibilityBackfillMigration's argument). Same
// workaround as migrations-embedding-stamp.test.ts: mock the module out
// before import so the real package's import-time side effects never fire.
mock.module("@harperfast/harper", () => ({ databases: {}, Resource: class {} }));

const { createVisibilityBackfillMigration, deriveVisibilityFromDurability, VISIBILITY_BACKFILL_ID } = await import(
  "../../resources/migrations/visibility-backfill.ts"
);

type Row = Record<string, unknown> & { id: string };

/**
 * Mirrors real Harper's condition semantics for THIS migration's query
 * shape: a flat top-level array of leaf conditions defaults to AND
 * (confirmed against the installed @harperfast/harper source,
 * resources/Table.ts's prepareConditions: `case 'and': case undefined:`
 * fall through together), and `not_equals` on an unindexed attribute is a
 * full-table-scan strict-inequality filter — `undefined !== "private"` is
 * true, so a truly-absent property matches (see visibility-backfill.ts's
 * module doc for the full mechanism, root-caused against the same source).
 */
function matchesCondition(row: Row, cond: any): boolean {
  if (cond.operator && Array.isArray(cond.conditions)) {
    const results = cond.conditions.map((c: any) => matchesCondition(row, c));
    return cond.operator === "or" ? results.some(Boolean) : results.every(Boolean);
  }
  const value = row[cond.attribute];
  switch (cond.comparator) {
    case "not_equals":
    case "not_equal":
      return value !== cond.value;
    case "equals":
      return value === cond.value;
    default:
      return true;
  }
}

function matchesAll(row: Row, conditions: any[]): boolean {
  return conditions.every((c) => matchesCondition(row, c));
}

function makeFakeMemoryTable(seed: Row[]) {
  const store = new Map<string, Row>(seed.map((r) => [r.id, { ...r }]));
  return {
    store,
    table: {
      async get(id: string) {
        return store.has(id) ? { ...store.get(id)! } : null;
      },
      async put(content: Row) {
        store.set(content.id, { ...content });
        return content;
      },
      search(query: any): AsyncIterable<Row> {
        const conditions = Array.isArray(query?.conditions) ? query.conditions : [];
        const limit = typeof query?.limit === "number" ? query.limit : Infinity;
        let rows = Array.from(store.values()).filter((r) => matchesAll(r, conditions));
        rows = rows.slice(0, limit);
        async function* gen() {
          for (const r of rows) yield { ...r };
        }
        return gen();
      },
    },
  };
}

describe("visibility-backfill migration — identity", () => {
  it("has the expected id, risk class, and affected tables", () => {
    const { table } = makeFakeMemoryTable([]);
    const m = createVisibilityBackfillMigration(() => table);
    expect(m.id).toBe(VISIBILITY_BACKFILL_ID);
    expect(m.riskClass).toBe("derived-only");
    expect(m.affectsTables).toEqual(["Memory"]);
    // derived-only never implements recheckPending — see the module doc
    // (no index on `visibility`, so no flair#807-style divergence to guard).
    expect(m.recheckPending).toBeUndefined();
  });
});

describe("deriveVisibilityFromDurability — the flair#509 rule, exhaustively", () => {
  it("permanent -> shared", () => {
    expect(deriveVisibilityFromDurability("permanent")).toBe("shared");
  });
  it("persistent -> shared", () => {
    expect(deriveVisibilityFromDurability("persistent")).toBe("shared");
  });
  it("standard -> private", () => {
    expect(deriveVisibilityFromDurability("standard")).toBe("private");
  });
  it("ephemeral -> private", () => {
    expect(deriveVisibilityFromDurability("ephemeral")).toBe("private");
  });
  it("undefined (absent) -> private (fail-safe)", () => {
    expect(deriveVisibilityFromDurability(undefined)).toBe("private");
  });
  it("null -> private (fail-safe)", () => {
    expect(deriveVisibilityFromDurability(null)).toBe("private");
  });
  it("empty string -> private (fail-safe)", () => {
    expect(deriveVisibilityFromDurability("")).toBe("private");
  });
  it("an unrecognised string -> private (fail-safe)", () => {
    expect(deriveVisibilityFromDurability("office")).toBe("private");
  });
  it("wrong-case match ('PERSISTENT') -> private (fail-safe, no case-insensitive match)", () => {
    expect(deriveVisibilityFromDurability("PERSISTENT")).toBe("private");
  });
  it("a number -> private (fail-safe)", () => {
    expect(deriveVisibilityFromDurability(123)).toBe("private");
  });
  it("a boolean -> private (fail-safe)", () => {
    expect(deriveVisibilityFromDurability(true)).toBe("private");
  });
  it("an object -> private (fail-safe)", () => {
    expect(deriveVisibilityFromDurability({})).toBe("private");
  });
  it("an array -> private (fail-safe)", () => {
    expect(deriveVisibilityFromDurability([])).toBe("private");
  });
});

describe("visibility-backfill migration — detect/countPending", () => {
  it("detect() is false when every row already carries an explicit visibility", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", content: "a", durability: "standard", visibility: "private" },
      { id: "m2", content: "b", durability: "permanent", visibility: "shared" },
    ]);
    const m = createVisibilityBackfillMigration(() => table);
    expect(await m.detect()).toBe(false);
    expect(await m.countPending()).toBe(0);
  });

  it("detect()/countPending() catch a row with NO visibility field at all (truly absent, not just null)", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", content: "a", durability: "permanent" }, // no `visibility` key whatsoever
      { id: "m2", content: "b", durability: "standard", visibility: "private" },
    ]);
    const m = createVisibilityBackfillMigration(() => table);
    expect(await m.detect()).toBe(true);
    expect(await m.countPending()).toBe(1);
  });

  it("detect()/countPending() ALSO catch an explicit-null visibility", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", content: "a", durability: "permanent", visibility: null },
      { id: "m2", content: "b", durability: "standard", visibility: "private" },
    ]);
    const m = createVisibilityBackfillMigration(() => table);
    expect(await m.detect()).toBe(true);
    expect(await m.countPending()).toBe(1);
  });

  it("counts multiple pending rows correctly (mixed absent and explicit-null, ignoring already-set rows)", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", content: "a", durability: "permanent" }, // absent
      { id: "m2", content: "b", durability: "standard", visibility: null }, // explicit null
      { id: "m3", content: "c", durability: "standard", visibility: "private" }, // already set
      { id: "m4", content: "d", durability: "permanent", visibility: "shared" }, // already set
    ]);
    const m = createVisibilityBackfillMigration(() => table);
    expect(await m.countPending()).toBe(2);
  });
});

describe("visibility-backfill migration — run() derives and writes visibility", () => {
  it("stamps 'shared' for permanent/persistent durability and 'private' for everything else, on absent-visibility rows", async () => {
    const { table, store } = makeFakeMemoryTable([
      { id: "m1", content: "a", durability: "permanent" },
      { id: "m2", content: "b", durability: "persistent" },
      { id: "m3", content: "c", durability: "standard" },
      { id: "m4", content: "d", durability: "ephemeral" },
      { id: "m5", content: "e" }, // no durability at all
    ]);
    const m = createVisibilityBackfillMigration(() => table);
    const result = await m.run(50);

    expect(result.processed).toBe(5);
    expect(new Set(result.touchedIds)).toEqual(new Set(["m1", "m2", "m3", "m4", "m5"]));
    expect(store.get("m1")!.visibility).toBe("shared");
    expect(store.get("m2")!.visibility).toBe("shared");
    expect(store.get("m3")!.visibility).toBe("private");
    expect(store.get("m4")!.visibility).toBe("private");
    expect(store.get("m5")!.visibility).toBe("private");
    expect(await m.countPending()).toBe(0);
  });

  it("preserves every OTHER field on the row — full read-modify-write, never a partial put()", async () => {
    const { table, store } = makeFakeMemoryTable([
      {
        id: "m1",
        content: "hello",
        agentId: "a1",
        durability: "persistent",
        tags: ["x", "y"],
        embedding: [1, 2, 3],
        embeddingModel: "some-model",
      },
    ]);
    const m = createVisibilityBackfillMigration(() => table);
    await m.run(50);

    expect(store.get("m1")).toEqual({
      id: "m1",
      content: "hello",
      agentId: "a1",
      durability: "persistent",
      tags: ["x", "y"],
      embedding: [1, 2, 3],
      embeddingModel: "some-model",
      visibility: "shared",
    });
  });

  it("processes up to batchSize rows and reports the rest as still pending via countPending()", async () => {
    const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, content: `c${i}`, durability: "standard" }));
    const { table } = makeFakeMemoryTable(rows);
    const m = createVisibilityBackfillMigration(() => table);

    const first = await m.run(2);
    expect(first.processed).toBe(2);
    expect(await m.countPending()).toBe(3);
  });

  it("run() returns processed:0 once nothing is left (loop-termination signal)", async () => {
    const { table } = makeFakeMemoryTable([{ id: "m1", content: "a", durability: "standard", visibility: "private" }]);
    const m = createVisibilityBackfillMigration(() => table);
    const result = await m.run(50);
    expect(result.processed).toBe(0);
  });

  it("skips a row that vanished between the search and the get (deleted concurrently) without throwing", async () => {
    const { table } = makeFakeMemoryTable([{ id: "m1", content: "a", durability: "standard" }]);
    const originalGet = table.get.bind(table);
    (table as any).get = async (id: string) => (id === "m1" ? null : originalGet(id));

    const m = createVisibilityBackfillMigration(() => table);
    const result = await m.run(50);
    expect(result.processed).toBe(0);
  });
});

describe("visibility-backfill migration — NEVER overwrites an existing visibility value", () => {
  it("a row already carrying 'private' is left completely untouched, even though its durability would derive 'shared'", async () => {
    const { table, store } = makeFakeMemoryTable([
      { id: "m1", content: "a", durability: "permanent", visibility: "private" }, // author's explicit call
    ]);
    const m = createVisibilityBackfillMigration(() => table);
    const result = await m.run(50);

    expect(result.processed).toBe(0);
    expect(result.touchedIds).toEqual([]);
    expect(store.get("m1")!.visibility).toBe("private"); // unchanged
  });

  it("a row already carrying 'shared' is left completely untouched, even though its durability would derive 'private'", async () => {
    const { table, store } = makeFakeMemoryTable([
      { id: "m1", content: "a", durability: "standard", visibility: "shared" }, // author's explicit call
    ]);
    const m = createVisibilityBackfillMigration(() => table);
    const result = await m.run(50);

    expect(result.processed).toBe(0);
    expect(store.get("m1")!.visibility).toBe("shared"); // unchanged
  });

  it("a row with an unexpected third-party visibility value is left untouched (write-gate, not the query, is what protects it)", async () => {
    // This row would ALSO match the candidate query (not_equals "private" AND
    // not_equals "shared" — see the module doc on why Harper's query algebra
    // can't exclude this case at the query level). The write-gate in run()
    // re-checks the freshly-read record and must skip it anyway.
    const { table, store } = makeFakeMemoryTable([{ id: "m1", content: "a", durability: "standard", visibility: "office" }]);
    const m = createVisibilityBackfillMigration(() => table);
    const result = await m.run(50);

    expect(result.processed).toBe(0);
    expect(result.touchedIds).toEqual([]);
    expect(store.get("m1")!.visibility).toBe("office"); // unchanged — never "corrected" to a derived value
  });

  it("a mixed batch only touches the genuinely-pending rows, never the already-set ones", async () => {
    const { table, store } = makeFakeMemoryTable([
      { id: "m1", content: "a", durability: "standard" }, // pending -> private
      { id: "m2", content: "b", durability: "standard", visibility: "shared" }, // already set, untouched
      { id: "m3", content: "c", durability: "permanent" }, // pending -> shared
    ]);
    const m = createVisibilityBackfillMigration(() => table);
    const result = await m.run(50);

    expect(result.processed).toBe(2);
    expect(new Set(result.touchedIds)).toEqual(new Set(["m1", "m3"]));
    expect(store.get("m1")!.visibility).toBe("private");
    expect(store.get("m2")!.visibility).toBe("shared"); // still the author's original value
    expect(store.get("m3")!.visibility).toBe("shared");
  });
});

describe("visibility-backfill migration — idempotent and resumable", () => {
  it("running twice is a no-op the second time (a second run touches nothing)", async () => {
    const { table, store } = makeFakeMemoryTable([
      { id: "m1", content: "a", durability: "standard" },
      { id: "m2", content: "b", durability: "permanent" },
    ]);
    const m = createVisibilityBackfillMigration(() => table);

    const first = await m.run(50);
    expect(first.processed).toBe(2);
    expect(store.get("m1")!.visibility).toBe("private");
    expect(store.get("m2")!.visibility).toBe("shared");

    const second = await m.run(50);
    expect(second.processed).toBe(0);
    expect(second.touchedIds).toEqual([]);
    // Unchanged from the first run's result — a second run never re-derives
    // or re-writes an already-backfilled row.
    expect(store.get("m1")!.visibility).toBe("private");
    expect(store.get("m2")!.visibility).toBe("shared");
    expect(await m.countPending()).toBe(0);
  });

  it("is idempotent even when called across separate migration instances (fresh table read each time — no in-memory-only state)", async () => {
    const { table } = makeFakeMemoryTable([{ id: "m1", content: "a", durability: "ephemeral" }]);
    const m1 = createVisibilityBackfillMigration(() => table);
    await m1.run(50);

    const m2 = createVisibilityBackfillMigration(() => table);
    const result = await m2.run(50);
    expect(result.processed).toBe(0);
  });
});

describe("visibility-backfill migration — candidate query shape", () => {
  it("queries with a flat AND of two 'not_equals' legs against \"private\" and \"shared\" — never the legacy 'not_equal' alias", async () => {
    const queries: any[] = [];
    const { table } = makeFakeMemoryTable([{ id: "m1", content: "a", durability: "standard" }]);
    const spyTable = {
      ...table,
      search(query: any) {
        queries.push(query);
        return table.search(query);
      },
    };
    const m = createVisibilityBackfillMigration(() => spyTable);
    await m.detect();

    expect(queries).toHaveLength(1);
    const conditions = queries[0].conditions;
    expect(conditions).toHaveLength(2);
    for (const c of conditions) {
      expect(c.attribute).toBe("visibility");
      expect(c.comparator).toBe("not_equals");
      expect(c.comparator).not.toBe("not_equal");
    }
    expect(conditions.map((c: any) => c.value).sort()).toEqual(["private", "shared"]);
  });
});
