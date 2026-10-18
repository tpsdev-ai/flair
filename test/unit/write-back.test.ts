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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WRITE_BACK_ATTEMPTS, WRITE_BACK_IDENTITY_FIELDS, WriteBackConflictError, writeBackCommittedRow, writeBackIdentity } from "../../resources/write-back";

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
  const writes: { method: "put" | "update"; id: string; fields: string[] }[] = [];
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
      writes.push({ method: "put", id: row.id, fields: Object.keys(row).sort() });
      staged = { ...row };
      competing?.();
      return row;
    },
    async update(id: string, patch: Record<string, unknown>, _ctx?: unknown): Promise<Row | null> {
      puts++;
      writes.push({ method: "update", id, fields: Object.keys(patch).sort() });
      const current = store.get(id);
      staged = current ? { ...current, ...patch } : null;
      competing?.();
      return staged;
    },
  };
  return { store, table, commits, writes, puts: () => puts };
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
  test("attempt outcomes are logged after transaction settlement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-write-back-log-"));
    const path = join(dir, "attempts.write-back");
    const saved = {
      FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
      FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
    };
    const host = globalThis as { transaction?: unknown };
    const transaction = host.transaction;
    const { table } = stagedTable([{ id: "m1", content: "a" }]);
    let release!: () => void;
    const settlement = new Promise<void>((resolve) => { release = resolve; });
    let ready!: () => void;
    const planned = new Promise<void>((resolve) => { ready = resolve; });
    try {
      process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
      process.env.FLAIR_TEST_PAUSE_DIR = dir;
      host.transaction = async (_ctx: unknown, cb: () => unknown) => {
        const result = await cb();
        ready();
        await settlement;
        return result;
      };
      const pending = writeBackCommittedRow(table, "m1", () => ({ skip: true }), opts("settled"));
      await planned;
      expect(readFileSync(path, "utf8")).toBe("settled\tm1\t1\n");
      release();
      expect(await pending).toEqual({ skip: true });
      expect(readFileSync(path, "utf8")).toBe("settled\tm1\t1\nsettled\tm1\t1\tskipped\n");
      host.transaction = transaction;
      await writeBackCommittedRow(table, "m1", (row) => ({ write: row }), opts("applied"));
      const refused = new Error("refused");
      await expect(writeBackCommittedRow(table, "m1", () => { throw refused; }, opts("refused"))).rejects.toBe(refused);
      const log = readFileSync(path, "utf8");
      expect(log).toEndWith("applied\tm1\t1\napplied\tm1\t1\tapplied\nrefused\tm1\t1\nrefused\tm1\t1\trefused\n");
      process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "0";
      await writeBackCommittedRow(table, "m1", () => ({ skip: true }), opts("disabled"));
      expect(readFileSync(path, "utf8")).toBe(log);
      process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
      delete process.env.FLAIR_TEST_PAUSE_DIR;
      await writeBackCommittedRow(table, "m1", () => ({ skip: true }), opts("no-directory"));
      expect(readFileSync(path, "utf8")).toBe(log);
      const file = join(dir, "regular-file");
      writeFileSync(file, "");
      process.env.FLAIR_TEST_PAUSE_DIR = file;
      expect(await writeBackCommittedRow(table, "m1", () => ({ skip: true }), opts("append-error"))).toEqual({ skip: true });
    } finally {
      release();
      host.transaction = transaction;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

describe("writeBackCommittedRow — an update plan writes only the fields it names", () => {
  test("an update plan lands its patch and leaves the stored row's other fields untouched", async () => {
    const { table, store, commits, writes } = stagedTable([{ id: "m1", content: "a", durability: "standard" }]);
    const outcome = await writeBackCommittedRow(table, "m1", () => ({ update: { usageCount: 1 } }), opts("update-only"));
    expect(outcome).toEqual({ update: { usageCount: 1 } });
    expect(store.get("m1")).toEqual({ id: "m1", content: "a", durability: "standard", usageCount: 1 });
    expect(commits).toHaveLength(1);
    // The plan is applied as exactly one incremental update naming its own
    // field, never a full-row put — a put here would carry the whole row
    // (flair#2494).
    expect(writes).toEqual([{ method: "update", id: "m1", fields: ["usageCount"] }]);
  });

  test("an update plan on a table without update refuses rather than falling back to a full-row put", async () => {
    const store = new Map<string, Row>([["m1", { id: "m1", content: "a" }]]);
    const table = {
      async get(id: string): Promise<Row | null> { const row = store.get(id); return row ? { ...row } : null; },
      async put(): Promise<never> { throw new Error("must not fall back to a full-row put"); },
    };
    await expect(
      writeBackCommittedRow(table, "m1", () => ({ update: { usageCount: 1 } }), opts("no-update")),
    ).rejects.toThrow("no incremental update");
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

for (const field of ["agentId", "contentHash", "instanceToken", "createdAt"]) {
  test(`refuses a changed ${field} before the owned read`, async () => {
    const basis = { id: "m1", agentId: "owner", contentHash: "hash", instanceToken: "token", content: "a", createdAt: "2026-01-01T00:00:00.000Z" };
    const { table, commits } = stagedTable([{ ...basis, [field]: "replacement" }]);
    await expect(writeBackCommittedRow(table, "m1", (row) => ({ write: { ...row, content: "written" } }),
      { label: "replacement", expectedRow: basis })).rejects.toThrow(WriteBackConflictError);
    expect(commits).toHaveLength(0);
  });
  test(`refuses a changed ${field} on retry`, async () => {
    const basis = { id: "m1", agentId: "owner", contentHash: "hash", instanceToken: "token", content: "a", createdAt: "2026-01-01T00:00:00.000Z" };
    const { table, store, commits } = stagedTable([basis]);
    table.setCompeting(() => {
      table.setCompeting(undefined);
      store.set("m1", { ...basis, [field]: "replacement" });
    });
    await expect(writeBackCommittedRow(table, "m1", (row) => ({ write: { ...row, content: "written" } }),
      { label: "replacement" })).rejects.toThrow(WriteBackConflictError);
    expect(commits).toHaveLength(0);
    expect(store.get("m1")?.[field]).toBe("replacement");
  });
}

test("refuses a changed decision field on retry", async () => {
  const basis = { id: "m1", agentId: "owner", content: "reviewed", createdAt: "2026-01-01T00:00:00.000Z" };
  const { table, store, commits } = stagedTable([basis]);
  table.setCompeting(() => {
    table.setCompeting(undefined);
    store.set("m1", { ...basis, content: "unreviewed" });
  });
  await expect(writeBackCommittedRow(table, "m1", (row) => ({ write: { ...row, promotionStatus: "approved" } }),
    { label: "promotion", matchFields: ["content"] })).rejects.toThrow(WriteBackConflictError);
  expect(commits).toHaveLength(0);
  expect(store.get("m1")?.content).toBe("unreviewed");
});

describe("writeBackIdentity — the expectedRow a selecting caller retains (flair#2354)", () => {
  const full: Row = {
    id: "m1", agentId: "agent-a", instanceToken: "t1", contentHash: "h1", createdAt: "2026-01-01T00:00:00.000Z",
    content: "x", embedding: [0.1, 0.2], embeddingModel: "model-a",
  };

  test("keeps only the identity fields, never the embedding", () => {
    const identity = writeBackIdentity(full);
    expect(Object.keys(identity).sort()).toEqual([...WRITE_BACK_IDENTITY_FIELDS].sort());
    expect(identity).not.toHaveProperty("embedding");
  });

  test("is enough for the helper: an unchanged row is written, a replaced one is refused", async () => {
    const clean = stagedTable([full]);
    const outcome = await writeBackCommittedRow(clean.table, "m1", (row: Row) => ({ write: { ...row, content: "y" } }),
      { label: "identity", expectedRow: writeBackIdentity(full) });
    expect("write" in outcome).toBe(true);
    expect(clean.store.get("m1")?.content).toBe("y");
    const replaced = stagedTable([{ ...full, instanceToken: "t2" }]);
    await expect(writeBackCommittedRow(replaced.table, "m1", (row: Row) => ({ write: row }),
      { label: "identity", expectedRow: writeBackIdentity(full) })).rejects.toBeInstanceOf(WriteBackConflictError);
    expect(replaced.store.get("m1")?.instanceToken).toBe("t2");
  });
});
