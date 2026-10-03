// ─── flair#2139 S1 — the shared InstructionVersion append helper ─────────────
//
// recordVersion is the only writer of InstructionVersion. This exercises the
// paths a real Harper boundary cannot reach in slice 1 (Soul callers are
// unguarded, so no REST request compares a head): the expected-head guard, the
// fail-closed rollback on an injected failure at each stage, and the
// duplicate-sequence-id collision. It runs in test/unit-isolated because it
// mocks "harper" and installs its own global transaction, neither of which may
// race another file's mock in a shared process.
import { describe, expect, test, beforeEach } from "bun:test";
import { mock } from "bun:test";

type Row = Record<string, any>;
const store = new Map<string, Row>();
const pending = new Set<string>();
let hideHead = false;
let failNextAppend = false;
let failNextCommit = false;

const primaryStore = {
  tryLock: () => true,
  unlock: () => {},
  resetReadTxn: () => {},
};

function stage(ctx: any, apply: () => void): void {
  const txn = ctx?.transaction;
  if (txn && txn.open === 1 && Array.isArray(txn.staged)) txn.staged.push(apply);
  else apply();
}

const InstructionVersionTable = {
  primaryStore,
  async *search(query: any): AsyncGenerator<Row> {
    if (hideHead) return;
    const conds: any[] = query?.conditions ?? [];
    const rows = [...store.values()].filter((row) => conds.every((c) => row[c.attribute] === c.value));
    rows.sort((a, b) => Number(b.version) - Number(a.version));
    const limit = query?.limit ?? rows.length;
    for (const row of rows.slice(0, limit)) yield row;
  },
  async put(record: Row, ctx: any): Promise<void> {
    if (failNextAppend) { failNextAppend = false; throw new Error("append-write-failed"); }
    if (store.has(record.id) || pending.has(record.id)) throw new Error("duplicate instruction version id");
    pending.add(record.id);
    stage(ctx, () => { store.set(record.id, { ...record }); pending.delete(record.id); });
  },
};

mock.module("harper", () => ({ databases: { flair: { InstructionVersion: InstructionVersionTable } } }));

function mockTransaction(ctx: any, cb: (txn: any) => any): any {
  const context = ctx && typeof ctx === "object" ? ctx : {};
  if (context.transaction && context.transaction.open === 1) return cb(context.transaction);
  const staged: Array<() => void> = [];
  const txn: any = {
    open: 1, saveCommits: false, staged, aborted: false,
    abort() { this.open = 0; this.aborted = true; staged.length = 0; },
    commit() { if (failNextCommit) { failNextCommit = false; this.abort(); throw new Error("commit-failed"); } this.open = 0; for (const f of staged) f(); staged.length = 0; },
  };
  context.transaction = txn;
  let result: any;
  try { result = cb(txn); } catch (e) { txn.abort(); throw e; }
  if (result && typeof result.then === "function") {
    return result.then((r: any) => { txn.commit(); return r; }, (e: any) => { txn.abort(); throw e; });
  }
  txn.commit();
  return result;
}

const { recordVersion, recordDigest, valueDigest, versionId, soulSubjectId, soulAttribution, subjectTypeReadable, RECORD_HASH_FIELDS } =
  await import("../../resources/instruction-version-record.ts");

const NOW = "2026-10-03T00:00:00.000Z";
const operator = { actorKind: "operator", actorId: "admin", sourceClass: "operator" } as const;

function input(overrides: Row = {}): any {
  return {
    subjectType: "soul",
    subjectId: soulSubjectId("agent-a", "role"),
    agentId: "agent-a",
    key: "role",
    kind: "create",
    rowId: "agent-a:role",
    value: "v1",
    soulSnapshot: JSON.stringify({ id: "agent-a:role", value: "v1" }),
    attribution: { ...operator },
    createdAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  store.clear();
  pending.clear();
  hideHead = false;
  failNextAppend = false;
  failNextCommit = false;
  (globalThis as any).transaction = mockTransaction;
});

const okRow = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });

describe("instruction version — pure helpers", () => {
  test("version ids encode the subject and sequence, never a content hash", () => {
    expect(versionId("soul", "agent-a:role", 1n)).toBe("soul:agent-a:role:1");
    expect(versionId("soul", "agent-a:role", 12n)).toBe("soul:agent-a:role:12");
    // Recurring value ⇒ distinct id only because the sequence differs.
    const a = versionId("soul", "agent-a:role", 1n);
    const b = versionId("soul", "agent-a:role", 2n);
    expect(a).not.toBe(b);
  });

  test("the value digest is the exact value bytes; a tombstone has none", () => {
    expect(valueDigest("v1")).toBe(valueDigest("v1"));
    expect(valueDigest("v1")).not.toBe(valueDigest("v2"));
    expect(valueDigest(null)).toBeNull();
    expect(valueDigest(undefined)).toBeNull();
  });

  test("the record digest covers every field but recordHash, including the predecessor", () => {
    const base: Row = { id: "soul:a:role:1", previousVersionHash: null };
    const withPrev: Row = { ...base, previousVersionHash: "deadbeef" };
    expect(recordDigest(base)).not.toBe(recordDigest(withPrev));
    for (const field of RECORD_HASH_FIELDS) {
      const changed = { ...base, [field]: "x" };
      expect(recordDigest(changed), `changing ${field} must change the digest`).not.toBe(recordDigest(base));
    }
    expect(RECORD_HASH_FIELDS).not.toContain("recordHash");
  });

  test("read authority is default-deny per subject type", () => {
    expect(subjectTypeReadable("soul")).toBe(true);
    expect(subjectTypeReadable("skill")).toBe(false);
    expect(subjectTypeReadable("nonsense")).toBe(false);
    expect(subjectTypeReadable(undefined)).toBe(false);
  });

  test("attribution is derived from the auth verdict, not a request body", () => {
    expect(soulAttribution({ kind: "agent", agentId: "admin", isAdmin: true }, "operator"))
      .toEqual({ actorKind: "operator", actorId: "admin", sourceClass: "operator" });
    expect(soulAttribution({ kind: "internal" } as any, "internal"))
      .toEqual({ actorKind: "internal", actorId: null, sourceClass: "internal" });
  });
});

describe("instruction version — recordVersion lifecycle and chain", () => {
  test("appends an ordered chain and runs the row mutation in one transaction", async () => {
    const first = await recordVersion({}, input(), async () => okRow());
    expect(first.ok).toBe(true);
    const second = await recordVersion({}, input({ kind: "update", value: "v2" }), async () => okRow());
    expect(second.ok).toBe(true);

    const v1 = store.get("soul:agent-a:role:1")!;
    const v2 = store.get("soul:agent-a:role:2")!;
    expect(v1.previousVersionHash).toBeNull();
    expect(v2.previousVersionHash).toBe(v1.recordHash);
    expect(v1.recordHash).toBe(recordDigest(v1));
    expect(v2.recordHash).toBe(recordDigest(v2));
    expect(v1.valueHash).toBe(valueDigest("v1"));
    expect(v2.valueHash).toBe(valueDigest("v2"));
    expect(BigInt(v2.version)).toBe(2n);
  });

  test("a delete appends a chained tombstone with no value or payload", async () => {
    await recordVersion({}, input(), async () => okRow());
    const del = await recordVersion({}, input({ kind: "delete", value: null, soulSnapshot: null }), async () => okRow());
    expect(del.ok).toBe(true);
    const tomb = store.get("soul:agent-a:role:2")!;
    expect(tomb.kind).toBe("delete");
    expect(tomb.valueHash).toBeNull();
    expect(tomb.soulSnapshot).toBeNull();
    expect(tomb.previousVersionHash).toBe(store.get("soul:agent-a:role:1")!.recordHash);
  });

  test("distinct subjects hold independent sequences", async () => {
    await recordVersion({}, input(), async () => okRow());
    await recordVersion({}, input({ subjectId: soulSubjectId("agent-b", "role"), agentId: "agent-b" }), async () => okRow());
    expect(store.has("soul:agent-a:role:1")).toBe(true);
    expect(store.has("soul:agent-b:role:1")).toBe(true);
  });

  test("unguarded records carry guarded:false and expectedVersion:null", async () => {
    await recordVersion({}, input(), async () => okRow());
    const v1 = store.get("soul:agent-a:role:1")!;
    expect(v1.guarded).toBe(false);
    expect(v1.expectedVersion).toBeNull();
  });

  test("a key change closes the old subject with a tombstone and continues the new one", async () => {
    await recordVersion({}, input(), async () => okRow());
    const res = await recordVersion(
      {},
      input({ subjectId: soulSubjectId("agent-a", "new"), key: "new", previousSubjectId: soulSubjectId("agent-a", "role"), previousKey: "role", previousRowId: "agent-a:role" }),
      async () => okRow(),
    );
    expect(res.ok).toBe(true);
    const oldTomb = store.get("soul:agent-a:role:2")!;
    expect(oldTomb.kind).toBe("delete");
    expect(store.get("soul:agent-a:new:1")).toBeDefined();
  });
});

describe("instruction version — guard, collisions and failure injection", () => {
  test("a guarded append stores the compared head; a stale compare is refused without writing", async () => {
    await recordVersion({}, input(), async () => okRow());
    const head = store.get("soul:agent-a:role:1")!;
    const good = await recordVersion({}, input({ kind: "update", expectedVersion: head.id }), async () => okRow());
    expect(good.ok).toBe(true);
    const guarded = store.get("soul:agent-a:role:2")!;
    expect(guarded.guarded).toBe(true);
    expect(guarded.expectedVersion).toBe(head.id);

    const before = store.size;
    const stale = await recordVersion({}, input({ kind: "update", expectedVersion: "soul:agent-a:role:1" }), async () => okRow());
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.response.status).toBe(409);
    expect(store.size).toBe(before);
  });

  test("competing expected-head calls admit exactly one", async () => {
    await recordVersion({}, input(), async () => okRow());
    const head = store.get("soul:agent-a:role:1")!;
    const results = await Promise.all([
      recordVersion({}, input({ kind: "update", expectedVersion: head.id, value: "x" }), async () => okRow()),
      recordVersion({}, input({ kind: "update", expectedVersion: head.id, value: "y" }), async () => okRow()),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(store.has("soul:agent-a:role:3")).toBe(false);
  });

  test("a duplicate sequence id rolls the whole transaction back", async () => {
    // The head is hidden, so the next append is allocated the sequence already on disk.
    store.set("soul:agent-a:role:1", { id: "soul:agent-a:role:1", version: 1n, recordHash: "x", subjectType: "soul", subjectId: "soul", kind: "create" });
    hideHead = true;
    let mutated = false;
    const res = await recordVersion({}, input(), async () => { mutated = true; return okRow(); });
    expect(res.ok).toBe(false);
    expect(mutated).toBe(false);
    expect([...store.keys()]).toEqual(["soul:agent-a:role:1"]);
  });

  test("a head-read failure rolls back: no version, no row", async () => {
    const boom = { ...InstructionVersionTable, async *search(): AsyncGenerator<Row> { throw new Error("head-read-failed"); } };
    const saved = InstructionVersionTable.search;
    (InstructionVersionTable as any).search = boom.search;
    try {
      const res = await recordVersion({}, input(), async () => okRow());
      expect(res.ok).toBe(false);
      expect(store.size).toBe(0);
    } finally {
      (InstructionVersionTable as any).search = saved;
    }
  });

  test("an append failure rolls back: no version, no row mutation", async () => {
    failNextAppend = true;
    let mutated = false;
    const res = await recordVersion({}, input(), async () => { mutated = true; return okRow(); });
    expect(res.ok).toBe(false);
    expect(mutated).toBe(false);
    expect(store.size).toBe(0);
  });

  test("a row-write failure rolls the append back: no phantom version", async () => {
    const res = await recordVersion({}, input(), async () => new Response(JSON.stringify({ error: "denied" }), { status: 403 }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(403);
    expect(store.size).toBe(0);
  });

  test("a commit failure rolls back: no version, no row", async () => {
    failNextCommit = true;
    const rowStore = new Map<string, number>();
    const res = await recordVersion({}, input(), async (shared: any) => {
      stage(shared, () => rowStore.set("row", 1));
      return okRow();
    });
    expect(res.ok).toBe(false);
    expect(store.size).toBe(0);
    expect(rowStore.size).toBe(0);
  });
});
