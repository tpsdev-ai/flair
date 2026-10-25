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
import { describe, it, expect, mock, afterEach } from "bun:test";
import { makeFakeWriteBack } from "../helpers/fake-write-back";

// visibility-backfill.ts imports `{ databases } from "harper"`
// for its DEFAULT table accessor only (never used here — every test injects
// its own fake table via createVisibilityBackfillMigration's argument). Same
// workaround as migrations-embedding-stamp.test.ts: mock the module out
// before import so the real package's import-time side effects never fire.
mock.module("harper", () => ({ server: { http: () => {}, getUser: async () => null }, databases: {}, Resource: class {} }));

const { createVisibilityBackfillMigration, deriveVisibilityFromDurability, VISIBILITY_BACKFILL_ID } = await import(
  "../../resources/migrations/visibility-backfill.ts"
);
const { writeBackCommittedRow } = await import("../../resources/write-back.ts");

/** Every call site below injects the fake write-back (flair#2354); the real
 *  helper is exercised in the contention test. */
const makeLockStore = () => ({ tryLock: () => true, unlock: () => {} });

const makeMigration = (getTable: () => any, writeBack = makeFakeWriteBack(), lockStore = makeLockStore()) =>
  createVisibilityBackfillMigration(getTable, writeBack, () => lockStore);

type Row = Record<string, unknown> & { id: string };

/**
 * Mirrors real Harper's condition semantics for THIS migration's query
 * shape: a flat top-level array of leaf conditions defaults to AND
 * (confirmed against the installed harper source,
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
      async update(id: string, patch: Record<string, unknown>) {
        const current = store.get(id);
        if (!current) throw new Error(`fake table: no row ${id}`);
        store.set(id, { ...current, ...patch });
        return store.get(id);
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
    const m = makeMigration(() => table);
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
    const m = makeMigration(() => table);
    expect(await m.detect()).toBe(false);
    expect(await m.countPending()).toBe(0);
  });

  it("detect()/countPending() catch a row with NO visibility field at all (truly absent, not just null)", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", content: "a", durability: "permanent" }, // no `visibility` key whatsoever
      { id: "m2", content: "b", durability: "standard", visibility: "private" },
    ]);
    const m = makeMigration(() => table);
    expect(await m.detect()).toBe(true);
    expect(await m.countPending()).toBe(1);
  });

  it("detect()/countPending() ALSO catch an explicit-null visibility", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", content: "a", durability: "permanent", visibility: null },
      { id: "m2", content: "b", durability: "standard", visibility: "private" },
    ]);
    const m = makeMigration(() => table);
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
    const m = makeMigration(() => table);
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
    const m = makeMigration(() => table);
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

  it("preserves every OTHER field on the row — the update names only visibility", async () => {
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
    const m = makeMigration(() => table);
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
    const m = makeMigration(() => table);

    const first = await m.run(2);
    expect(first.processed).toBe(2);
    expect(await m.countPending()).toBe(3);
  });

  it("run() returns processed:0 once nothing is left (loop-termination signal)", async () => {
    const { table } = makeFakeMemoryTable([{ id: "m1", content: "a", durability: "standard", visibility: "private" }]);
    const m = makeMigration(() => table);
    const result = await m.run(50);
    expect(result.processed).toBe(0);
  });

  it("skips a row that vanished between the search and the get (deleted concurrently) without throwing", async () => {
    const { table } = makeFakeMemoryTable([{ id: "m1", content: "a", durability: "standard" }]);
    const originalGet = table.get.bind(table);
    (table as any).get = async (id: string) => (id === "m1" ? null : originalGet(id));

    const m = makeMigration(() => table);
    const result = await m.run(50);
    expect(result.processed).toBe(0);
  });
});

describe("visibility-backfill migration — NEVER overwrites an existing visibility value", () => {
  it("a row already carrying 'private' is left completely untouched, even though its durability would derive 'shared'", async () => {
    const { table, store } = makeFakeMemoryTable([
      { id: "m1", content: "a", durability: "permanent", visibility: "private" }, // author's explicit call
    ]);
    const m = makeMigration(() => table);
    const result = await m.run(50);

    expect(result.processed).toBe(0);
    expect(result.touchedIds).toEqual([]);
    expect(store.get("m1")!.visibility).toBe("private"); // unchanged
  });

  it("a row already carrying 'shared' is left completely untouched, even though its durability would derive 'private'", async () => {
    const { table, store } = makeFakeMemoryTable([
      { id: "m1", content: "a", durability: "standard", visibility: "shared" }, // author's explicit call
    ]);
    const m = makeMigration(() => table);
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
    const m = makeMigration(() => table);
    const result = await m.run(50);

    expect(result.processed).toBe(0);
    expect(result.touchedIds).toEqual([]);
    expect(store.get("m1")!.visibility).toBe("office"); // unchanged — never "corrected" to a derived value
  });

  it("does not count or report a row another writer set to 'private' between the scan and the read", async () => {
    // The scan snapshot still shows the row pending; the backing store already
    // holds the row another writer set. This run never attempted the row.
    const pending: Row = { id: "m1", content: "a", durability: "standard" };
    const set: Row = { ...pending, visibility: "private" };
    const { table, writes, restore } = makeStagedTable([set], [pending]);
    try {
      const m = makeMigration(() => table, writeBackCommittedRow);

      expect(await m.run(50)).toEqual({ processed: 0, touchedIds: [] });
      expect(writes).toEqual([]);
      expect(table.store.get("m1")!.visibility).toBe("private");
    } finally {
      restore();
    }
  });

  it("a mixed batch only touches the genuinely-pending rows, never the already-set ones", async () => {
    const { table, store } = makeFakeMemoryTable([
      { id: "m1", content: "a", durability: "standard" }, // pending -> private
      { id: "m2", content: "b", durability: "standard", visibility: "shared" }, // already set, untouched
      { id: "m3", content: "c", durability: "permanent" }, // pending -> shared
    ]);
    const m = makeMigration(() => table);
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
    const m = makeMigration(() => table);

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
    const m1 = makeMigration(() => table);
    await m1.run(50);

    const m2 = makeMigration(() => table);
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
    const m = makeMigration(() => spyTable);
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

describe("visibility-backfill migration — simulated write-back retry (flair#2354)", () => {
  it("with a simulated write-back, retries from the committed row when a competing write lands after the read", async () => {
    const { table, store } = makeFakeMemoryTable([
      { id: "m1", content: "a", durability: "standard" },
    ]);
    // On the first attempt a competing writer commits a durability change after
    // this write-back's read; the simulated write-back sees it at its
    // confirmation read, skips that attempt's put and retries.
    const writeBack = makeFakeWriteBack({
      conflict: (attempt) => {
        if (attempt === 1) store.set("m1", { ...store.get("m1")!, durability: "permanent" });
      },
    });
    const m = makeMigration(() => table, writeBack);
    const result = await m.run(50);
    expect(result.processed).toBe(1);
    expect(new Set(result.touchedIds)).toEqual(new Set(["m1"]));
    // The first attempt derived "private"; it was not written. The retry derived
    // from the committed (permanent) row, so the stored value is "shared".
    expect(store.get("m1")!.visibility).toBe("shared");
    expect(store.get("m1")!.durability).toBe("permanent");
  });
});

  it("does not stamp a row whose owner changed after selection", async () => {
    const { table, store } = makeFakeMemoryTable([
      { id: "m1", agentId: "owner", content: "original", createdAt: "2026-01-01T00:00:00.000Z", durability: "standard" },
    ]);
    const get = table.get.bind(table);
    table.get = async (id: string) => {
      store.set(id, { ...store.get(id)!, agentId: "replacement-owner" });
      return get(id);
    };
    const run = makeMigration(() => table).run(1);
    await expect(run).rejects.toThrow("target m1 changed");
    expect(store.get("m1")?.agentId).toBe("replacement-owner");
    expect(store.get("m1")?.visibility).toBeUndefined();
  });

describe("visibility-backfill — rowsDone counts verified writes only (flair#2840)", () => {
  let restoreTransaction: (() => void) | null = null;

  afterEach(() => {
    restoreTransaction?.();
    restoreTransaction = null;
  });

  it("does not count an attempt whose post-commit verification read missed it, and reports its id", async () => {
    const { table, restore } = makeStagedTable(
      [{ id: "v1", content: "a", durability: "standard" }],
      [{ id: "v1", content: "a", durability: "standard" }],
    );
    restoreTransaction = restore;
    // The pre-commit confirmation read sees the pre-write row (it is a
    // committed read) and passes; the post-commit verification read is
    // answered with that same pre-write row, so the attempt is unconfirmed.
    table.onCommit((prior) => table.armStaleVerification(prior ?? { id: "v1" }));
    const m = createVisibilityBackfillMigration(() => table as any, writeBackCommittedRow, makeLockStore);

    const result = await m.run(50);

    expect(table.store.get("v1")!.visibility).toBe("private");
    expect(result).toEqual({ processed: 0, touchedIds: [], unconfirmedIds: ["v1"] });
    expect(await m.countPending()).toBe(0);
  });

  it("counts a verified write and reports no unconfirmed row", async () => {
    const { table, restore } = makeStagedTable(
      [{ id: "v1", content: "a", durability: "standard" }],
      [{ id: "v1", content: "a", durability: "standard" }],
    );
    restoreTransaction = restore;
    const m = createVisibilityBackfillMigration(() => table as any, writeBackCommittedRow, makeLockStore);

    expect(await m.run(50)).toEqual({ processed: 1, touchedIds: ["v1"] });
    expect(table.store.get("v1")!.visibility).toBe("private");
  });
});

/**
 * A Memory-table fake that behaves like Harper's own write transaction: an
 * `update` through a transaction's context is STAGED and applies only when the
 * callback settles; a read with the explicit empty context the write-back
 * helper uses reads the committed store and never the staged state, so the
 * pre-commit confirmation read passes and the post-commit verification read
 * sees the commit unless it is armed to return the pre-write row.
 *
 * `firstSearchSnapshot` is what the first scan returns; when omitted, `search`
 * reads the backing store. The competing-writer test seeds the store with
 * another writer's row and passes the pre-write pending row as the snapshot.
 */
function makeStagedTable(seed: Row[], firstSearchSnapshot?: Row[]) {
  const store = new Map<string, Row>(seed.map((r) => [r.id, { ...r }]));
  let searchSnapshot = firstSearchSnapshot ?? null;
  const writes: { method: "put" | "update"; id: string; fields: string[] }[] = [];
  let staleReads = 0;
  let staleRow: Row | null = null;
  let afterCommit: ((prior: Row | null) => void) | null = null;

  function apply(id: string, patch: Row): void {
    const prior = store.get(id);
    store.set(id, { ...(prior ?? { id }), ...structuredClone(patch), id });
  }

  const table = {
    store,
    writes,
    armStaleVerification(row: Row, times = 1): void {
      staleRow = { ...row };
      staleReads = times;
    },
    onCommit(fn: ((prior: Row | null) => void) | null): void {
      afterCommit = fn;
    },
    async get(id: string, ctx?: any) {
      const base = store.get(id);
      let row: Row | null = base ? { ...base } : null;
      const staged = ctx?.transaction?.staged;
      if (Array.isArray(staged)) {
        for (const entry of staged) {
          if (entry.id === id) row = { ...(row ?? { id }), ...structuredClone(entry.patch) };
        }
      }
      const committedRead = ctx !== null && typeof ctx === "object" && Object.keys(ctx).length === 0;
      if (row && committedRead && staleReads > 0 && staleRow) {
        staleReads--;
        return { ...staleRow };
      }
      return row;
    },
    async put(record: Row, ctx?: any) {
      writes.push({ method: "put", id: record.id, fields: Object.keys(record).sort() });
      const staged = ctx?.transaction?.staged;
      if (Array.isArray(staged)) staged.push({ id: record.id, patch: structuredClone(record) });
      else apply(record.id, record);
      return record;
    },
    async update(id: string, patch: Row, ctx?: any) {
      writes.push({ method: "update", id, fields: Object.keys(patch).sort() });
      const staged = ctx?.transaction?.staged;
      if (Array.isArray(staged)) staged.push({ id, patch: structuredClone(patch) });
      else apply(id, patch);
      return store.get(id);
    },
    search(query: any): AsyncIterable<Row> {
      const conditions = Array.isArray(query?.conditions) ? query.conditions : [];
      // A supplied snapshot models a scan that ran before a competing write;
      // it is consumed by the first search, so later counts read the store.
      let rows = searchSnapshot ? [...searchSnapshot] : Array.from(store.values());
      searchSnapshot = null;
      rows = rows.filter((r) => matchesAll(r, conditions));
      rows = rows.slice(0, typeof query?.limit === "number" ? query.limit : Infinity);
      return (async function* () {
        for (const r of rows) yield { ...r };
      })();
    },
  };

  const originalTransaction = (globalThis as any).transaction;
  (globalThis as any).transaction = async (ctx: any, fn: (txn: any) => Promise<unknown>) => {
    const staged: { id: string; patch: Row }[] = [];
    ctx.transaction = { staged };
    const result = await fn(ctx);
    let prior: Row | null = null;
    for (const entry of staged) {
      const before = store.get(entry.id);
      if (before) prior = { ...before };
      apply(entry.id, entry.patch);
    }
    const hook = afterCommit;
    afterCommit = null;
    hook?.(prior);
    return result;
  };
  return {
    table,
    store,
    writes,
    restore: () => {
      (globalThis as any).transaction = originalTransaction;
    },
  };
}
