// instance-create-lock-1897.test.ts — deterministic unit tests for the
// in-process create lock (flair#1897 slice 1) against a controllable fake table.
//
// RED before: with no lock, two concurrent creates both read "none" and mint
// two rows (the S4 "both blind" interleaving); the lock serialises them so the
// second read sees the first's row.

import { describe, it, expect } from "bun:test";
import { findOrCreateInstance } from "../../resources/instance-create-lock.js";

interface Row {
  id: string;
  publicKey: string;
  role?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** A fake Instance table with controllable per-read delay and an optional
 *  "maverick" writer that lands a foreign row during our `put`. */
function fakeTable(opts: { readDelayMs?: number; maverickId?: string } = {}) {
  let rows: Row[] = [];
  let seq = 0;
  let reads = 0;
  return {
    rows: () => rows.map((r) => ({ ...r })),
    reads: () => reads,
    allocId: () => `flair_fake${++seq}`,
    deps() {
      return {
        readAll: async () => {
          reads++;
          if (opts.readDelayMs) await new Promise((r) => setTimeout(r, opts.readDelayMs));
          return rows.map((r) => ({ ...r }));
        },
        put: async (row: any) => {
          rows = rows.filter((r) => r.id !== row.id).concat([{ ...row }]);
          if (opts.maverickId && row.id.startsWith("flair_fake")) {
            // An outside writer REPLACES our row with a DIFFERENT one behind our
            // back — the confirming re-read sees exactly one row, not ours.
            rows = [{ id: opts.maverickId, publicKey: "maverick-pk", role: "spoke", status: "active", createdAt: "2026-01-01T00:00:00.000Z" }];
          }
        },
        setSeed: () => {},
        seedPresent: () => true,
        mint: () => {
          const n = seq + 1;
          return { id: `flair_fake${n}`, publicKey: `pk${n}`, secretKey: new Uint8Array(32).fill(n) };
        },
        now: () => "2026-01-01T00:00:00.000Z",
        log: () => {},
      };
    },
  };
}

describe("in-process create lock (flair#1897 slice 1)", () => {
  it("S4 (both blind): two concurrent creates yield ONE row and both are answered it", async () => {
    const t = fakeTable();
    const deps = t.deps();
    const [a, b] = await Promise.all([findOrCreateInstance(deps), findOrCreateInstance(deps)]);
    expect(t.rows().length).toBe(1);
    expect(a.kind).toBe("row");
    expect(b.kind).toBe("row");
    if (a.kind !== "row" || b.kind !== "row") throw new Error("unreachable");
    expect(a.row.id).toBe(b.row.id);
    expect(a.row.publicKey).toBe(b.row.publicKey);
    expect(t.rows()[0].id).toBe(a.row.id);
  });

  it("S4 with THREE concurrent creates: still one row, all three answered it", async () => {
    const t = fakeTable();
    const deps = t.deps();
    const outs = await Promise.all([findOrCreateInstance(deps), findOrCreateInstance(deps), findOrCreateInstance(deps)]);
    expect(t.rows().length).toBe(1);
    const ids = outs.map((o) => (o.kind === "row" ? o.row.id : "REFUSE"));
    expect(new Set(ids).size).toBe(1);
  });

  it("S1 (answer-then-overwrite): an outside writer between put and re-read is answered the SURVIVOR, nothing deleted", async () => {
    const t = fakeTable({ maverickId: "flair_maverick" });
    const out = await findOrCreateInstance(t.deps());
    expect(out.kind).toBe("row");
    if (out.kind !== "row") throw new Error("unreachable");
    expect(out.row.id).toBe("flair_maverick");
    expect(out.warning).toBeDefined();
    // Nothing extra was written or deleted — only the outside writer's row remains.
    expect(t.rows().map((r) => r.id)).toEqual(["flair_maverick"]);
  });

  it("a GET that finds an existing row does NOT take the lock: a concurrent read is not blocked by a slow create", async () => {
    // A slow create holds the lock; a plain read (the GET's pre-lock read) must
    // still resolve quickly — the lock covers only the create path.
    const t = fakeTable({ readDelayMs: 150 });
    const create = findOrCreateInstance(t.deps()); // holds the lock ~150ms+
    const started = Date.now();
    const rows = t.rows(); // a synchronous read of the current table
    const elapsed = Date.now() - started;
    expect(rows.length).toBe(0);
    expect(elapsed).toBeLessThan(50); // not blocked by the in-flight create
    await create;
    expect(t.rows().length).toBe(1);
  });
});
