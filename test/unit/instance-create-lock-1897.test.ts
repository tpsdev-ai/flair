// instance-create-lock-1897.test.ts — unit tests for the FILESYSTEM TICKET lock
// (flair#1897 slice 1) with a fake table whose put commits through
// withDetachedTxnAsync (so the write is visible before the lock releases).
//
// GREEN after: two concurrent creates mint one row (both answered it); a
// post-put `none` re-read refuses naming the minted id; a re-read with our id
// returns the RE-READ row; a dead-pid claim is discarded; a live foreign claim
// yields the deadline refusal naming it; a read-only lock dir refuses with no
// mint. RED before: the realm chain let two workers each mint; the post-put
// `none` fell through to the local row; the early-restoring read wrapper read a
// stale snapshot.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findOrCreateInstance, instanceCreateLockDir } from "../../resources/instance-create-lock.js";
import { withDetachedTxnAsync } from "../../resources/table-helpers.js";

interface Row {
  id: string;
  publicKey: string;
  role?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-create-lock-"));
});
afterEach(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** A fake table: the write commits through the awaited detach. */
function fakeTable(opts: { putDelayMs?: number } = {}) {
  const ctx: any = { transaction: { requestTxn: true } };
  let rows: Row[] = [];
  let seq = 0;
  return {
    rows: () => rows.map((r) => ({ ...r })),
    deps(extra: any = {}) {
      return {
        readAll: async () => rows.map((r) => ({ ...r })),
        put: (row: any) =>
          withDetachedTxnAsync(ctx, async () => {
            await new Promise((r) => setTimeout(r, opts.putDelayMs ?? 3));
            rows = rows.filter((r) => r.id !== row.id).concat([{ ...row }]);
          }),
        setSeed: () => {},
        seedPresent: () => true,
        mint: () => {
          const n = ++seq;
          return { id: `flair_fake${n}`, publicKey: `pk${n}`, secretKey: new Uint8Array(32).fill(n % 255) };
        },
        home,
        log: () => {},
        ...extra,
      };
    },
  };
}

describe("filesystem ticket create lock (flair#1897)", () => {
  it("two concurrent creates mint ONE row and both are answered it", async () => {
    const t = fakeTable();
    const [a, b] = await Promise.all([findOrCreateInstance(t.deps()), findOrCreateInstance(t.deps())]);
    expect(t.rows().length).toBe(1);
    expect(a.kind).toBe("row");
    expect(b.kind).toBe("row");
    if (a.kind !== "row" || b.kind !== "row") throw new Error("unreachable");
    expect(a.row.id).toBe(b.row.id);
    expect(t.rows()[0].id).toBe(a.row.id);
    // No claim files left behind — assert on the directory CONTENTS, not a path string.
    expect(readdirSync(instanceCreateLockDir(home))).toEqual([]);
  });

  it("a post-put re-read of `none` REFUSES naming the minted id (no retry, no local-row fall-through)", async () => {
    const t = fakeTable();
    let reads = 0;
    const deps = t.deps({
      readAll: async () => {
        reads++;
        return reads === 1 ? [] : []; // both reads empty: the seam failed
      },
    });
    const out = await findOrCreateInstance(deps);
    expect(out.kind).toBe("refuse-unobservable");
    if (out.kind !== "refuse-unobservable") throw new Error("unreachable");
    expect(out.mintedId).toMatch(/^flair_fake/);
  });

  it("a re-read carrying our own id returns the RE-READ row, not the local object", async () => {
    const t = fakeTable();
    let reads = 0;
    const deps = t.deps({
      readAll: async () => {
        reads++;
        if (reads === 1) return [];
        // The confirming read returns OUR id with a field changed by the store.
        return [{ id: "flair_fake1", publicKey: "store-changed-pk", role: "spoke", status: "active", createdAt: "x", updatedAt: "y" }];
      },
    });
    const out = await findOrCreateInstance(deps);
    expect(out.kind).toBe("row");
    if (out.kind !== "row") throw new Error("unreachable");
    expect(out.row.publicKey).toBe("store-changed-pk");
  });

  it("a claim naming a DEAD pid is discarded and the next contender proceeds", async () => {
    const dir = instanceCreateLockDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A claim whose pid is very unlikely to exist, with the SMALLEST ticket.
    writeFileSync(join(dir, "ticket-000000000001-999999-0-dead.json"), JSON.stringify({ pid: 999999, threadId: 0 }), "utf8");
    const t = fakeTable();
    const out = await findOrCreateInstance(t.deps({ lockDeadlineMs: 300 }));
    expect(out.kind).toBe("row");
    expect(t.rows().length).toBe(1);
  });

  it("a LIVE foreign claim makes the waiter wait, and the deadline REFUSES naming it", async () => {
    const dir = instanceCreateLockDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A live claim (our own pid) with the smallest ticket; never released.
    const foreign = "ticket-000000000001-" + String(process.pid) + "-0-ffffff.json";
    writeFileSync(join(dir, foreign), JSON.stringify({ pid: process.pid, threadId: 0 }), "utf8");
    const t = fakeTable();
    const out = await findOrCreateInstance(t.deps({ lockDeadlineMs: 250 }));
    expect(out.kind).toBe("refuse-lock");
    if (out.kind !== "refuse-lock") throw new Error("unreachable");
    expect(out.detail).toContain(foreign);
    expect(t.rows().length).toBe(0); // NO mint
  });

  it("an unwritable lock dir REFUSES with no mint (skip when running as root)", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      // root bypasses mode bits — the refusal cannot be provoked; stated, not faked.
      expect(true).toBe(true);
      return;
    }
    const dir = instanceCreateLockDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o500);
    const t = fakeTable();
    const out = await findOrCreateInstance(t.deps({ lockDeadlineMs: 200 }));
    chmodSync(dir, 0o700); // restore so cleanup can remove it
    expect(out.kind).toBe("refuse-lock");
    expect(t.rows().length).toBe(0); // never mint unlocked
  });
});
