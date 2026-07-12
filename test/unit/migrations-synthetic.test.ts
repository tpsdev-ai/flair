/**
 * migrations-synthetic.test.ts — resources/migrations/synthetic-test-migration.ts:
 * the CI-only migration variant. Covers the exact no-ship gating condition
 * (K&S verdict: "registration conditional on test/CI env; a prod user must
 * never see a spurious ci-variant migration on first boot") and the
 * migration's own scoping to a reserved test agent id (belt-and-suspenders
 * even though the gate is what actually keeps it out of production).
 */
import { describe, it, expect, mock } from "bun:test";

mock.module("@harperfast/harper", () => ({ databases: {}, Resource: class {} }));

const {
  createSyntheticTestMigration,
  shouldRegisterSyntheticMigration,
  SYNTHETIC_MIGRATION_ID,
  RESERVED_TEST_AGENT_ID,
  SYNTHETIC_TARGET_MARKER,
  ENABLE_TEST_MIGRATIONS_ENV,
} = await import("../../resources/migrations/synthetic-test-migration.ts");

type Row = Record<string, unknown> & { id: string };

function makeFakeMemoryTable(seed: Row[]) {
  const store = new Map<string, Row>(seed.map((r) => [r.id, { ...r }]));
  const puts: Row[] = [];
  return {
    store,
    puts,
    table: {
      async get(id: string) {
        return store.has(id) ? { ...store.get(id)! } : null;
      },
      async put(content: Row) {
        store.set(content.id, { ...content });
        puts.push({ ...content });
        return content;
      },
      search(query: any): AsyncIterable<Row> {
        const conditions = Array.isArray(query?.conditions) ? query.conditions : [];
        const limit = typeof query?.limit === "number" ? query.limit : Infinity;
        let rows = Array.from(store.values());
        for (const c of conditions) {
          if (c.comparator === "not_equal") rows = rows.filter((r) => r[c.attribute] !== c.value);
          else if (c.comparator === "equals") rows = rows.filter((r) => r[c.attribute] === c.value);
        }
        rows = rows.slice(0, limit);
        async function* gen() {
          for (const r of rows) yield { ...r };
        }
        return gen();
      },
    },
  };
}

describe("shouldRegisterSyntheticMigration — the no-ship gate", () => {
  it("false when the env var is unset (the default — a prod user never sees this)", () => {
    expect(shouldRegisterSyntheticMigration({})).toBe(false);
  });

  it("false for any value other than the exact string \"1\" (no truthy-string leniency)", () => {
    expect(shouldRegisterSyntheticMigration({ [ENABLE_TEST_MIGRATIONS_ENV]: "true" })).toBe(false);
    expect(shouldRegisterSyntheticMigration({ [ENABLE_TEST_MIGRATIONS_ENV]: "yes" })).toBe(false);
    expect(shouldRegisterSyntheticMigration({ [ENABLE_TEST_MIGRATIONS_ENV]: "0" })).toBe(false);
    expect(shouldRegisterSyntheticMigration({ [ENABLE_TEST_MIGRATIONS_ENV]: "" })).toBe(false);
  });

  it("true only for the exact string \"1\"", () => {
    expect(shouldRegisterSyntheticMigration({ [ENABLE_TEST_MIGRATIONS_ENV]: "1" })).toBe(true);
  });

  it("a generic NODE_ENV=test does NOT enable it (explicit opt-in only, per the verdict)", () => {
    expect(shouldRegisterSyntheticMigration({ NODE_ENV: "test" })).toBe(false);
  });
});

describe("synthetic migration — identity and scoping", () => {
  it("has the expected id and risk class (schema-additive — the full-envelope gate path)", () => {
    const { table } = makeFakeMemoryTable([]);
    const m = createSyntheticTestMigration(() => table);
    expect(m.id).toBe(SYNTHETIC_MIGRATION_ID);
    expect(m.riskClass).toBe("schema-additive");
    expect(m.affectsTables).toEqual(["Memory"]);
  });

  it("detect()/run() NEVER touch a row belonging to a real (non-reserved) agentId, even if it would otherwise match the marker condition", async () => {
    const { table, puts } = makeFakeMemoryTable([
      { id: "real-1", content: "a real memory", agentId: "nathan", source: "something-else" },
    ]);
    const m = createSyntheticTestMigration(() => table);
    expect(await m.detect()).toBe(false); // scoped condition requires agentId === RESERVED_TEST_AGENT_ID
    expect(await m.countPending()).toBe(0);
    await m.run(50);
    expect(puts).toHaveLength(0);
  });

  it("RESERVED_TEST_AGENT_ID is a clearly-synthetic, never-real-looking identifier", () => {
    expect(RESERVED_TEST_AGENT_ID).toContain("synthetic");
    expect(RESERVED_TEST_AGENT_ID).toContain("test");
  });
});

describe("synthetic migration — detect/run/marker convergence (the full runner path payload)", () => {
  it("detects pending rows scoped to the reserved test agent", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "s1", content: "x", agentId: RESERVED_TEST_AGENT_ID, source: "not-yet" },
      { id: "s2", content: "y", agentId: RESERVED_TEST_AGENT_ID, source: SYNTHETIC_TARGET_MARKER },
    ]);
    const m = createSyntheticTestMigration(() => table);
    expect(await m.detect()).toBe(true);
    expect(await m.countPending()).toBe(1);
  });

  it("run() stamps `source` to the target marker via a full-record merge, preserving other fields", async () => {
    const { table, store } = makeFakeMemoryTable([
      { id: "s1", content: "x", agentId: RESERVED_TEST_AGENT_ID, tags: ["keep-me"], source: "not-yet" },
    ]);
    const m = createSyntheticTestMigration(() => table);
    const result = await m.run(50);
    expect(result.processed).toBe(1);
    expect(result.touchedIds).toEqual(["s1"]);

    const written = store.get("s1")!;
    expect(written.source).toBe(SYNTHETIC_TARGET_MARKER);
    expect(written.tags).toEqual(["keep-me"]); // untouched — full-record merge, not a partial write

    expect(await m.countPending()).toBe(0);
    expect(await m.detect()).toBe(false);
  });

  it("is idempotent — a second run() on already-stamped rows is a no-op", async () => {
    const { table, puts } = makeFakeMemoryTable([
      { id: "s1", content: "x", agentId: RESERVED_TEST_AGENT_ID, source: "not-yet" },
    ]);
    const m = createSyntheticTestMigration(() => table);
    await m.run(50);
    expect(puts).toHaveLength(1);

    const second = await m.run(50);
    expect(second.processed).toBe(0);
    expect(puts).toHaveLength(1); // no additional put() calls
  });

  it("resumes correctly across multiple batches smaller than the pending set", async () => {
    const rows: Row[] = Array.from({ length: 7 }, (_, i) => ({
      id: `s${i}`,
      content: `c${i}`,
      agentId: RESERVED_TEST_AGENT_ID,
      source: "not-yet",
    }));
    const { table } = makeFakeMemoryTable(rows);
    const m = createSyntheticTestMigration(() => table);

    let totalProcessed = 0;
    for (;;) {
      const r = await m.run(3);
      totalProcessed += r.processed;
      if (r.processed === 0) break;
    }
    expect(totalProcessed).toBe(7);
    expect(await m.countPending()).toBe(0);
  });
});
