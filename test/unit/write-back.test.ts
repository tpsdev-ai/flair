/**
 * write-back.test.ts — resources/write-back.ts (flair#2354).
 *
 * The shared full-row Memory write-back's own contract, driven deterministically
 * with a fake table that models Harper's staged-write / committed-read
 * behaviour (put() stages; the get() that follows a staged write is the
 * committed re-read, returning the committed store row; on a match the staged
 * write lands, on a mismatch it is discarded) and a stubbed global transaction
 * (Harper assigns `transaction` onto the global at load). No real Harper is
 * needed here; the real helper is exercised end-to-end against a live instance
 * in test/integration/write-back-contention-2354.test.ts.
 *
 * Covers: a clean write; abort-and-retry from the committed row (the retried
 * plan wins); the bounded refusal (WriteBackConflictError, staged write never
 * landing); a plan's skip; and a read failure propagating rather than being
 * swallowed (fail-closed).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isDeepStrictEqual } from "node:util";
import { WRITE_BACK_ATTEMPTS, WriteBackConflictError, writeBackCommittedRow } from "../../resources/write-back";

type Row = { id: string } & Record<string, unknown>;

/**
 * A fake Memory table with the helper's staged-write / committed-read model.
 * `competing` (if set) runs just after a write is staged and before the
 * committed re-read, modelling a competing writer committing in that window.
 */
function stagedTable(seed: Row[]) {
  const store = new Map<string, Row>(seed.map((r) => [r.id, { ...r }]));
  let staged: Row | null = null;
  let read: Row | null = null;
  const commits: Row[] = [];
  let competing: (() => void) | undefined;
  let puts = 0;
  const table = {
    setCompeting(fn: (() => void) | undefined) { competing = fn; },
    async get(id: string, _ctx?: unknown): Promise<Row | null> {
      if (staged !== null) {
        const row = store.get(id);
        const committed = row ? { ...row } : null;
        if (committed !== null && read !== null && isDeepStrictEqual(committed, read)) {
          store.set(id, { ...staged });
          commits.push({ ...staged });
        }
        staged = null;
        read = null;
        return committed;
      }
      const row = store.get(id);
      read = row ? { ...row } : null;
      return read;
    },
    async put(row: Row, _ctx?: unknown): Promise<Row> {
      puts++;
      staged = { ...row };
      competing?.();
      return row;
    },
  };
  return { store, table, commits, puts: () => puts };
}

let savedTransaction: unknown;
beforeAll(() => {
  savedTransaction = (globalThis as { transaction?: unknown }).transaction;
  (globalThis as { transaction?: unknown }).transaction = (_ctx: unknown, cb: () => unknown) => cb();
});
afterAll(() => {
  (globalThis as { transaction?: unknown }).transaction = savedTransaction;
});

const opts = (label: string) => ({ label });

describe("writeBackCommittedRow — the committed read confirms the write", () => {
  test("a clean write lands and the plan's decision is returned", async () => {
    const { table, store, commits } = stagedTable([{ id: "m1", content: "a" }]);
    const outcome = await writeBackCommittedRow(table, "m1", (row: Row) => ({ write: { ...row, content: "b" } }), opts("clean"));
    expect(outcome).toEqual({ write: { id: "m1", content: "b" } });
    expect(store.get("m1")).toEqual({ id: "m1", content: "b" });
    expect(commits).toHaveLength(1);
  });

  test("a plan that skips performs no write", async () => {
    const { table, store, commits, puts } = stagedTable([{ id: "m1", content: "a" }]);
    const outcome = await writeBackCommittedRow(table, "m1", () => ({ skip: true }), opts("skip"));
    expect(outcome).toEqual({ skip: true });
    expect(store.get("m1")).toEqual({ id: "m1", content: "a" });
    expect(commits).toHaveLength(0);
    expect(puts()).toBe(0);
  });
});

describe("writeBackCommittedRow — abort and retry from the committed row", () => {
  test("a change committed after the read aborts the staged write and the retried plan wins", async () => {
    const { table, store, commits } = stagedTable([{ id: "m1", content: "a" }]);
    const seen: string[] = [];
    // The competing writer commits once, after the first attempt's read.
    table.setCompeting(() => {
      table.setCompeting(undefined);
      store.set("m1", { id: "m1", content: "competing" });
    });
    const outcome = await writeBackCommittedRow(
      table,
      "m1",
      (row: Row) => { seen.push(String(row.content)); return { write: { ...row, content: `${row.content}+written` } }; },
      opts("retry"),
    );
    // The first attempt read "a"; the retry read the committed "competing".
    expect(seen).toEqual(["a", "competing"]);
    expect(outcome).toEqual({ write: { id: "m1", content: "competing+written" } });
    expect(store.get("m1")).toEqual({ id: "m1", content: "competing+written" });
    expect(commits).toHaveLength(1); // only the retried write landed
  });

  test("a row that keeps changing is refused; the staged write never lands", async () => {
    const { table, store, commits } = stagedTable([{ id: "m1", content: "a" }]);
    let n = 0;
    // The competing writer commits after EVERY staged write, so the committed
    // re-read never matches the row the attempt read.
    table.setCompeting(() => { store.set("m1", { id: "m1", content: `competing-${n++}` }); });
    await expect(
      writeBackCommittedRow(table, "m1", (row: Row) => ({ write: { ...row, content: "written" } }), opts("conflict")),
    ).rejects.toThrow(WriteBackConflictError);
    expect(commits).toHaveLength(0);
    expect(store.get("m1")?.content).toBe(`competing-${n - 1}`); // the last competing value, never our write
    expect(WRITE_BACK_ATTEMPTS).toBe(3);
    expect(n).toBe(WRITE_BACK_ATTEMPTS); // one attempt per bounded try
  });
});

describe("writeBackCommittedRow — failures are never swallowed", () => {
  test("a read failure propagates (unknown is not a pass)", async () => {
    const table = {
      async get(): Promise<never> { throw new Error("read unavailable"); },
      async put(): Promise<never> { throw new Error("must not write"); },
    };
    await expect(
      writeBackCommittedRow(table, "m1", () => ({ write: { id: "m1" } }), opts("read-fail")),
    ).rejects.toThrow("read unavailable");
  });
});
