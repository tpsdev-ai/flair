// instance-create-lock-1897.test.ts — deterministic unit tests for the
// in-process create lock (flair#1897 slice 1) with a fake table whose put has
// DEFERRED visibility: a row written through a NOT-detached transaction is only
// readable once the request "commits" (commitAll); a detached write is readable
// as soon as its promise settles. That models Harper, where a write that rejoins
// the request's deferred transaction commits after the method returns.
//
// RED before: with the sync wrapper (restores ctx.transaction when the promise
// is CREATED, not when it settles) the put lands in `pending`, the next lock
// holder reads no row, and S4 mints two rows. The awaited wrapper holds the
// detach through settlement, so the row is committed before the lock releases.

import { describe, it, expect } from "bun:test";
import { findOrCreateInstance } from "../../resources/instance-create-lock.js";
import { withDetachedTxnAsync } from "../../resources/table-helpers.js";

interface Row {
  id: string;
  publicKey: string;
  role?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Fake Instance table with deferred visibility, tied to the request context. */
function fakeTable(opts: { putDelayMs?: number } = {}) {
  const ctx: any = { transaction: { requestTxn: true } };
  let committed: Row[] = [];
  let pending: Row[] = [];
  let seq = 0;

  async function asyncPut(row: any): Promise<void> {
    await new Promise((r) => setTimeout(r, opts.putDelayMs ?? 5));
    // Detached (ctx.transaction cleared through the await) → committed now;
    // otherwise the write joins the request's deferred transaction.
    if (ctx.transaction === undefined) committed = committed.concat([{ ...row }]);
    else pending = pending.concat([{ ...row }]);
  }

  return {
    committed: () => committed.map((r) => ({ ...r })),
    pending: () => pending.map((r) => ({ ...r })),
    commitAll: () => {
      committed = committed.concat(pending);
      pending = [];
    },
    deps() {
      return {
        readAll: async () => committed.map((r) => ({ ...r })),
        put: (row: any) => withDetachedTxnAsync(ctx, () => asyncPut(row)),
        setSeed: () => {},
        seedPresent: () => true,
        mint: () => {
          const n = ++seq;
          return { id: `flair_fake${n}`, publicKey: `pk${n}`, secretKey: new Uint8Array(32).fill(n % 255) };
        },
        now: () => "2026-01-01T00:00:00.000Z",
        log: () => {},
      };
    },
  };
}

describe("in-process create lock (flair#1897 slice 1)", () => {
  it("S4: two concurrent creates commit ONE row and both are answered it (held detach)", async () => {
    const t = fakeTable();
    const deps = t.deps();
    const [a, b] = await Promise.all([findOrCreateInstance(deps), findOrCreateInstance(deps)]);
    // The write is in the COMMITTED table before the lock releases.
    expect(t.committed().length).toBe(1);
    expect(t.pending().length).toBe(0);
    if (a.kind !== "row" || b.kind !== "row") throw new Error("unreachable");
    expect(a.row.id).toBe(b.row.id);
    expect(t.committed()[0].id).toBe(a.row.id);
  });

  it("S4 with THREE concurrent creates: still one committed row, all answered it", async () => {
    const t = fakeTable();
    const deps = t.deps();
    const outs = await Promise.all([findOrCreateInstance(deps), findOrCreateInstance(deps), findOrCreateInstance(deps)]);
    expect(t.committed().length).toBe(1);
    expect(t.pending().length).toBe(0);
    const ids = outs.map((o) => (o.kind === "row" ? o.row.id : "REFUSE"));
    expect(new Set(ids).size).toBe(1);
  });

  it("S1: a real answer-before-later-put schedule — B reads A's COMMITTED row under the lock, so only one row exists", async () => {
    const t = fakeTable();
    const deps = t.deps();
    const [a, b] = await Promise.all([findOrCreateInstance(deps), findOrCreateInstance(deps)]);
    if (a.kind !== "row" || b.kind !== "row") throw new Error("unreachable");
    // A answered (its row committed); B never minted — it read A's committed row.
    expect(a.row.id).toBe(b.row.id);
    expect(t.committed().length).toBe(1);
    expect(t.pending().length).toBe(0);
    // A request-end commit changes nothing.
    t.commitAll();
    expect(t.committed().length).toBe(1);
  });

  it("a concurrent read returns while a slow create holds the lock", async () => {
    const t = fakeTable({ putDelayMs: 150 });
    const create = findOrCreateInstance(t.deps()); // holds the lock through the ~150ms put
    const started = Date.now();
    const rows = t.committed(); // a read a GET would do OUTSIDE the lock
    const elapsed = Date.now() - started;
    expect(rows.length).toBe(0);
    expect(elapsed).toBeLessThan(50); // not blocked by the in-flight create
    await create;
    expect(t.committed().length).toBe(1);
  });
});
