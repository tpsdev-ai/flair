/**
 * migrations-synthetic-done-count-2840.test.ts — the rows a migration reports
 * done agree with the rows it stamped (flair#2840).
 *
 * The synthetic migration's plan returns a skip when it finds the row already
 * at its marker. When that skip follows this run's own write whose confirming
 * read missed the commit, it is the target state, not lost work, and the batch
 * must count the row, or a completed migration reports one fewer row done than
 * it stamped while `rowsRemaining` is 0. A marker another writer set, with no
 * attempt of this run's own on the row, stays uncounted.
 *
 * This uses the REAL write-back helper (not the unit-test simulation) against
 * a table whose committed read returns the pre-write row twice: the
 * in-transaction confirmation the write-back runs before commit, and the
 * post-commit verification. Both reads pass the in-transaction check (it
 * compares against the row the transaction read) and the second one is the
 * unconfirmed outcome that drives the retry.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

mock.module("harper", () => ({ server: { http: () => {}, getUser: async () => null }, databases: {}, Resource: class {} }));

const {
  createSyntheticTestMigration,
  RESERVED_TEST_AGENT_ID,
  SYNTHETIC_TARGET_MARKER,
} = await import("../../resources/migrations/synthetic-test-migration.ts");
const { writeBackCommittedRow } = await import("../../resources/write-back.ts");
const { memoryLockDouble } = await import("../helpers/memory-lock-double");

type Row = Record<string, unknown> & { id: string };

/**
 * A table whose FRESH reads (the `{}` context the helper's confirmation and
 * verification use) return the pre-write row for the first two reads after an
 * update. The in-transaction read happens before the write and is live.
 */
function makeStaleConfirmationTable(seed: Row[]) {
  const store = new Map<string, Row>(seed.map((r) => [r.id, { ...r }]));
  let staleSnapshot: Row | null = null;
  let readsAfterUpdate = 0;
  return {
    store,
    table: {
      primaryStore: memoryLockDouble(),
      async get(id: string, ctx?: unknown) {
        const isFresh = ctx !== null && typeof ctx === "object" && Object.keys(ctx as object).length === 0;
        if (isFresh && staleSnapshot && readsAfterUpdate < 2) {
          readsAfterUpdate++;
          return { ...staleSnapshot };
        }
        const row = store.get(id);
        return row ? { ...row } : null;
      },
      async update(id: string, patch: Record<string, unknown>) {
        const prior = store.get(id);
        staleSnapshot = prior ? { ...prior } : null;
        readsAfterUpdate = 0;
        store.set(id, { ...(prior ?? { id }), ...patch } as Row);
        return store.get(id);
      },
      search(query: any): AsyncIterable<Row> {
        const conditions = Array.isArray(query?.conditions) ? query.conditions : [];
        const limit = typeof query?.limit === "number" ? query.limit : Infinity;
        let rows = Array.from(store.values());
        for (const c of conditions) {
          if (c.comparator === "not_equal" || c.comparator === "not_equals") rows = rows.filter((r) => r[c.attribute] !== c.value);
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

const originalTransaction = (globalThis as any).transaction;

describe("synthetic migration — rowsDone agrees with the rows it stamped (flair#2840)", () => {
  beforeEach(() => {
    // Model Harper's owned transaction: commit when the callback settles.
    (globalThis as any).transaction = async (ctx: any, fn: (txn: any) => Promise<unknown>) => fn(ctx);
  });

  afterEach(() => {
    (globalThis as any).transaction = originalTransaction;
  });

  it("counts a row whose write committed but whose confirming read missed it", async () => {
    const { table, store } = makeStaleConfirmationTable([
      { id: "synthetic-seed-0", agentId: RESERVED_TEST_AGENT_ID, content: "x", source: "not-yet" },
    ]);
    const migration = createSyntheticTestMigration(() => table as any, writeBackCommittedRow);

    const result = await migration.run(50);

    // The write landed and the migration's own marker is on the row …
    expect(store.get("synthetic-seed-0")!.source).toBe(SYNTHETIC_TARGET_MARKER);
    // … so the batch's count must include it, not report it as skipped work.
    expect(result.processed).toBe(1);
    expect(result.touchedIds).toEqual(["synthetic-seed-0"]);
    expect(await migration.countPending()).toBe(0);
  });

  it("does not count a row another writer stamped between the scan and the read", async () => {
    // The scan still sees the pending row; by the time the plan reads it,
    // another writer has stamped the marker. This run never attempted the row.
    const pending: Row = { id: "synthetic-seed-1", agentId: RESERVED_TEST_AGENT_ID, content: "x", source: "not-yet" };
    const stamped: Row = { ...pending, source: SYNTHETIC_TARGET_MARKER };
    const table = {
      primaryStore: memoryLockDouble(),
      async get(_id: string) {
        return { ...stamped };
      },
      async put() {
        throw new Error("the migration must not write a row another writer stamped");
      },
      async update() {
        throw new Error("the migration must not write a row another writer stamped");
      },
      search() {
        return (async function* () {
          yield { ...pending };
        })();
      },
    };
    const migration = createSyntheticTestMigration(() => table as any, writeBackCommittedRow);

    expect(await migration.run(50)).toEqual({ processed: 0, touchedIds: [] });
  });
});
