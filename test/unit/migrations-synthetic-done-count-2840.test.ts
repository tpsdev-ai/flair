/**
 * migrations-synthetic-done-count-2840.test.ts — rowsDone counts only writes
 * whose committed effect was verified, and an unconfirmed attempt is reported
 * by id (flair#2840).
 *
 * The synthetic migration's write-back helper re-reads the committed row after
 * its commit. When that post-commit verification read does not show the write,
 * the row is unconfirmed: the batch must not count it as done, and must report
 * its id in `unconfirmedIds`. The retry this drives re-reads the committed row
 * inside its own transaction; finding this migration's marker there, it skips.
 * A marker another writer set, with no attempt of this run on the row, is not
 * this migration's work and is neither counted nor reported as unconfirmed.
 *
 * The fake table below behaves like Harper's own write transaction: an
 * `update` made through a transaction's context is STAGED and applies only
 * when the callback settles, and a read inside the same transaction sees the
 * staged value. Reads with the explicit empty context the write-back helper
 * uses never see staged state, so the pre-commit confirmation read sees the
 * pre-write row (and passes the in-transaction check), while the post-commit
 * read sees the committed write unless it is armed to return the pre-write row.
 */
import { describe, it, expect, mock, afterEach } from "bun:test";

mock.module("harper", () => ({ server: { http: () => {}, getUser: async () => null }, databases: {}, Resource: class {} }));

const {
  createSyntheticTestMigration,
  RESERVED_TEST_AGENT_ID,
  SYNTHETIC_TARGET_MARKER,
} = await import("../../resources/migrations/synthetic-test-migration.ts");
const { writeBackCommittedRow } = await import("../../resources/write-back.ts");
const { memoryLockDouble } = await import("../helpers/memory-lock-double");

type Row = Record<string, unknown> & { id: string };

function makeTable(seed: Row[]) {
  const store = new Map<string, Row>(seed.map((r) => [r.id, { ...r }]));
  const writes: { method: "put" | "update"; id: string; fields: string[] }[] = [];
  /** Answer this many post-commit verification reads with `staleRow`. */
  let staleReads = 0;
  let staleRow: Row | null = null;
  /** Runs after a transaction commits, before the post-commit verification read. */
  let afterCommit: ((prior: Row | null) => void) | null = null;

  function apply(id: string, patch: Row): void {
    const prior = store.get(id);
    store.set(id, { ...(prior ?? { id }), ...structuredClone(patch), id });
  }

  const table = {
    primaryStore: memoryLockDouble(),
    writes,
    store,
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
      // A read inside an OPEN transaction sees that transaction's staged writes.
      const staged = ctx?.transaction?.staged;
      if (Array.isArray(staged)) {
        for (const entry of staged) {
          if (entry.id === id) row = { ...(row ?? { id }), ...structuredClone(entry.patch) };
        }
      }
      // An explicit empty context reads the committed store, never staged state.
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
  const restore = () => {
    (globalThis as any).transaction = originalTransaction;
  };
  return { table, restore };
}

describe("synthetic migration — rowsDone counts verified writes only (flair#2840)", () => {
  let restoreTransaction: (() => void) | null = null;

  afterEach(() => {
    restoreTransaction?.();
    restoreTransaction = null;
  });

  it("does not count an attempt whose post-commit verification read missed it, and reports its id", async () => {
    const { table, restore } = makeTable([
      { id: "synthetic-seed-0", agentId: RESERVED_TEST_AGENT_ID, content: "x", source: "not-yet" },
    ]);
    restoreTransaction = restore;
    // The write commits. The pre-commit confirmation read sees the pre-write
    // row (it is a committed read) and passes; the post-commit verification
    // read is answered with that same pre-write row, so the attempt is
    // unconfirmed.
    table.onCommit((prior) => table.armStaleVerification(prior ?? { id: "synthetic-seed-0" }));
    const migration = createSyntheticTestMigration(() => table as any, writeBackCommittedRow);

    const result = await migration.run(50);

    expect(table.store.get("synthetic-seed-0")!.source).toBe(SYNTHETIC_TARGET_MARKER);
    expect(result).toEqual({ processed: 0, touchedIds: [], unconfirmedIds: ["synthetic-seed-0"] });
    expect(await migration.countPending()).toBe(0);
  });

  it("counts a verified write and reports no unconfirmed row", async () => {
    const { table, restore } = makeTable([
      { id: "synthetic-seed-1", agentId: RESERVED_TEST_AGENT_ID, content: "x", source: "not-yet" },
    ]);
    restoreTransaction = restore;
    const migration = createSyntheticTestMigration(() => table as any, writeBackCommittedRow);

    const result = await migration.run(50);

    expect(table.store.get("synthetic-seed-1")!.source).toBe(SYNTHETIC_TARGET_MARKER);
    expect(result).toEqual({ processed: 1, touchedIds: ["synthetic-seed-1"] });
  });

  it("does not count or report a row another writer stamped between the scan and the read", async () => {
    // The scan snapshot still shows the pending row; the committed store holds
    // the row another writer stamped. The plan reads the store and skips; this
    // run never attempted the row.
    const pending: Row = { id: "synthetic-seed-2", agentId: RESERVED_TEST_AGENT_ID, content: "x", source: "not-yet" };
    const stamped: Row = { ...pending, source: SYNTHETIC_TARGET_MARKER };
    const { table, restore } = makeTable([stamped]);
    restoreTransaction = restore;
    const search = table.search.bind(table);
    (table as any).search = (query: any) => {
      if (query?.conditions?.some((c: any) => c.attribute === "source")) {
        return (async function* () { yield { ...pending }; })();
      }
      return search(query);
    };
    const migration = createSyntheticTestMigration(() => table as any, writeBackCommittedRow);

    expect(await migration.run(50)).toEqual({ processed: 0, touchedIds: [] });
    expect(table.writes).toEqual([]);
  });
});
