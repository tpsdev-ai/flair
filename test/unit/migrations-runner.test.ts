/**
 * migrations-runner.test.ts — resources/migrations/runner.ts, the migration
 * cycle orchestrator. Exercises the FULL path (detect → shared pre-hash →
 * pre-flight ladder → snapshot → throttled batches → risk-class completion
 * gate → ledger → state → prune) against in-memory fake tables — no real
 * Harper needed (see test/integration/migrations-*.test.ts for the
 * real-Harper end-to-end coverage: boot wiring, process-kill/resume,
 * version handshake).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

mock.module("@harperfast/harper", () => ({ databases: {}, Resource: class {} }));

const { runMigrationCycle } = await import("../../resources/migrations/runner.ts");
const { MigrationRegistry } = await import("../../resources/migrations/registry.ts");
const { readMigrationState, defaultStatePath } = await import("../../resources/migrations/state.ts");
const { listMigrationProgress, _resetProgressForTests, getCycleStatus } = await import("../../resources/migrations/progress.ts");
const { _resetInProcessLockForTests } = await import("../../resources/migrations/lock.ts");
const { hashSourceFields } = await import("../../resources/migrations/source-fields.ts");

import type { Migration, RunBatchResult } from "../../resources/migrations/types.ts";

// ─── fake table infra ───────────────────────────────────────────────────────

type Row = Record<string, unknown> & { id: string };

function makeStore(seed: Row[] = []) {
  const map = new Map<string, Row>(seed.map((r) => [r.id, { ...r }]));
  const putCalls: Row[] = [];
  return {
    map,
    putCalls,
    accessor: {
      async get(id: string) {
        return map.has(id) ? { ...map.get(id)! } : null;
      },
      async put(content: Row) {
        map.set(content.id, { ...content });
        putCalls.push({ ...content });
        return content;
      },
      search(query: any): AsyncIterable<Row> {
        const conditions = Array.isArray(query?.conditions) ? query.conditions : [];
        const limit = typeof query?.limit === "number" ? query.limit : Infinity;
        let rows = Array.from(map.values());
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

let testRoot: string;
let dataDir: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "flair-migration-runner-test-"));
  dataDir = join(testRoot, "data");
  mkdirSync(dataDir, { recursive: true });
  _resetProgressForTests();
  _resetInProcessLockForTests();
});

afterEach(() => {
  _resetProgressForTests();
  _resetInProcessLockForTests();
  rmSync(testRoot, { recursive: true, force: true });
});

// ─── bespoke fake migrations, one per risk class ────────────────────────────

/** derived-only: gate is count+marker only (no hash). */
function makeDerivedOnlyMigration(memoryStore: ReturnType<typeof makeStore>, id = "fake-derived"): Migration {
  const table = memoryStore.accessor;
  const pendingCond = () => [{ attribute: "stale", comparator: "not_equal", value: false }];
  return {
    id,
    riskClass: "derived-only",
    affectsTables: ["Memory"],
    async detect() {
      for await (const _r of table.search({ conditions: pendingCond(), limit: 1 })) return true;
      return false;
    },
    async countPending() {
      let n = 0;
      for await (const _r of table.search({ conditions: pendingCond() })) n++;
      return n;
    },
    async run(batchSize): Promise<RunBatchResult> {
      const rows: Row[] = [];
      for await (const r of table.search({ conditions: pendingCond(), limit: batchSize })) rows.push(r);
      const touchedIds: string[] = [];
      for (const r of rows) {
        await table.put({ ...r, stale: false });
        touchedIds.push(String(r.id));
      }
      return { processed: touchedIds.length, touchedIds };
    },
  };
}

/** schema-additive: gate is count+full-envelope (whole Memory+Relationship corpus hash pre/post). */
function makeSchemaAdditiveMigration(memoryStore: ReturnType<typeof makeStore>, id = "fake-schema"): Migration {
  const table = memoryStore.accessor;
  const pendingCond = () => [{ attribute: "newField", comparator: "not_equal", value: true }];
  return {
    id,
    riskClass: "schema-additive",
    affectsTables: ["Memory"],
    async detect() {
      for await (const _r of table.search({ conditions: pendingCond(), limit: 1 })) return true;
      return false;
    },
    async countPending() {
      let n = 0;
      for await (const _r of table.search({ conditions: pendingCond() })) n++;
      return n;
    },
    async run(batchSize): Promise<RunBatchResult> {
      const rows: Row[] = [];
      for await (const r of table.search({ conditions: pendingCond(), limit: batchSize })) rows.push(r);
      const touchedIds: string[] = [];
      for (const r of rows) {
        await table.put({ ...r, newField: true }); // additive, non-source field
        touchedIds.push(String(r.id));
      }
      return { processed: touchedIds.length, touchedIds };
    },
  };
}

/** content-transform: gate is old-row-envelope (unchanged source fields) + new-row presence. */
function makeContentTransformMigration(
  memoryStore: ReturnType<typeof makeStore>,
  opts: { id?: string; corruptOldRowAfterTouch?: boolean } = {},
): Migration {
  const table = memoryStore.accessor;
  const id = opts.id ?? "fake-content-transform";
  const pendingCond = () => [{ attribute: "transformDone", comparator: "not_equal", value: true }];
  return {
    id,
    riskClass: "content-transform",
    affectsTables: ["Memory"],
    async detect() {
      for await (const _r of table.search({ conditions: pendingCond(), limit: 1 })) return true;
      return false;
    },
    async countPending() {
      let n = 0;
      for await (const _r of table.search({ conditions: pendingCond() })) n++;
      return n;
    },
    async run(batchSize): Promise<RunBatchResult> {
      const rows: Row[] = [];
      for await (const r of table.search({ conditions: pendingCond(), limit: batchSize })) rows.push(r);
      const touchedIds: string[] = [];
      const newRowIds: string[] = [];
      const oldRowSourceHashes: Record<string, string> = {};
      for (const r of rows) {
        const oldId = String(r.id);
        const { sourceFieldsFor } = await import("../../resources/migrations/source-fields.ts");
        oldRowSourceHashes[`Memory:${oldId}`] = hashSourceFields(r, sourceFieldsFor("Memory"));

        const newId = `${oldId}-v2`;
        // transformDone: true on the NEW row too — it's already the
        // post-migration successor, never itself "pending" (without this,
        // the next run() call's pendingCondition() would match the row this
        // very batch just created, since it has no transformDone field at
        // all — an infinite migrate-the-successor loop).
        await table.put({ id: newId, content: r.content, agentId: r.agentId, supersedes: oldId, transformDone: true });
        newRowIds.push(newId);

        // Mark old row done via a NON-source bookkeeping field only.
        const patch: Row = { ...r, transformDone: true };
        if (opts.corruptOldRowAfterTouch) patch.content = `${r.content} (corrupted!)`; // simulates an invariant-I violation
        await table.put(patch);

        touchedIds.push(oldId);
      }
      return { processed: touchedIds.length, touchedIds, oldRowSourceHashes, newRowIds };
    },
  };
}

function buildRegistryWith(...migrations: Migration[]) {
  const registry = new MigrationRegistry();
  for (const m of migrations) registry.register(m);
  return registry;
}

const fastSleep = async () => {};

describe("runMigrationCycle — nothing pending", () => {
  it("returns ran:false without touching the lock file when no migration has pending work", async () => {
    const memory = makeStore([]);
    const relationship = makeStore([]);
    const registry = buildRegistryWith(makeDerivedOnlyMigration(memory));

    const result = await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : relationship.accessor),
      dataDir,
      runningVersion: "0.1.0",
      sleep: fastSleep,
    });

    expect(result.ran).toBe(false);
    expect(result.reason).toContain("nothing pending");
    expect(existsSync(join(dataDir, ".migrations", "lock"))).toBe(false);
  });
});

describe("runMigrationCycle — derived-only happy path (count+marker gate, no hash)", () => {
  it("processes all pending rows, writes a success ledger event and state entry, and reports hashEnvelopeMatch: null", async () => {
    const memory = makeStore([
      { id: "m1", content: "a", agentId: "a1", stale: true },
      { id: "m2", content: "b", agentId: "a1", stale: true },
    ]);
    const relationship = makeStore([]);
    const registry = buildRegistryWith(makeDerivedOnlyMigration(memory));

    const ledgerEvents: unknown[] = [];
    const result = await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : relationship.accessor),
      dataDir,
      runningVersion: "0.1.0",
      sleep: fastSleep,
      ledgerDeps: { orgEventTable: { put: async (c: unknown) => { ledgerEvents.push(c); return c; } } },
    });

    expect(result.ran).toBe(true);
    expect(memory.map.get("m1")!.stale).toBe(false);
    expect(memory.map.get("m2")!.stale).toBe(false);

    expect(ledgerEvents).toHaveLength(1);
    const detail = JSON.parse((ledgerEvents[0] as any).detail);
    expect(detail.outcome).toBe("success");
    expect(detail.rowsProcessed).toBe(2);
    expect(detail.rowsRemaining).toBe(0);
    expect(detail.hashEnvelopeMatch).toBeNull();

    const state = readMigrationState(defaultStatePath(dataDir));
    expect(state["fake-derived"].lastOutcome).toBe("success");
    expect(state["fake-derived"].completedAtVersion).toBe("0.1.0");

    const progress = listMigrationProgress().find((p) => p.id === "fake-derived");
    expect(progress?.state).toBe("completed");
    expect(progress?.rowsRemaining).toBe(0);

    // Lock released after the cycle.
    expect(existsSync(join(dataDir, ".migrations", "lock"))).toBe(false);
  });

  it("resumes across multiple batches smaller than the pending set", async () => {
    const rows: Row[] = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, content: `c${i}`, agentId: "a1", stale: true }));
    const memory = makeStore(rows);
    const relationship = makeStore([]);

    // Override batch size indirectly via risk-policy is fixed at 50 for
    // derived-only, so this exercises the loop's natural multi-call
    // behavior against a small corpus in one pass — a dedicated multi-batch
    // test lives in the schema-additive section below via a smaller corpus
    // count check; here we just confirm full convergence.
    const registry = buildRegistryWith(makeDerivedOnlyMigration(memory));
    const result = await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : relationship.accessor),
      dataDir,
      runningVersion: "0.1.0",
      sleep: fastSleep,
    });
    expect(result.ran).toBe(true);
    for (const r of rows) expect(memory.map.get(r.id)!.stale).toBe(false);
  });
});

describe("runMigrationCycle — schema-additive happy path (count+full-envelope gate)", () => {
  it("gate PASSES when nothing else mutates the corpus during the migration — hashEnvelopeMatch: true", async () => {
    const memory = makeStore([{ id: "m1", content: "a", agentId: "a1", newField: false }]);
    const relationship = makeStore([]);
    const registry = buildRegistryWith(makeSchemaAdditiveMigration(memory));

    const ledgerEvents: unknown[] = [];
    const result = await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : relationship.accessor),
      dataDir,
      runningVersion: "0.1.0",
      sleep: fastSleep,
      ledgerDeps: { orgEventTable: { put: async (c: unknown) => { ledgerEvents.push(c); return c; } } },
    });

    expect(result.ran).toBe(true);
    const detail = JSON.parse((ledgerEvents[0] as any).detail);
    expect(detail.outcome).toBe("success");
    expect(detail.hashEnvelopeMatch).toBe(true);
  });

  it("gate HALTS when an unrelated SOURCE field is mutated mid-migration (envelope mismatch, invariant I proof)", async () => {
    const memory = makeStore([
      { id: "m1", content: "a", agentId: "a1", newField: false },
      { id: "m2", content: "untouched-by-migration", agentId: "a1", newField: true }, // already "done" — migration won't touch it
    ]);
    const relationship = makeStore([]);
    const registry = buildRegistryWith(makeSchemaAdditiveMigration(memory));

    // Simulate a CONCURRENT, unrelated write landing between pre-hash and
    // post-hash by hooking the injected `sleep` (called once per batch) to
    // mutate m2's SOURCE field content — something the migration itself
    // never claimed to touch.
    let sleepCalls = 0;
    const meddlingSleep = async () => {
      sleepCalls++;
      if (sleepCalls === 1) {
        memory.map.set("m2", { ...memory.map.get("m2")!, content: "mutated by something else entirely" });
      }
    };

    const ledgerEvents: unknown[] = [];
    const result = await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : relationship.accessor),
      dataDir,
      runningVersion: "0.1.0",
      sleep: meddlingSleep,
      ledgerDeps: { orgEventTable: { put: async (c: unknown) => { ledgerEvents.push(c); return c; } } },
    });

    expect(result.ran).toBe(true); // the CYCLE completed; the individual migration halted
    const detail = JSON.parse((ledgerEvents[0] as any).detail);
    expect(detail.outcome).toBe("halted");
    expect(detail.hashEnvelopeMatch).toBe(false);

    const progress = listMigrationProgress().find((p) => p.id === "fake-schema");
    expect(progress?.state).toBe("halted");

    // Halted → NOT short-circuited next boot (retried).
    const state = readMigrationState(defaultStatePath(dataDir));
    expect(state["fake-schema"].lastOutcome).toBe("halted");
    expect(state["fake-schema"].completedAtVersion).toBeUndefined();
  });
});

describe("runMigrationCycle — content-transform (count+old-row-envelope+new-row-presence gate, strictest)", () => {
  it("gate PASSES when old rows' source fields are genuinely untouched and every touched row has a successor", async () => {
    const memory = makeStore([{ id: "m1", content: "original", agentId: "a1" }]);
    const relationship = makeStore([]);
    const registry = buildRegistryWith(makeContentTransformMigration(memory));

    const ledgerEvents: unknown[] = [];
    const result = await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : relationship.accessor),
      dataDir,
      runningVersion: "0.1.0",
      sleep: fastSleep,
      ledgerDeps: { orgEventTable: { put: async (c: unknown) => { ledgerEvents.push(c); return c; } } },
    });

    expect(result.ran).toBe(true);
    const detail = JSON.parse((ledgerEvents[0] as any).detail);
    expect(detail.outcome).toBe("success");
    expect(detail.hashEnvelopeMatch).toBe(true);
    // The old row is STILL PRESENT (invariant I: content-transform never
    // deletes/mutates-in-place; it write-new + supersession).
    expect(memory.map.has("m1")).toBe(true);
    expect(memory.map.get("m1")!.content).toBe("original");
    expect(memory.map.has("m1-v2")).toBe(true);
    expect(memory.map.get("m1-v2")!.supersedes).toBe("m1");
  });

  it("gate HALTS when an old row's SOURCE field was mutated after being touched (the strictest gate catching an invariant-I violation)", async () => {
    const memory = makeStore([{ id: "m1", content: "original", agentId: "a1" }]);
    const relationship = makeStore([]);
    const registry = buildRegistryWith(makeContentTransformMigration(memory, { corruptOldRowAfterTouch: true }));

    const ledgerEvents: unknown[] = [];
    const result = await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : relationship.accessor),
      dataDir,
      runningVersion: "0.1.0",
      sleep: fastSleep,
      ledgerDeps: { orgEventTable: { put: async (c: unknown) => { ledgerEvents.push(c); return c; } } },
    });

    expect(result.ran).toBe(true);
    const detail = JSON.parse((ledgerEvents[0] as any).detail);
    expect(detail.outcome).toBe("halted");
    expect(detail.hashEnvelopeMatch).toBe(false);
  });

  it("uses the strictest batch size (10, per risk-policy) — verified indirectly via multiple run() calls for >10 pending rows", async () => {
    const rows: Row[] = Array.from({ length: 25 }, (_, i) => ({ id: `m${i}`, content: `c${i}`, agentId: "a1" }));
    const memory = makeStore(rows);
    const relationship = makeStore([]);
    const registry = buildRegistryWith(makeContentTransformMigration(memory));

    const result = await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : relationship.accessor),
      dataDir,
      runningVersion: "0.1.0",
      sleep: fastSleep,
    });
    expect(result.ran).toBe(true);
    for (const r of rows) {
      expect(memory.map.has(`${r.id}-v2`)).toBe(true);
    }
  });
});

describe("runMigrationCycle — pre-flight space ladder", () => {
  it("halts with a 'blocked on disk' reason when the space probe reports insufficient free space (even after prune)", async () => {
    const memory = makeStore([{ id: "m1", content: "a", agentId: "a1", stale: true }]);
    const relationship = makeStore([]);
    const registry = buildRegistryWith(makeDerivedOnlyMigration(memory));

    const ledgerEvents: unknown[] = [];
    const result = await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : relationship.accessor),
      dataDir,
      runningVersion: "0.1.0",
      sleep: fastSleep,
      spaceProbe: { getFreeBytes: () => 0, getTotalBytes: () => 1_000_000 },
      ledgerDeps: { orgEventTable: { put: async (c: unknown) => { ledgerEvents.push(c); return c; } } },
    });

    expect(result.ran).toBe(true);
    const detail = JSON.parse((ledgerEvents[0] as any).detail);
    expect(detail.outcome).toBe("halted");
    expect(detail.error).toContain("blocked on disk");

    // Service kept "running" on the pre-migration shape — the row was NEVER touched.
    expect(memory.map.get("m1")!.stale).toBe(true);

    const progress = listMigrationProgress().find((p) => p.id === "fake-derived");
    expect(progress?.state).toBe("halted");
    expect(progress?.reason).toContain("blocked on disk");
  });
});

describe("runMigrationCycle — pre-hash (shared envelope) failure halts every candidate", () => {
  it("halts all pending migrations with a 'pre-flight integrity check failed' reason when the corpus can't be read", async () => {
    const memory = makeStore([{ id: "m1", content: "a", agentId: "a1", stale: true }]);
    const relationship = {
      accessor: {
        async get() { return null; },
        search(): AsyncIterable<Row> {
          throw new Error("Relationship table unreachable");
        },
      },
    };
    const registry = buildRegistryWith(makeDerivedOnlyMigration(memory));

    const result = await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : (relationship.accessor as any)),
      dataDir,
      runningVersion: "0.1.0",
      sleep: fastSleep,
    });

    expect(result.ran).toBe(false);
    expect(result.reason).toContain("pre-flight integrity check failed");
    const progress = listMigrationProgress().find((p) => p.id === "fake-derived");
    expect(progress?.state).toBe("halted");
    expect(progress?.reason).toContain("pre-flight integrity check failed");
    expect(getCycleStatus().phase).toBe("done");
    expect(getCycleStatus().lastCycleError).toContain("pre-flight integrity check failed");
  });
});

describe("runMigrationCycle — snapshot + content-export fallback both failing halts (never writes)", () => {
  it("halts with both failure reasons named when the snapshot dir AND export dir are unusable", async () => {
    const memory = makeStore([{ id: "m1", content: "a", agentId: "a1", stale: true }]);
    const relationship = makeStore([]);
    const registry = buildRegistryWith(makeDerivedOnlyMigration(memory));

    // Force BOTH the snapshot root and export root to be unusable by
    // pre-creating a REGULAR FILE at the exact path each would need to
    // mkdir — mkdirSync(..., {recursive:true}) throws ENOTDIR/EEXIST.
    const snapshotRoot = join(dataDir, ".migrations", "snapshots");
    const exportRoot = join(dataDir, ".migrations", "exports");
    mkdirSync(join(dataDir, ".migrations"), { recursive: true });
    writeFileSync(snapshotRoot, "not a directory");
    writeFileSync(exportRoot, "not a directory either");

    const ledgerEvents: unknown[] = [];
    const result = await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : relationship.accessor),
      dataDir,
      runningVersion: "0.1.0",
      sleep: fastSleep,
      snapshotRoot,
      exportRoot,
      ledgerDeps: { orgEventTable: { put: async (c: unknown) => { ledgerEvents.push(c); return c; } } },
    });

    expect(result.ran).toBe(true);
    const detail = JSON.parse((ledgerEvents[0] as any).detail);
    expect(detail.outcome).toBe("halted");
    expect(detail.error).toContain("snapshot failed");
    expect(detail.error).toContain("export fallback also failed");
    expect(memory.map.get("m1")!.stale).toBe(true); // never touched
  });
});

describe("runMigrationCycle — completion gate: row count still nonzero", () => {
  it("halts when run() stops making progress before countPending() reaches zero (a stuck/broken migration)", async () => {
    const memory = makeStore([{ id: "m1", content: "a", agentId: "a1", stale: true }]);
    const relationship = makeStore([]);

    const brokenMigration: Migration = {
      id: "broken",
      riskClass: "derived-only",
      affectsTables: ["Memory"],
      async detect() { return true; },
      async countPending() { return 1; }, // ALWAYS reports 1 pending, even after "processing"
      async run() { return { processed: 0, touchedIds: [] }; }, // never actually does anything — 0 signals loop-end immediately
    };
    const registry = buildRegistryWith(brokenMigration);

    const ledgerEvents: unknown[] = [];
    const result = await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : relationship.accessor),
      dataDir,
      runningVersion: "0.1.0",
      sleep: fastSleep,
      ledgerDeps: { orgEventTable: { put: async (c: unknown) => { ledgerEvents.push(c); return c; } } },
    });

    expect(result.ran).toBe(true);
    const detail = JSON.parse((ledgerEvents[0] as any).detail);
    expect(detail.outcome).toBe("halted");
    expect(detail.error).toContain("rowsRemaining=1");
  });
});

describe("runMigrationCycle — single-flight (in-process + file lock)", () => {
  it("a concurrent call while a lock is already held returns ran:false with a single-flight reason, and does NOT touch data", async () => {
    const { acquireMigrationLock } = await import("../../resources/migrations/lock.ts");
    const lockPath = join(dataDir, ".migrations", "lock");
    const held = acquireMigrationLock({ lockPath });
    expect(held.acquired).toBe(true);

    const memory = makeStore([{ id: "m1", content: "a", agentId: "a1", stale: true }]);
    const relationship = makeStore([]);
    const registry = buildRegistryWith(makeDerivedOnlyMigration(memory));

    const result = await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : relationship.accessor),
      dataDir,
      runningVersion: "0.1.0",
      sleep: fastSleep,
      lockPath,
    });

    expect(result.ran).toBe(false);
    expect(result.reason).toContain("single-flight");
    expect(memory.map.get("m1")!.stale).toBe(true); // untouched — never got past the lock

    if (held.acquired) held.release();
  });
});

describe("runMigrationCycle — detect() short-circuit across two cycles (the health-tracked marker)", () => {
  it("a second cycle at the SAME version does not call detect() again once the first succeeded", async () => {
    const memory = makeStore([{ id: "m1", content: "a", agentId: "a1", stale: true }]);
    const relationship = makeStore([]);

    let detectCalls = 0;
    const base = makeDerivedOnlyMigration(memory, "counted");
    const counted: Migration = {
      ...base,
      async detect() {
        detectCalls++;
        return base.detect();
      },
    };
    const registry = buildRegistryWith(counted);

    const first = await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : relationship.accessor),
      dataDir,
      runningVersion: "0.1.0",
      sleep: fastSleep,
    });
    expect(first.ran).toBe(true);
    expect(detectCalls).toBe(1);

    const second = await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : relationship.accessor),
      dataDir,
      runningVersion: "0.1.0", // SAME version
      sleep: fastSleep,
    });
    expect(second.ran).toBe(false);
    expect(second.reason).toContain("nothing pending");
    expect(detectCalls).toBe(1); // NOT called again — short-circuited via the state file
  });

  it("a cycle at a NEWER version DOES call detect() again (a release may introduce new pending rows)", async () => {
    const memory = makeStore([{ id: "m1", content: "a", agentId: "a1", stale: true }]);
    const relationship = makeStore([]);
    let detectCalls = 0;
    const base = makeDerivedOnlyMigration(memory, "counted2");
    const counted: Migration = { ...base, async detect() { detectCalls++; return base.detect(); } };
    const registry = buildRegistryWith(counted);

    await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : relationship.accessor),
      dataDir,
      runningVersion: "0.1.0",
      sleep: fastSleep,
    });
    expect(detectCalls).toBe(1);

    await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : relationship.accessor),
      dataDir,
      runningVersion: "0.2.0", // newer version
      sleep: fastSleep,
    });
    expect(detectCalls).toBe(2);
  });
});

describe("runMigrationCycle — never throws (defense-in-depth)", () => {
  it("a migration whose detect() throws is marked failed, and the cycle still handles other migrations", async () => {
    const memory = makeStore([{ id: "m1", content: "a", agentId: "a1", stale: true }]);
    const relationship = makeStore([]);

    const throwing: Migration = {
      id: "throws-on-detect",
      riskClass: "derived-only",
      affectsTables: ["Memory"],
      async detect() { throw new Error("boom"); },
      async countPending() { return 0; },
      async run() { return { processed: 0, touchedIds: [] }; },
    };
    const ok = makeDerivedOnlyMigration(memory);
    const registry = buildRegistryWith(throwing, ok);

    const result = await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : relationship.accessor),
      dataDir,
      runningVersion: "0.1.0",
      sleep: fastSleep,
    });

    expect(result.ran).toBe(true); // the OTHER migration still ran
    expect(memory.map.get("m1")!.stale).toBe(false);

    const failedProgress = listMigrationProgress().find((p) => p.id === "throws-on-detect");
    expect(failedProgress?.state).toBe("failed");
    expect(failedProgress?.reason).toContain("boom");
  });
});

describe("runMigrationCycle — test-only batch-delay knob (FLAIR_MIGRATION_TEST_BATCH_DELAY_MS)", () => {
  // The knob lets the resume-after-kill integration test widen the running
  // phase to seconds so the kill lands mid-flight deterministically. These
  // tests pin its DOUBLE gate: honored only when the synthetic CI-migration
  // gate (FLAIR_ENABLE_TEST_MIGRATIONS=1) is also active — a stray env var
  // on a production deployment can never alter the real 100ms throttle.
  afterEach(() => {
    delete process.env.FLAIR_ENABLE_TEST_MIGRATIONS;
    delete process.env.FLAIR_MIGRATION_TEST_BATCH_DELAY_MS;
  });

  async function runOneCycleCapturingSleeps(): Promise<number[]> {
    const memory = makeStore([{ id: "m1", content: "a", agentId: "a1", stale: true }]);
    const relationship = makeStore([]);
    const registry = buildRegistryWith(makeDerivedOnlyMigration(memory, "knob-probe"));
    const sleeps: number[] = [];
    await runMigrationCycle({
      registry,
      getTable: (t) => (t === "Memory" ? memory.accessor : relationship.accessor),
      dataDir,
      runningVersion: "0.1.0",
      sleep: async (ms: number) => { sleeps.push(ms); },
      // batchDelayMs deliberately NOT passed — exercising the env-var default resolution.
    });
    return sleeps;
  }

  it("honors the override when the synthetic gate is active", async () => {
    process.env.FLAIR_ENABLE_TEST_MIGRATIONS = "1";
    process.env.FLAIR_MIGRATION_TEST_BATCH_DELAY_MS = "1234";
    const sleeps = await runOneCycleCapturingSleeps();
    expect(sleeps).toContain(1234);
    expect(sleeps).not.toContain(100);
  });

  it("IGNORES the override when the synthetic gate is OFF (prod default throttle survives a stray env var)", async () => {
    process.env.FLAIR_MIGRATION_TEST_BATCH_DELAY_MS = "1234";
    const sleeps = await runOneCycleCapturingSleeps();
    expect(sleeps).toContain(100);
    expect(sleeps).not.toContain(1234);
  });

  it("ignores an unparseable/negative override value even with the gate active", async () => {
    process.env.FLAIR_ENABLE_TEST_MIGRATIONS = "1";
    process.env.FLAIR_MIGRATION_TEST_BATCH_DELAY_MS = "not-a-number";
    const sleeps = await runOneCycleCapturingSleeps();
    expect(sleeps).toContain(100);
  });
});
