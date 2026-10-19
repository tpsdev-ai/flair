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
 * Covers: clean writes, skips, pre-commit conflicts, post-commit unconfirmed
 * outcomes, bounded retries, and read failures.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isDeepStrictEqual } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARPER_MANAGED_FIELDS, WRITE_BACK_ATTEMPTS, WRITE_BACK_IDENTITY_FIELDS, WriteBackConflictError, verifyCommittedFields, withoutHarperManagedFields, writeBackCommittedRow, writeBackIdentity } from "../../resources/write-back";

type Row = { id: string } & Record<string, unknown>;

for (const absent of [null, undefined]) {
  test(`verifyCommittedFields: ${absent} is a mismatch without calling also`, async () => {
    let calls = 0;
    const table = { async get() { return absent; } };
    const verdict = await verifyCommittedFields(table, "m1", { id: "m1" }, { content: "staged" }, () => {
      calls++;
      throw new Error("also must not see an absent row");
    });
    expect(verdict).toBe("mismatch");
    expect(calls).toBe(0);
  });
}

describe("withoutHarperManagedFields — the application fields of a spread row (flair#2656)", () => {
  const staged = {
    id: "p1", createdAt: "2026-01-01T00:00:00.000Z", status: "paired", pairAttemptWriteId: "w1",
    __createdtime__: 1000, __updatedtime__: 1000,
  };

  test("drops exactly Harper's two timestamps and keeps every other field, leaving the row unchanged", () => {
    expect([...HARPER_MANAGED_FIELDS]).toEqual(["__createdtime__", "__updatedtime__"]);
    const fields = withoutHarperManagedFields(staged);
    expect(fields).toEqual({ id: "p1", createdAt: "2026-01-01T00:00:00.000Z", status: "paired", pairAttemptWriteId: "w1" });
    expect(staged.__updatedtime__).toBe(1000);
    expect(staged.__createdtime__).toBe(1000);
  });

  test("verifyCommittedFields stays strict: a named timestamp that moved is a mismatch; the application fields are shown", async () => {
    const table = { async get() { return { ...staged, __updatedtime__: 2000 }; } };
    expect(await verifyCommittedFields(table, "p1", staged, staged)).toBe("mismatch");
    expect(await verifyCommittedFields(table, "p1", staged, withoutHarperManagedFields(staged))).toBe("shown");
  });

  test("an application field that differs is still a mismatch without the timestamps", async () => {
    const table = { async get() { return { ...staged, pairAttemptWriteId: "other-attempt", __updatedtime__: 2000 }; } };
    expect(await verifyCommittedFields(table, "p1", staged, withoutHarperManagedFields(staged))).toBe("mismatch");
  });
});

/**
 * A fake Memory table with the helper's staged-write / committed-read model.
 * `competing` (if set) runs just after a write is staged and before the
 * committed re-read, modelling a competing writer committing in that window.
 * The confirmation get records the staged write as committed before returning
 * the old row. `afterCommit` then overwrites that committed write.
 */
function stagedTable(seed: Row[]) {
  const store = new Map<string, Row>(seed.map((r) => [r.id, { ...r }]));
  let staged: Row | null = null;
  let read: Row | null = null;
  const commits: Row[] = [];
  let competing: (() => void) | undefined;
  let afterCommit: (() => void) | undefined;
  let puts = 0;
  const writes: { method: "put" | "update"; id: string; fields: string[] }[] = [];
  const table = {
    setCompeting(fn: (() => void) | undefined) { competing = fn; },
    setAfterCommit(fn: (() => void) | undefined) { afterCommit = fn; },
    async get(id: string, _ctx?: unknown): Promise<Row | null> {
      if (staged !== null) {
        const row = store.get(id);
        const committed = row ? { ...row } : null;
        if (committed !== null && read !== null && isDeepStrictEqual(committed, read)) {
          store.set(id, { ...staged });
          commits.push({ ...staged });
          afterCommit?.();
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

for (const idempotent of [false, true]) {
  for (const kind of ["write", "update"] as const) {
    for (const outcome of ["conflict", "unconfirmed"] as const) {
      test(`${kind} plan (${idempotent ? "idempotent" : "non-idempotent"}) labels a ${outcome === "conflict" ? "pre-commit" : "post-commit"} race ${outcome}`, async () => {
        const { table, store, commits } = stagedTable([{ id: "m1", count: 0 }]);
        let changes = 0;
        const compete = () => store.set("m1", { id: "m1", count: --changes });
        if (outcome === "conflict") table.setCompeting(compete);
        else table.setAfterCommit(compete);
        const evidence = idempotent ? { idempotent: true as const } : { idempotent: false as const, commitMarkerField: "writeBackWriteId" };
        const pending = writeBackCommittedRow(table, "m1", (row) => kind === "write"
          ? { ...evidence, write: { ...row, count: 1 } }
          : { ...evidence, update: { count: 1 } }, opts("labels"));
        await expect(pending).rejects.toBeInstanceOf(WriteBackConflictError);
        await expect(pending).rejects.toMatchObject({ outcome, message: expect.stringContaining(outcome === "conflict" ? "no write committed by this attempt" : "unconfirmed after commit") });
        const attempts = outcome === "unconfirmed" && !idempotent ? 1 : WRITE_BACK_ATTEMPTS;
        expect(changes).toBe(-attempts);
        expect(commits).toHaveLength(outcome === "conflict" ? 0 : attempts);
      });
    }
  }
}

describe("writeBackCommittedRow — staged values in the committed row", () => {
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
      await writeBackCommittedRow(table, "m1", (row) => ({ write: row, idempotent: true }), opts("applied"));
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
    const outcome = await writeBackCommittedRow(table, "m1", (row: Row) => ({ idempotent: true, write: { ...row, content: "b" } }), opts("clean"));
    expect(outcome).toEqual({ idempotent: true, write: { id: "m1", content: "b" } });
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
      (row: Row) => { seen.push(String(row.content)); return { idempotent: false, commitMarkerField: "writeBackWriteId", write: { ...row, content: `${row.content}+written` } }; },
      opts("retry"),
    );
    // The first attempt read "a"; the retry read the committed "competing".
    expect(seen).toEqual(["a", "competing"]);
    expect(outcome).toEqual({ idempotent: false, commitMarkerField: "writeBackWriteId", write: { id: "m1", content: "competing+written" } });
    expect(store.get("m1")).toEqual({ id: "m1", content: "competing+written", writeBackWriteId: expect.any(String) });
    expect(commits).toHaveLength(1); // only the retried write landed
  });

  test("a row that keeps changing is refused; the staged write never lands", async () => {
    const { table, store, commits } = stagedTable([{ id: "m1", content: "a" }]);
    let n = 0;
    // The competing writer commits after EVERY staged write, so the committed
    // re-read never matches the row the attempt read.
    table.setCompeting(() => { store.set("m1", { id: "m1", content: `competing-${n++}` }); });
    const pending = writeBackCommittedRow(table, "m1", (row: Row) => ({ idempotent: true, write: { ...row, content: "written" } }), opts("conflict"));
    await expect(pending).rejects.toThrow(WriteBackConflictError);
    await expect(pending).rejects.toMatchObject({ outcome: "conflict", message: expect.stringContaining("write aborted; no write committed by this attempt") });
    expect(commits).toHaveLength(0);
    expect(store.get("m1")?.content).toBe(`competing-${n - 1}`); // the last competing value, never our write
    expect(WRITE_BACK_ATTEMPTS).toBe(3);
    expect(n).toBe(WRITE_BACK_ATTEMPTS); // one attempt per bounded try
  });
});

describe("writeBackCommittedRow — the post-commit verification (flair#2653)", () => {
  test("a write a newer commit supersedes is retried and the retried plan lands", async () => {
    const { table, store, commits } = stagedTable([{ id: "m1", content: "a", usageCount: 0 }]);
    let losses = 0;
    table.setAfterCommit(() => {
      if (losses++ > 0) return;
      // The fake recorded this attempt as committed, then overwrites it.
      store.set("m1", { id: "m1", content: "competing", usageCount: 0 });
    });
    const outcome = await writeBackCommittedRow(
      table,
      "m1",
      (row: Row) => ({ idempotent: true, update: { usageCount: 1 } }),
      opts("post-commit"),
    );
    expect(outcome).toEqual({ idempotent: true, update: { usageCount: 1 } });
    // The retry read the newer row and folded its write around it.
    expect(store.get("m1")).toEqual({ id: "m1", content: "competing", usageCount: 1 });
    expect(commits).toHaveLength(2);
  });

  test("a write the committed read never shows is refused, never reported as success", async () => {
    const { table, store, commits } = stagedTable([{ id: "m1", content: "a" }]);
    table.setAfterCommit(() => {
      // Every attempt's commit is superseded by a newer write of the same field.
      store.set("m1", { id: "m1", content: "competing" });
    });
    const pending = writeBackCommittedRow(table, "m1", (row: Row) => ({ idempotent: true, write: { ...row, content: "written" } }), opts("post-commit-refuse"));
    await expect(pending).rejects.toThrow(WriteBackConflictError);
    await expect(pending).rejects.toMatchObject({ outcome: "unconfirmed", message: expect.stringContaining("staged values unconfirmed after commit") });
    expect(store.get("m1")?.content).toBe("competing");
    expect(commits).toHaveLength(WRITE_BACK_ATTEMPTS);
  });

  test("a full-row plan rejects an omitted field retained after commit", async () => {
    const { table, store, commits } = stagedTable([{ id: "m1", content: "a", undeclared: "keep" }]);
    table.setAfterCommit(() => store.set("m1", { id: "m1", content: "a", undeclared: "keep" }));
    await expect(writeBackCommittedRow(table, "m1", () => ({ idempotent: true, write: { id: "m1", content: "a" } }),
      opts("omitted"))).rejects.toThrow(WriteBackConflictError);
    expect(commits).toHaveLength(WRITE_BACK_ATTEMPTS);
    expect(store.get("m1")?.undeclared).toBe("keep");
  });

  test("full-row confirmation excludes only Harper timestamps", async () => {
    const { table, store } = stagedTable([{ id: "m1", content: "a" }]);
    table.setAfterCommit(() => store.set("m1", { id: "m1", content: "b", __createdtime__: 1, __updatedtime__: 2 }));
    await writeBackCommittedRow(table, "m1", () => ({ idempotent: true, write: { id: "m1", content: "b" } }), opts("timestamps"));
    expect(store.get("m1")?.content).toBe("b");
  });

  test("a non-idempotent post-commit mismatch is terminal and unconfirmed", async () => {
    const { table, store, commits } = stagedTable([{ id: "m1", usageCount: 0 }]);
    let plans = 0;
    table.setAfterCommit(() => store.set("m1", { id: "m1", usageCount: 2 }));
    let error: unknown;
    try {
      await writeBackCommittedRow(table, "m1", (row) => {
        plans++;
        return { idempotent: false, commitMarkerField: "writeBackWriteId", update: { usageCount: row.usageCount + 1 } };
      }, opts("contribution"));
    } catch (err) { error = err; }
    expect(error).toBeInstanceOf(WriteBackConflictError);
    expect((error as WriteBackConflictError).outcome).toBe("unconfirmed");
    expect((error as Error).message).toContain("staged values unconfirmed after commit");
    expect(plans).toBe(1);
    expect(commits).toHaveLength(1);
    expect(store.get("m1")?.usageCount).toBe(2);
  });

  for (const kind of ["write", "update"] as const) {
    test(`a non-idempotent ${kind} with another attempt's matching value is unconfirmed`, async () => {
      const { table, store, commits } = stagedTable([{ id: "m1", usageCount: 5 }]);
      table.setAfterCommit(() => store.set("m1", { id: "m1", usageCount: 6, writeBackWriteId: "other-attempt" }));
      let plans = 0;
      const pending = writeBackCommittedRow(table, "m1", (row) => {
        plans++;
        const evidence = { idempotent: false as const, commitMarkerField: "writeBackWriteId" };
        return kind === "update"
          ? { ...evidence, update: { usageCount: row.usageCount + 1 } }
          : { ...evidence, write: { ...row, usageCount: row.usageCount + 1 } };
      }, opts("same-value"));
      await expect(pending).rejects.toMatchObject({ outcome: "unconfirmed" });
      expect(plans).toBe(1);
      expect(commits).toHaveLength(1);
      expect(commits[0].writeBackWriteId).toBeString();
      expect(commits[0].writeBackWriteId).not.toBe("other-attempt");
      expect(store.get("m1")).toEqual({ id: "m1", usageCount: 6, writeBackWriteId: "other-attempt" });
    });
  }

  test("a non-idempotent pre-commit conflict may retry", async () => {
    const { table, store, commits } = stagedTable([{ id: "m1", usageCount: 0 }]);
    const markers: unknown[] = [];
    const update = table.update;
    table.update = async (id, patch, ctx) => {
      markers.push(patch.writeBackWriteId);
      return update(id, patch, ctx);
    };
    table.setCompeting(() => {
      table.setCompeting(undefined);
      store.set("m1", { id: "m1", usageCount: 1 });
    });
    await writeBackCommittedRow(table, "m1", (row) => ({ idempotent: false, commitMarkerField: "writeBackWriteId", update: { usageCount: row.usageCount + 1 } }), opts("pre-contribution"));
    expect(store.get("m1")?.usageCount).toBe(2);
    expect(commits).toHaveLength(1);
    expect(markers).toHaveLength(2);
    expect(markers.every((marker) => typeof marker === "string" && marker.length > 0)).toBe(true);
    expect(markers[0]).not.toBe(markers[1]);
    expect(store.get("m1")?.writeBackWriteId).toBe(markers[1]);
  });

  test("a non-idempotent unreadable confirmation is unconfirmed without retry", async () => {
    const row = { id: "m1", usageCount: 0 };
    let reads = 0;
    let writes = 0;
    const table = {
      async get() {
        if (++reads > 2) throw new Error("read unavailable");
        return { ...row };
      },
      async put() { throw new Error("unexpected put"); },
      async update() { writes++; },
    };
    let error: unknown;
    try {
      await writeBackCommittedRow(table, "m1", () => ({ idempotent: false, commitMarkerField: "writeBackWriteId", update: { usageCount: 1 } }),
        { label: "unreadable-contribution", expectedRow: row });
    } catch (err) { error = err; }
    expect((error as WriteBackConflictError).outcome).toBe("unconfirmed");
    expect(writes).toBe(1);
  });

  test("an unreadable post-commit confirmation is a failure, not success", async () => {
    const row = { id: "m1", content: "a" };
    let calls = 0;
    const table = {
      async get(_id: string, _ctx?: unknown): Promise<Row | null> {
        calls++;
        // call 1: the in-transaction read; call 2: the pre-commit confirmation;
        // call 3: the post-commit verification read.
        if (calls >= 3) throw new Error("committed read unavailable");
        return { ...row };
      },
      async put(row: Row): Promise<Row> { return row; },
    };
    let unconfirmed = false;
    await expect(
      writeBackCommittedRow(table, "m1", (stored: Row) => ({ idempotent: true, write: { ...stored, content: "written" } }),
        { label: "post-commit-read", onUnconfirmed: () => { unconfirmed = true; }, expectedRow: { ...row } }),
    ).rejects.toThrow("committed read unavailable");
    expect(unconfirmed).toBe(true);
  });
});

describe("writeBackCommittedRow — incremental update plans", () => {
  test("an idempotent update plan lands its patch and leaves the stored row's other fields untouched", async () => {
    const { table, store, commits, writes } = stagedTable([{ id: "m1", content: "a", durability: "standard" }]);
    const outcome = await writeBackCommittedRow(table, "m1", () => ({ idempotent: true, update: { usageCount: 1 } }), opts("update-only"));
    expect(outcome).toEqual({ idempotent: true, update: { usageCount: 1 } });
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
      writeBackCommittedRow(table, "m1", () => ({ idempotent: true, update: { usageCount: 1 } }), opts("no-update")),
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
      writeBackCommittedRow(table, "m1", () => ({ idempotent: true, write: { id: "m1" } }), opts("read-fail")),
    ).rejects.toThrow("read unavailable");
  });
});

for (const field of ["agentId", "contentHash", "instanceToken", "createdAt"]) {
  test(`refuses a changed ${field} before the owned read`, async () => {
    const basis = { id: "m1", agentId: "owner", contentHash: "hash", instanceToken: "token", content: "a", createdAt: "2026-01-01T00:00:00.000Z" };
    const { table, commits } = stagedTable([{ ...basis, [field]: "replacement" }]);
    const pending = writeBackCommittedRow(table, "m1", (row) => ({ idempotent: true, write: { ...row, content: "written" } }),
      { label: "replacement", expectedRow: basis });
    await expect(pending).rejects.toThrow(WriteBackConflictError);
    await expect(pending).rejects.toMatchObject({ outcome: "conflict", message: expect.stringContaining("write aborted; no write committed by this attempt") });
    expect(commits).toHaveLength(0);
  });
  test(`refuses a changed ${field} on retry`, async () => {
    const basis = { id: "m1", agentId: "owner", contentHash: "hash", instanceToken: "token", content: "a", createdAt: "2026-01-01T00:00:00.000Z" };
    const { table, store, commits } = stagedTable([basis]);
    table.setCompeting(() => {
      table.setCompeting(undefined);
      store.set("m1", { ...basis, [field]: "replacement" });
    });
    await expect(writeBackCommittedRow(table, "m1", (row) => ({ idempotent: true, write: { ...row, content: "written" } }),
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
  await expect(writeBackCommittedRow(table, "m1", (row) => ({ idempotent: true, write: { ...row, promotionStatus: "approved" } }),
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
    const outcome = await writeBackCommittedRow(clean.table, "m1", (row: Row) => ({ idempotent: true, write: { ...row, content: "y" } }),
      { label: "identity", expectedRow: writeBackIdentity(full) });
    expect("write" in outcome).toBe(true);
    expect(clean.store.get("m1")?.content).toBe("y");
    const replaced = stagedTable([{ ...full, instanceToken: "t2" }]);
    await expect(writeBackCommittedRow(replaced.table, "m1", (row: Row) => ({ idempotent: true, write: row }),
      { label: "identity", expectedRow: writeBackIdentity(full) })).rejects.toBeInstanceOf(WriteBackConflictError);
    expect(replaced.store.get("m1")?.instanceToken).toBe("t2");
  });
});
