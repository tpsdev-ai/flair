/**
 * migrations-embedding-stamp.test.ts — resources/migrations/embedding-stamp.ts,
 * the first registered migration. Exercises detect/countPending/run against
 * an in-memory fake Memory table + an injected fake regen function (no real
 * Harper, no real HTTP needed) — proves it passes the FULL existing record
 * to regen (never a partial write), is idempotent, and correctly leaves a
 * row pending (never falsely marks it done) when regen fails.
 *
 * The real loopback-HTTP regen mechanism itself (resources/migrations/
 * embedding-stamp.ts's `regenViaHttpPut`, which is what actually reaches
 * resources/Memory.ts's regen branch against real Harper — see that file's
 * module doc for why an in-process `databases.flair.Memory.put()` call
 * cannot do this) is exercised for real in
 * test/integration/migrations-embedding-stamp-e2e.test.ts.
 */
import { describe, it, expect, mock } from "bun:test";

// embedding-stamp.ts imports `{ databases } from "@harperfast/harper"` for
// its DEFAULT table accessor only (never used here — every test injects its
// own fake table via createEmbeddingStampMigration's first argument). Same
// workaround as migrations-ledger.test.ts: mock the module out before import
// so the real package's import-time side effects never fire.
mock.module("@harperfast/harper", () => ({ databases: {}, Resource: class {} }));

const { createEmbeddingStampMigration, EMBEDDING_STAMP_ID } = await import("../../resources/migrations/embedding-stamp.ts");

type Row = Record<string, unknown> & { id: string };

/**
 * Mirrors the SAME condition semantics as test/unit/attention-query.test.ts's
 * matchesCondition — supports a flat `{attribute, comparator, value}` AND a
 * nested `{operator: "or"|"and", conditions: [...]}` group, since
 * embedding-stamp.ts's real pending condition is an OR of `not_equal` +
 * `equals: null` (see that file's module doc for why: real Harper's
 * `not_equal` never matches a truly-absent property, only an explicit null).
 */
function matchesCondition(row: Row, cond: any): boolean {
  if (cond.operator && Array.isArray(cond.conditions)) {
    const results = cond.conditions.map((c: any) => matchesCondition(row, c));
    return cond.operator === "or" ? results.some(Boolean) : results.every(Boolean);
  }
  const value = row[cond.attribute];
  switch (cond.comparator) {
    case "not_equal":
      return value !== cond.value;
    case "equals":
      return value === cond.value;
    default:
      return true;
  }
}

function makeFakeMemoryTable(seed: Row[]) {
  const store = new Map<string, Row>(seed.map((r) => [r.id, { ...r }]));
  return {
    store,
    table: {
      async get(id: string) {
        return store.has(id) ? { ...store.get(id)! } : null;
      },
      search(query: any): AsyncIterable<Row> {
        const conditions = Array.isArray(query?.conditions) ? query.conditions : [];
        const limit = typeof query?.limit === "number" ? query.limit : Infinity;
        let rows = Array.from(store.values());
        for (const c of conditions) rows = rows.filter((r) => matchesCondition(r, c));
        rows = rows.slice(0, limit);
        async function* gen() {
          for (const r of rows) yield { ...r };
        }
        return gen();
      },
    },
  };
}

const CURRENT_MODEL = "nomic-embed-text-v1.5-Q4_K_M";

/** A regen fake that always succeeds, writing a real-looking embedding into the store (simulating what the real HTTP PUT ultimately causes). */
function makeSucceedingRegen(store: Map<string, Row>) {
  const calls: Array<{ id: string; existing: Row }> = [];
  return {
    calls,
    regen: async (id: string, existing: Row) => {
      calls.push({ id, existing: { ...existing } });
      store.set(id, { ...existing, embedding: [0.1, 0.2, 0.3], embeddingModel: CURRENT_MODEL });
      return true;
    },
  };
}

describe("embedding-stamp migration — identity", () => {
  it("has the expected id and risk class", () => {
    const { table } = makeFakeMemoryTable([]);
    const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL, async () => true);
    expect(m.id).toBe(EMBEDDING_STAMP_ID);
    expect(m.riskClass).toBe("derived-only");
    expect(m.affectsTables).toEqual(["Memory"]);
  });
});

describe("embedding-stamp migration — detect/countPending", () => {
  it("detect() is false when every row already matches the current model", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", content: "a", embeddingModel: CURRENT_MODEL },
      { id: "m2", content: "b", embeddingModel: CURRENT_MODEL },
    ]);
    const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL, async () => true);
    expect(await m.detect()).toBe(false);
    expect(await m.countPending()).toBe(0);
  });

  it("detect() is true when at least one row has a stale embeddingModel", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", content: "a", embeddingModel: "old-model" },
      { id: "m2", content: "b", embeddingModel: CURRENT_MODEL },
    ]);
    const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL, async () => true);
    expect(await m.detect()).toBe(true);
    expect(await m.countPending()).toBe(1);
  });

  it("detect()/countPending() ALSO catch an explicit-null embeddingModel (not just a stale string)", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", content: "a", embeddingModel: null },
      { id: "m2", content: "b", embeddingModel: CURRENT_MODEL },
    ]);
    const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL, async () => true);
    expect(await m.detect()).toBe(true);
    expect(await m.countPending()).toBe(1);
  });

  it("counts multiple stale rows correctly (mixed stale-string and explicit-null)", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", content: "a", embeddingModel: "old" },
      { id: "m2", content: "b", embeddingModel: null },
      { id: "m3", content: "c", embeddingModel: CURRENT_MODEL },
    ]);
    const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL, async () => true);
    expect(await m.countPending()).toBe(2);
  });
});

describe("embedding-stamp migration — run() passes the FULL existing record to regen", () => {
  it("calls regen(id, existing) with every field of the current record — proves no partial-write shortcut", async () => {
    const { table, store } = makeFakeMemoryTable([
      {
        id: "m1",
        content: "hello",
        agentId: "a1",
        durability: "persistent",
        tags: ["x", "y"],
        embedding: [1, 2, 3],
        embeddingModel: "old-model",
      },
    ]);
    const { calls, regen } = makeSucceedingRegen(store);
    const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL, regen);
    const result = await m.run(50);

    expect(result.processed).toBe(1);
    expect(result.touchedIds).toEqual(["m1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("m1");
    expect(calls[0].existing).toEqual({
      id: "m1",
      content: "hello",
      agentId: "a1",
      durability: "persistent",
      tags: ["x", "y"],
      embedding: [1, 2, 3],
      embeddingModel: "old-model",
    });

    // Post-regen (simulated), the row now carries the current model and is
    // no longer pending.
    expect(store.get("m1")!.embeddingModel).toBe(CURRENT_MODEL);
    expect(await m.countPending()).toBe(0);
  });

  it("processes up to batchSize rows and reports the rest as still pending via countPending()", async () => {
    const rows: Row[] = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, content: `c${i}`, embeddingModel: "old" }));
    const { table, store } = makeFakeMemoryTable(rows);
    const { regen } = makeSucceedingRegen(store);
    const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL, regen);

    const first = await m.run(2);
    expect(first.processed).toBe(2);
    expect(await m.countPending()).toBe(3);
  });

  it("run() returns processed:0 once nothing is left (loop-termination signal)", async () => {
    const { table, store } = makeFakeMemoryTable([{ id: "m1", content: "a", embeddingModel: CURRENT_MODEL }]);
    const { regen } = makeSucceedingRegen(store);
    const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL, regen);
    const result = await m.run(50);
    expect(result.processed).toBe(0);
  });

  it("is idempotent — running twice over the same stale row only calls regen once effectively (second run finds it already current)", async () => {
    const { table, store } = makeFakeMemoryTable([{ id: "m1", content: "a", embeddingModel: "old" }]);
    const { calls, regen } = makeSucceedingRegen(store);
    const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL, regen);

    await m.run(50);
    expect(calls).toHaveLength(1);

    const second = await m.run(50);
    expect(second.processed).toBe(0);
    expect(calls).toHaveLength(1); // no additional regen call
  });

  it("skips a row that vanished between the search and the get (deleted concurrently) without throwing", async () => {
    const { table } = makeFakeMemoryTable([{ id: "m1", content: "a", embeddingModel: "old" }]);
    const originalGet = table.get.bind(table);
    (table as any).get = async (id: string) => (id === "m1" ? null : originalGet(id));

    const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL, async () => true);
    const result = await m.run(50);
    expect(result.processed).toBe(0);
  });
});

describe("embedding-stamp migration — a FAILED regen leaves the row pending, never falsely marked done", () => {
  it("processed excludes rows whose regen call returned false, and only the failing row still counts as pending", async () => {
    const { table, store } = makeFakeMemoryTable([
      { id: "m1", content: "a", embeddingModel: "old" },
      { id: "m2", content: "b", embeddingModel: "old" },
    ]);
    // m1 succeeds (and, like the real HTTP regen would, mutates the stored
    // row); m2 fails (simulating e.g. no admin credential available this
    // cycle) and is left completely untouched.
    const regen = async (id: string, existing: Row) => {
      if (id !== "m1") return false;
      store.set(id, { ...existing, embedding: [0.1, 0.2, 0.3], embeddingModel: CURRENT_MODEL });
      return true;
    };
    const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL, regen);

    const result = await m.run(50);
    expect(result.processed).toBe(1);
    expect(result.touchedIds).toEqual(["m1"]);
    // m1 converged; m2's row was never mutated (a failing regen never
    // writes), so it alone is still pending.
    expect(await m.countPending()).toBe(1);
    expect((await table.get("m2"))?.embeddingModel).toBe("old");
  });

  it("a regen function that always fails never marks anything processed — the runner's completion gate would correctly halt rather than false-succeed", async () => {
    const { table } = makeFakeMemoryTable([{ id: "m1", content: "a", embeddingModel: "old" }]);
    const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL, async () => false);
    const result = await m.run(50);
    expect(result.processed).toBe(0);
    expect(await m.countPending()).toBe(1);
  });
});
