/**
 * migrations-embedding-stamp.test.ts — resources/migrations/embedding-stamp.ts,
 * the first registered migration. Exercises detect/countPending/run against
 * an in-memory fake Memory table + an injected fake regen function (no real
 * Harper, no real HTTP needed) — proves it passes the FULL existing record
 * to regen (never a partial write), is idempotent, and correctly leaves a
 * row pending (never falsely marks it done) when regen fails.
 *
 * The real loopback-HTTP regen mechanism itself (resources/migrations/
 * embedding-stamp.ts's `regenViaHttpPatch`, which is what actually reaches
 * resources/Memory.ts's regen branch against real Harper — see that file's
 * module doc for why an in-process `databases.flair.Memory.put()` call
 * cannot do this) is exercised for real in
 * test/integration/migrations-embedding-stamp-e2e.test.ts.
 */
import { describe, it, expect, mock } from "bun:test";

// embedding-stamp.ts imports `{ databases } from "harper"` for
// its DEFAULT table accessor only (never used here — every test injects its
// own fake table via createEmbeddingStampMigration's first argument). Same
// workaround as migrations-ledger.test.ts: mock the module out before import
// so the real package's import-time side effects never fire.
mock.module("harper", () => ({ server: { http: () => {}, getUser: async () => null }, databases: {}, Resource: class {} }));

const { createEmbeddingStampMigration, EMBEDDING_STAMP_ID } = await import("../../resources/migrations/embedding-stamp.ts");
const { computeContentHash } = await import("../../resources/memory-feed-lib.ts");
const hashOf = (agentId: string, content: string) => computeContentHash(agentId, content);

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
    // flair#807: staleCondition()'s not-current leg now uses "not_equals"
    // (the `not_` prefix form real Harper resolves to a negated-equals leaf
    // — see embedding-stamp.ts's module doc) instead of the legacy
    // "not_equal" alias. Same value-level semantics either way; this fake
    // table doesn't model Harper's index-vs-live-record execution split
    // (that's exercised for real in test/integration/
    // migrations-embedding-stamp-e2e.test.ts), so both comparator spellings
    // are handled identically here.
    case "not_equals":
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
    expect(m.alwaysDetect).toBe(true);
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

describe("embedding-stamp migration — flair#807: staleCondition() comparator shape", () => {
  it("uses \"not_equals\" (the negated-form comparator), never the legacy \"not_equal\" alias, for the not-current leg", async () => {
    // Locks in the flair#807 fix: real Harper resolves "not_equals" (the
    // `not_` PREFIX form) to a `negated: true` leaf, which bypasses a
    // potentially stale/desynced secondary index and reads the live record
    // directly (see embedding-stamp.ts's module doc for the full mechanism,
    // root-caused against the installed harper source). The
    // legacy "not_equal" alias does NOT get this bypass — reverting to it
    // would silently reopen #807.
    const queries: any[] = [];
    const { table } = makeFakeMemoryTable([{ id: "m1", content: "a", embeddingModel: "old" }]);
    const spyTable = {
      ...table,
      search(query: any) {
        queries.push(query);
        return table.search(query);
      },
    };
    const m = createEmbeddingStampMigration(() => spyTable, () => CURRENT_MODEL, async () => true);
    await m.detect();

    expect(queries).toHaveLength(1);
    const orGroup = queries[0].conditions[0];
    expect(orGroup.operator).toBe("or");
    const notCurrentLeg = orGroup.conditions.find((c: any) => c.attribute === "embeddingModel" && c.value === CURRENT_MODEL);
    expect(notCurrentLeg.comparator).toBe("not_equals");
    expect(notCurrentLeg.comparator).not.toBe("not_equal");
  });
});

describe("embedding-stamp migration — flair#2465: no recheckPending() opt-in", () => {
  it("does not implement recheckPending(): countPending() is a live scan, so the runner's safety net has no index artifact to excuse", () => {
    const { table } = makeFakeMemoryTable([]);
    const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL, async () => true);
    expect(m.recheckPending).toBeUndefined();
  });
});

describe("embedding-stamp migration — flair#2465: the embedded-text hash binding", () => {
  it("detect()/countPending() catch a row whose stamp is current but whose embeddedContentHash no longer matches its text", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", agentId: "a", content: "the current text", embeddingModel: CURRENT_MODEL, embeddedContentHash: "a-stale-hash" },
    ]);
    const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL, async () => true);
    expect(await m.detect()).toBe(true);
    expect(await m.countPending()).toBe(1);
  });

  it("a row whose embeddedContentHash matches its current text is current (no false positive)", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", agentId: "a", content: "the current text", embeddingModel: CURRENT_MODEL, embeddedContentHash: hashOf("a", "the current text") },
    ]);
    const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL, async () => true);
    expect(await m.detect()).toBe(false);
    expect(await m.countPending()).toBe(0);
  });

  it("a row with NO embeddedContentHash counts as current (never re-queued for the missing hash alone)", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", agentId: "a", content: "a legacy row", embeddingModel: CURRENT_MODEL },
    ]);
    const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL, async () => true);
    expect(await m.detect()).toBe(false);
    expect(await m.countPending()).toBe(0);
  });

  it("a skill row binds to its trigger, not its content", async () => {
    const trigger = "when to use the skill";
    const { table } = makeFakeMemoryTable([
      { id: "s1", agentId: "a", content: "the procedure", trigger, tags: ["skill"], embeddingModel: CURRENT_MODEL, embeddedContentHash: hashOf("a", trigger) },
      { id: "s2", agentId: "a", content: "the procedure", trigger, tags: ["skill"], embeddingModel: CURRENT_MODEL, embeddedContentHash: hashOf("a", "the procedure") },
    ]);
    const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL, async () => true);
    // s1 is bound to the trigger it embeds from → current; s2 is bound to the
    // content, not the trigger → stale.
    expect(await m.countPending()).toBe(1);
  });

  it("run() selects a hash-mismatch row as a candidate (the fake regen stands in for the write)", async () => {
    const { store, table } = makeFakeMemoryTable([
      { id: "m1", agentId: "a", content: "the current text", embeddingModel: CURRENT_MODEL, embeddedContentHash: "a-stale-hash" },
    ]);
    const regen = async (id: string) => {
      const row = store.get(id)!;
      store.set(id, { ...row, embedding: [0.3, 0.2, 0.1], embeddingModel: CURRENT_MODEL, embeddedContentHash: hashOf(String(row.agentId), String(row.content)) });
      return true;
    };
    const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL, regen);
    const result = await m.run(10);
    expect(result).toEqual({ processed: 1, touchedIds: ["m1"] });
    expect(store.get("m1")!.embeddedContentHash).toBe(hashOf("a", "the current text"));
    expect(await m.countPending()).toBe(0);
  });
});

describe("embedding-stamp migration — a loopback PATCH that may have written", () => {
  it("reports a 503 write_outcome_unknown row as unconfirmed, not counted", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", agentId: "a1", content: "a", embeddingModel: null },
    ]);
    const originalFetch = globalThis.fetch;
    const originalPass = process.env.HDB_ADMIN_PASSWORD;
    process.env.HDB_ADMIN_PASSWORD = "test-admin-password";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "write_outcome_unknown" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      // No third argument: the real loopback regen path, with fetch answered above.
      const m = createEmbeddingStampMigration(() => table, () => CURRENT_MODEL);
      expect(await m.run(10)).toEqual({ processed: 0, touchedIds: [], unconfirmedIds: ["m1"] });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalPass === undefined) delete process.env.HDB_ADMIN_PASSWORD;
      else process.env.HDB_ADMIN_PASSWORD = originalPass;
    }
  });
});
