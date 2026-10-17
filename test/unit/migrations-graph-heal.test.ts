/**
 * migrations-graph-heal.test.ts — resources/migrations/graph-heal.ts, the
 * verify-only recall graph-heal OBSERVABILITY migration. Exercises
 * detect/countPending/run against an in-memory fake Memory table + a fake
 * OrgEvent table (no real Harper). The actual schema-driven HNSW rebuild is
 * proven end-to-end in test/integration/hnsw-graph-heal-e2e.test.ts; this
 * covers the migration's own logic: canary self-recall health gate,
 * observe-only (zero row work) semantics, and the structural-only ledger
 * event.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { tempDir } from "../helpers/temp-dir.ts";

// graph-heal.ts imports `{ databases } from "harper"` for its
// DEFAULT accessors only (never used here — every test injects fakes). Same
// workaround as migrations-embedding-stamp.test.ts: mock the module before
// import so its import-time side effects never fire.
import { mock } from "bun:test";
mock.module("harper", () => ({ server: { http: () => {}, getUser: async () => null }, databases: {}, Resource: class {} }));

const { createGraphHealMigration, GRAPH_HEAL_ID } = await import("../../resources/migrations/graph-heal.ts");
const { _resetGuardForTests, _setGuardModelIdForTests, _setGuardTableGetterForTests, recomputeLatch, noteWriteStamp, scheduleSpaceGuardPrewarm, _prewarmSettledForTests, spaceGuardState } =
  await import("../../resources/embedding-space-guard.ts");
const { runMigrationCycle } = await import("../../resources/migrations/runner.ts");
const { MigrationRegistry } = await import("../../resources/migrations/registry.ts");
const { readMigrationState, defaultStatePath } = await import("../../resources/migrations/state.ts");
const { listMigrationProgress, _resetProgressForTests } = await import("../../resources/migrations/progress.ts");
const { _resetInProcessLockForTests } = await import("../../resources/migrations/lock.ts");

const GUARD_CURRENT = "gguf:test-model";
const GUARD_FOREIGN = "other-engine:not-the-current-space";

/** A fake guard table over a fixed list of `embeddingModel` stamps. */
function guardTableOver(stamps: (string | null)[]) {
  return async () => ({
    search(_q: unknown) {
      async function* gen(): AsyncIterable<Record<string, unknown>> { for (const s of stamps) yield { embeddingModel: s }; }
      return gen();
    },
  });
}

/** Drive the guard to a verdict from the given stamps. */
async function guardVerdict(stamps: (string | null)[]): Promise<boolean> {
  _setGuardModelIdForTests(() => GUARD_CURRENT);
  _setGuardTableGetterForTests(guardTableOver(stamps));
  return recomputeLatch();
}

beforeEach(async () => {
  _resetGuardForTests();
  // Default: a uniform (empty) store, so the comparison tests below are
  // unchanged; the guard-specific tests re-drive it with a foreign stamp.
  expect(await guardVerdict([])).toBe(true);
});

type Row = Record<string, unknown> & { id: string };

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function makeFakeMemoryTable(rows: Row[], opts: { throwOnSort?: boolean } = {}) {
  const store = new Map<string, Row>(rows.map((r) => [r.id, { ...r }]));
  let cosineSearches = 0;
  const table = {
    async get(id: string) {
      return store.has(id) ? { ...store.get(id)! } : null;
    },
    search(query: any): AsyncIterable<Row> {
      // Cosine-sort (HNSW nearest-neighbor) query.
      if (query?.sort?.distance === "cosine") {
        cosineSearches++;
        if (opts.throwOnSort) throw new Error("HNSW index unavailable (mid-rebuild)");
        const target = query.sort.target as number[];
        const limit = typeof query.limit === "number" ? query.limit : Infinity;
        const ranked = Array.from(store.values())
          .filter((r) => Array.isArray((r as any).embedding) && (r as any).embedding.length > 0)
          .map((r) => ({ r, c: cosine(target, (r as any).embedding) }))
          .sort((a, b) => b.c - a.c)
          .slice(0, limit)
          .map((x) => ({ id: x.r.id }) as Row);
        return (async function* () {
          for (const r of ranked) yield r;
        })();
      }
      // Plain listing / select query.
      const limit = typeof query?.limit === "number" ? query.limit : Infinity;
      const out = Array.from(store.values()).slice(0, limit).map((r) => ({ ...r }));
      return (async function* () {
        for (const r of out) yield r;
      })();
    },
  };
  return { store, table, cosineSearches: () => cosineSearches };
}

function makeFakeOrgEventTable() {
  const puts: any[] = [];
  return {
    puts,
    table: {
      async put(content: unknown) {
        puts.push(content);
        return content;
      },
    },
  };
}

const VERSION = "9.9.9-test";
const emb = (seed: number, dim = 8): number[] =>
  Array.from({ length: dim }, (_, i) => Math.sin(seed * 7.13 + i * 1.7));

describe("graph-heal migration — identity", () => {
  it("has the expected id, derived-only risk class, and Memory scope", () => {
    const { table } = makeFakeMemoryTable([]);
    const { table: oe } = makeFakeOrgEventTable();
    const m = createGraphHealMigration(() => table, () => oe, () => VERSION);
    expect(m.id).toBe(GRAPH_HEAL_ID);
    expect(m.riskClass).toBe("derived-only");
    expect(m.affectsTables).toEqual(["Memory"]);
  });

  it("countPending() is always 0 — the migration is observe-only, never touches rows", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", embedding: emb(1), embeddingModel: "real" },
    ]);
    const { table: oe } = makeFakeOrgEventTable();
    const m = createGraphHealMigration(() => table, () => oe, () => VERSION);
    expect(await m.countPending()).toBe(0);
  });
});

describe("graph-heal migration — detect() (canary self-recall health gate)", () => {
  it("false on an empty store (no embedded data → nothing to heal or verify)", async () => {
    const { table } = makeFakeMemoryTable([]);
    const { table: oe } = makeFakeOrgEventTable();
    const m = createGraphHealMigration(() => table, () => oe, () => VERSION);
    expect(await m.detect()).toBe(false);
  });

  it("false when rows exist but none carry an embedding", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", content: "no vector", embeddingModel: null },
    ]);
    const { table: oe } = makeFakeOrgEventTable();
    const m = createGraphHealMigration(() => table, () => oe, () => VERSION);
    expect(await m.detect()).toBe(false);
  });

  it("true when the canary self-recalls at rank 1 (healthy, serving graph)", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", embedding: emb(1), embeddingModel: "real" },
      { id: "m2", embedding: emb(2), embeddingModel: "real" },
      { id: "m3", embedding: emb(3), embeddingModel: "real" },
    ]);
    const { table: oe } = makeFakeOrgEventTable();
    const m = createGraphHealMigration(() => table, () => oe, () => VERSION);
    expect(await m.detect()).toBe(true);
  });

  it("false (non-throwing) when the HNSW index is unavailable / mid-rebuild (cosine query throws)", async () => {
    const { table } = makeFakeMemoryTable(
      [{ id: "m1", embedding: emb(1), embeddingModel: "real" }],
      { throwOnSort: true },
    );
    const { table: oe } = makeFakeOrgEventTable();
    const m = createGraphHealMigration(() => table, () => oe, () => VERSION);
    // Must resolve to false, never reject.
    await expect(m.detect()).resolves.toBe(false);
  });
});

describe("graph-heal migration — run() (verify + structural-only ledger)", () => {
  it("writes ONE structural-only OrgEvent (verified, vector count, version — never a memory id/content) and reports zero rows processed", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", content: "secret-alpha", embedding: emb(1), embeddingModel: "real" },
      { id: "m2", content: "secret-beta", embedding: emb(2), embeddingModel: "real" },
      { id: "m3", content: "secret-gamma", embedding: emb(3), embeddingModel: "hash-512d" }, // hash-fallback, not a real vector
    ]);
    const { table: oe, puts } = makeFakeOrgEventTable();
    const m = createGraphHealMigration(() => table, () => oe, () => VERSION);

    const result = await m.run(50);
    expect(result.processed).toBe(0);
    expect(result.touchedIds).toEqual([]);

    expect(puts).toHaveLength(1);
    const evt = puts[0];
    expect(evt.kind).toBe("migration");
    expect(evt.refId).toBe(GRAPH_HEAL_ID);
    expect(evt.authorId).toBe("flair-migrations");
    const detail = JSON.parse(evt.detail);
    expect(detail.migrationId).toBe(GRAPH_HEAL_ID);
    expect(detail.verified).toBe(true);
    expect(detail.embeddedVectorCount).toBe(2); // m1 + m2 (m3 is hash-fallback)
    expect(detail.runningVersion).toBe(VERSION);

    // Structural-only discipline: no memory id or content leaks into the event.
    const blob = JSON.stringify(evt);
    expect(blob).not.toContain("secret-");
    expect(blob).not.toContain("m1");
    expect(blob).not.toContain("m2");
  });

  it("returns zero processed when verified recall's OrgEvent write fails", async () => {
    const { table } = makeFakeMemoryTable([
      { id: "m1", embedding: emb(1), embeddingModel: "real" },
    ]);
    const throwingOrgEvent = {
      async put() {
        throw new Error("OrgEvent table unavailable");
      },
    };
    const m = createGraphHealMigration(() => table, () => throwingOrgEvent, () => VERSION);
    const result = await m.run(50);
    expect(result.processed).toBe(0);
  });
});

describe("graph-heal migration — consults the embedding-space guard (flair#2596)", () => {
  function healthyStore() {
    const createdAt = new Date().toISOString();
    return makeFakeMemoryTable([
      { id: "m1", agentId: "agent-a", content: "alpha", createdAt, embedding: emb(1), embeddingModel: "real" },
      { id: "m2", agentId: "agent-a", content: "beta", createdAt, embedding: emb(2), embeddingModel: "real" },
    ]);
  }

  it("halts without a success marker after a guard trip between detect and run, continues the cycle, and retries", async () => {
    _resetProgressForTests();
    _resetInProcessLockForTests();
    const dataDir = tempDir("flair-graph-heal-guard-");
    const { table } = healthyStore();
    const { table: oe, puts } = makeFakeOrgEventTable();
    const migration = createGraphHealMigration(() => table, () => oe, () => VERSION);
    expect(await migration.detect()).toBe(true);
    let continued = false;
    let trip = true;
    const registry = new MigrationRegistry().register(migration).register({
      id: "after-graph-heal", riskClass: "derived-only", affectsTables: ["Memory"],
      detect: async () => true,
      countPending: async () => 0,
      run: async () => { continued = true; return { processed: 0, touchedIds: [] }; },
    });
    const deps = {
      registry, dataDir, runningVersion: VERSION,
      getTable: (name: string) => name === "Memory" ? table : makeFakeMemoryTable([]).table,
      spaceProbe: {
        getFreeBytes: () => {
          if (trip) { trip = false; noteWriteStamp(GUARD_FOREIGN); }
          return 10 * 1024 ** 3;
        },
        getTotalBytes: () => 20 * 1024 ** 3,
      },
      ledgerDeps: { orgEventTable: oe },
    };
    expect(await runMigrationCycle(deps)).toEqual({ ran: true });
    expect(continued).toBe(true);
    const state = readMigrationState(defaultStatePath(dataDir));
    expect(state[GRAPH_HEAL_ID]?.lastOutcome).toBe("halted");
    expect(state[GRAPH_HEAL_ID]?.completedAtVersion).toBeUndefined();
    expect(state[GRAPH_HEAL_ID]?.completedAt).toBeUndefined();
    expect(state["after-graph-heal"]?.lastOutcome).toBe("success");
    expect(listMigrationProgress().find((p) => p.id === GRAPH_HEAL_ID)).toMatchObject({
      state: "halted", reason: "run() threw mid-batch: graph-heal: recall re-verification failed",
    });
    expect(puts.map((p) => JSON.parse(p.detail)).filter((p) => p.migrationId === GRAPH_HEAL_ID))
      .toEqual([expect.objectContaining({ outcome: "halted" })]);

    expect(await guardVerdict([])).toBe(true);
    expect(await runMigrationCycle(deps)).toEqual({ ran: true });
    expect(readMigrationState(defaultStatePath(dataDir))[GRAPH_HEAL_ID]).toMatchObject({
      lastOutcome: "success", completedAtVersion: VERSION,
    });
  });

  it("retries a failed startup guard scan through a later migration cycle and completes", async () => {
    _resetGuardForTests();
    _resetProgressForTests();
    _resetInProcessLockForTests();
    _setGuardModelIdForTests(() => GUARD_CURRENT);
    let tableReads = 0;
    let releaseRetry!: () => void;
    const retryReady = new Promise<void>((resolve) => { releaseRetry = resolve; });
    const { table, store } = healthyStore();
    for (const row of store.values()) row.embeddingModel = GUARD_CURRENT;
    _setGuardTableGetterForTests(async () => {
      if (++tableReads === 1) throw new Error("Memory not ready");
      await retryReady;
      return table;
    });
    scheduleSpaceGuardPrewarm();
    await _prewarmSettledForTests({ FLAIR_ENABLE_TEST_FAULT_INJECTION: "1" });
    expect(tableReads).toBe(1);
    expect(spaceGuardState().state).toBe("scan-failed");

    const dataDir = tempDir("flair-graph-heal-startup-retry-");
    const { table: oe } = makeFakeOrgEventTable();
    const registry = new MigrationRegistry().register(createGraphHealMigration(() => table, () => oe, () => VERSION));
    const deps = {
      registry, dataDir, runningVersion: VERSION,
      getTable: () => table,
      spaceProbe: { getFreeBytes: () => 10 * 1024 ** 3, getTotalBytes: () => 20 * 1024 ** 3 },
      ledgerDeps: { orgEventTable: oe },
    };
    try {
      expect(await runMigrationCycle(deps)).toEqual({ ran: false, reason: "nothing pending" });
      expect(tableReads).toBe(2);
      expect(readMigrationState(defaultStatePath(dataDir))[GRAPH_HEAL_ID]?.completedAtVersion).toBeUndefined();
    } finally {
      releaseRetry();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(spaceGuardState().state).toBe("uniform");
    expect(await runMigrationCycle(deps)).toEqual({ ran: true });
    expect(readMigrationState(defaultStatePath(dataDir))[GRAPH_HEAL_ID]).toMatchObject({
      lastOutcome: "success", completedAtVersion: VERSION,
    });
    expect(tableReads).toBe(2);
  });

  it("(uniform) verifies the canary self-recall — behaviour unchanged", async () => {
    const { table } = healthyStore();
    const { table: oe } = makeFakeOrgEventTable();
    const m = createGraphHealMigration(() => table, () => oe, () => VERSION);
    expect(await m.detect()).toBe(true);
  });

  it("(non-uniform) skips the cosine comparison and logs the guard state", async () => {
    const { table, cosineSearches } = healthyStore();
    const { table: oe } = makeFakeOrgEventTable();
    const m = createGraphHealMigration(() => table, () => oe, () => VERSION);

    // Same store as the control above — it WOULD self-recall — but a foreign
    // stamp makes the guard's verdict non-uniform, so the comparison is skipped.
    expect(await guardVerdict([GUARD_CURRENT, GUARD_FOREIGN])).toBe(false);

    const warns: string[] = [];
    const saved = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
    try {
      expect(await m.detect()).toBe(false);
    } finally {
      console.warn = saved;
    }
    expect(warns.some((w) => w.includes("graph-heal") && w.includes("mixed"))).toBe(true);
    expect(cosineSearches()).toBe(0);
  });
});
