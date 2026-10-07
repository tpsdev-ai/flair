// ─── flair#2139 S1 — the shared InstructionVersion append helper ─────────────
//
import { describe, expect, test, beforeEach } from "bun:test";
import { mock } from "bun:test";

type Row = Record<string, any>;
const store = new Map<string, Row>();
const soulStore = new Map<string, Row>();
const locks = new Set<string>();
let onBlocked: (() => void) | undefined;
let pausePatch: (() => Promise<void>) | undefined;
let soulReads = 0;
let hideHead = false;
let failNextAppend = false;
let failNextCommit = false;

const primaryStore = {
  tryLock: (key: unknown) => {
    const k = JSON.stringify(key);
    if (locks.has(k)) { onBlocked?.(); return false; }
    locks.add(k); return true;
  },
  unlock: (key: unknown) => { locks.delete(JSON.stringify(key)); },
  resetReadTxn: () => {},
};

function stage(ctx: any, apply: () => void): void {
  const txn = ctx?.transaction;
  if (txn && txn.open === 1 && Array.isArray(txn.staged)) txn.staged.push(apply);
  else apply();
}

const InstructionVersionTable = {
  primaryStore,
  async *search(query: any, ctx?: any): AsyncGenerator<Row> {
    if (hideHead) return;
    const conds: any[] = query?.conditions ?? [];
    const rows = [...(ctx?.transaction?.versions ?? store).values()].filter((row) => conds.every((c) => row[c.attribute] === c.value));
    rows.sort((a, b) => Number(b.version) - Number(a.version));
    const limit = query?.limit ?? rows.length;
    for (const row of rows.slice(0, limit)) yield row;
  },
  async put(record: Row, ctx: any): Promise<void> {
    (ctx?.transaction?.versions ?? store).set(record.id, { ...record });
  },
  async create(record: Row, ctx: any): Promise<void> {
    if (failNextAppend) { failNextAppend = false; throw new Error("append-write-failed"); }
    const rows = ctx?.transaction?.versions ?? store;
    if (rows.has(record.id)) throw new Error("Record already exists");
    rows.set(record.id, { ...record });
  },
};

class BaseSoul {
  id?: string;
  ctx: any;
  getContext() { return this.ctx; }
  getId() { return this.id; }
  static async get(id: string, ctx: any) {
    expect(locks.size).toBeGreaterThan(0);
    expect(ctx?.transaction?.open).toBe(1);
    soulReads++;
    return (ctx?.transaction?.souls ?? soulStore).get(id) ?? null;
  }
  static async *search(query: any, ctx: any): AsyncGenerator<Row> {
    expect(locks.size).toBeGreaterThan(0);
    expect(ctx?.transaction?.open).toBe(1);
    for (const row of (ctx.transaction.souls as Map<string, Row>).values()) {
      if (query.conditions.every((c: any) => row[c.attribute] === c.value)) yield row;
    }
  }
  async get(id = this.id) { return BaseSoul.get(id!, this.ctx); }
  async post(content: Row) { this.ctx.transaction.souls.set(content.id, { ...content }); return content; }
  async put(content: Row) { this.ctx.transaction.souls.set(content.id, { ...content }); return content; }
  async patch(content: Row) {
    const rows = this.ctx.transaction.souls;
    rows.set(this.id, { ...rows.get(this.id), ...content });
    if (pausePatch) await pausePatch();
    return rows.get(this.id);
  }
  async delete(target?: any) {
    if (target?.isCollection) this.ctx.transaction.souls.clear();
    else this.ctx.transaction.souls.delete(this.id);
  }
}
const empty = { async *search() {} };
mock.module("harper", () => ({
  Resource: class {}, server: { http() {} },
  databases: { flair: { InstructionVersion: InstructionVersionTable, Soul: BaseSoul, Memory: empty, MemoryCandidate: empty, Instance: empty } },
}));

function mockTransaction(ctx: any, cb: (txn: any) => any): any {
  const context = ctx && typeof ctx === "object" ? ctx : {};
  if (context.transaction && context.transaction.open === 1) return cb(context.transaction);
  const staged: Array<() => void> = [];
  const txn: any = {
    open: 1, saveCommits: false, staged, aborted: false,
    versions: new Map(store), souls: new Map(soulStore),
    abort() { this.open = 0; this.aborted = true; staged.length = 0; },
    commit() { if (failNextCommit) { failNextCommit = false; this.abort(); throw new Error("commit-failed"); } this.open = 0; store.clear(); for (const [id, row] of this.versions) store.set(id, row);
      soulStore.clear(); for (const [id, row] of this.souls) soulStore.set(id, row);
      for (const f of staged) f(); staged.length = 0; },
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

const { recordVersion, recordDigest, valueDigest, versionId, soulSubjectId, subjectTypeReadable, RECORD_HASH_FIELDS } =
  await import("../../resources/instruction-version-record.ts");

const NOW = "2020-01-01T00:00:00.000Z";
const context = () => ({ request: { tpsAgent: "admin", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "Basic verified" }) } });
const { Soul } = await import("../../resources/Soul.ts");
function soul(id?: string): any {
  const resource: any = new Soul(); resource.id = id; resource.ctx = context(); return resource;
}
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
  soulStore.clear();
  locks.clear();
  pausePatch = undefined;
  onBlocked = undefined;
  soulReads = 0;
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

  test("caller-supplied attribution and time are ignored", async () => {
    const res = await recordVersion(context(), input({ attribution: { actorKind: "agent", actorId: "forged", sourceClass: "federation" }, createdAt: NOW }), async () => okRow());
    expect(res.ok).toBe(true);
    const row = store.get("soul:agent-a:role:1")!;
    expect({ actorKind: row.actorKind, actorId: row.actorId, sourceClass: row.sourceClass }).toEqual(operator);
    expect(Date.parse(row.createdAt)).toBeGreaterThan(Date.parse(NOW));
    store.clear();
    const internal = await recordVersion({ __flairInternal: true }, input({ attribution: operator }), async () => okRow());
    expect(internal.ok).toBe(true);
    const recorded = store.get("soul:agent-a:role:1")!;
    expect(recorded.actorKind).toBe("internal");
    expect(recorded.actorId).toBeNull();
    expect(recorded.sourceClass).toBe("internal");
  });

  test("unverified context cannot append or mutate", async () => {
    let mutated = false;
    const res = await recordVersion({ request: { headers: new Headers({ authorization: "Basic forged" }) } }, input(), async () => { mutated = true; });
    expect(res.ok).toBe(false);
    expect(mutated).toBe(false);
    expect(store.size).toBe(0);
  });

});

describe("instruction version — recordVersion lifecycle and chain", () => {
  test("appends an ordered chain and runs the row mutation in one transaction", async () => {
    const first = await recordVersion(context(), input(), async () => okRow());
    expect(first.ok).toBe(true);
    const second = await recordVersion(context(), input({ kind: "update", value: "v2" }), async () => okRow());
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
    await recordVersion(context(), input(), async () => okRow());
    const del = await recordVersion(context(), input({ kind: "delete", value: null, soulSnapshot: null }), async () => okRow());
    expect(del.ok).toBe(true);
    const tomb = store.get("soul:agent-a:role:2")!;
    expect(tomb.kind).toBe("delete");
    expect(tomb.valueHash).toBeNull();
    expect(tomb.soulSnapshot).toBeNull();
    expect(tomb.previousVersionHash).toBe(store.get("soul:agent-a:role:1")!.recordHash);
  });

  test("distinct subjects hold independent sequences", async () => {
    await recordVersion(context(), input(), async () => okRow());
    await recordVersion(context(), input({ subjectId: soulSubjectId("agent-b", "role"), agentId: "agent-b" }), async () => okRow());
    expect(store.has("soul:agent-a:role:1")).toBe(true);
    expect(store.has("soul:agent-b:role:1")).toBe(true);
  });

  test("unguarded records carry guarded:false and expectedVersion:null", async () => {
    await recordVersion(context(), input(), async () => okRow());
    const v1 = store.get("soul:agent-a:role:1")!;
    expect(v1.guarded).toBe(false);
    expect(v1.expectedVersion).toBeNull();
  });

  test("a key change closes the old subject with a tombstone and continues the new one", async () => {
    await recordVersion(context(), input(), async () => okRow());
    const res = await recordVersion(
      context(),
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
    await recordVersion(context(), input(), async () => okRow());
    const head = store.get("soul:agent-a:role:1")!;
    const good = await recordVersion(context(), input({ kind: "update", expectedVersion: head.id }), async () => okRow());
    expect(good.ok).toBe(true);
    const guarded = store.get("soul:agent-a:role:2")!;
    expect(guarded.guarded).toBe(true);
    expect(guarded.expectedVersion).toBe(head.id);

    const before = store.size;
    const stale = await recordVersion(context(), input({ kind: "update", expectedVersion: "soul:agent-a:role:1" }), async () => okRow());
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.response.status).toBe(409);
    expect(store.size).toBe(before);
  });

  test("competing expected-head calls admit exactly one", async () => {
    await recordVersion(context(), input(), async () => okRow());
    const head = store.get("soul:agent-a:role:1")!;
    const results = await Promise.all([
      recordVersion(context(), input({ kind: "update", expectedVersion: head.id, value: "x" }), async () => okRow()),
      recordVersion(context(), input({ kind: "update", expectedVersion: head.id, value: "y" }), async () => okRow()),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(store.has("soul:agent-a:role:3")).toBe(false);
  });

  test("a duplicate sequence id rolls the whole transaction back", async () => {
    // The head is hidden, so the next append is allocated the sequence already on disk.
    store.set("soul:agent-a:role:1", { id: "soul:agent-a:role:1", version: 1n, recordHash: "x", subjectType: "soul", subjectId: "soul", kind: "create" });
    hideHead = true;
    soulStore.set("agent-a:role", { value: "before" });
    const before = structuredClone(store.get("soul:agent-a:role:1"));
    const res = await recordVersion(context(), input(), async (shared) => { shared.transaction.souls.set("agent-a:role", { value: "after" }); return okRow(); });
    expect(res.ok).toBe(false);
    expect([...store.keys()]).toEqual(["soul:agent-a:role:1"]);
    expect(store.get("soul:agent-a:role:1")).toEqual(before);
    expect(soulStore.get("agent-a:role")).toEqual({ value: "before" });
  });

  test("a head-read failure rolls back: no version, no row", async () => {
    const boom = { ...InstructionVersionTable, async *search(): AsyncGenerator<Row> { throw new Error("head-read-failed"); } };
    const saved = InstructionVersionTable.search;
    (InstructionVersionTable as any).search = boom.search;
    try {
      const res = await recordVersion(context(), input(), async () => okRow());
      expect(res.ok).toBe(false);
      expect(store.size).toBe(0);
    } finally {
      (InstructionVersionTable as any).search = saved;
    }
  });

  test("an append failure rolls back the staged row mutation", async () => {
    failNextAppend = true;
    let mutated = false;
    soulStore.set("row", { value: "before" });
    const res = await recordVersion(context(), input(), async (shared) => { mutated = true; shared.transaction.souls.set("row", { value: "after" }); return okRow(); });
    expect(res.ok).toBe(false);
    expect(mutated).toBe(true);
    expect(store.size).toBe(0);
    expect(soulStore.get("row")).toEqual({ value: "before" });
  });

  test("a row-write failure rolls the append back: no phantom version", async () => {
    const res = await recordVersion(context(), input(), async () => new Response(JSON.stringify({ error: "denied" }), { status: 403 }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(403);
    expect(store.size).toBe(0);
  });

  test("a commit failure rolls back: no version, no row", async () => {
    failNextCommit = true;
    const rowStore = new Map<string, number>();
    const res = await recordVersion(context(), input(), async (shared: any) => {
      stage(shared, () => rowStore.set("row", 1));
      return okRow();
    });
    expect(res.ok).toBe(false);
    expect(store.size).toBe(0);
    expect(rowStore.size).toBe(0);
  });
});


describe("Soul resource version snapshots", () => {
  test("collection and unbound deletes are refused without changing rows or history", async () => {
    const row = { id: "agent-a:role", agentId: "agent-a", key: "role", value: "before" };
    soulStore.set(row.id, row);
    for (const [id, target] of [
      [undefined, { isCollection: true }],
      [undefined, row.id],
      [row.id, { isCollection: true }],
    ] as const) {
      const result = await soul(id).delete(target);
      expect(result).toBeInstanceOf(Response);
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({ error: "soul_delete_requires_one_record" });
      expect([...soulStore.values()]).toEqual([row]);
      expect(store.size).toBe(0);
    }
  });

  test("a bound row delete appends a tombstone", async () => {
    const row = { id: "agent-a:role", agentId: "agent-a", key: "role", value: "before" };
    await soul(row.id).put(row);
    await soul(row.id).delete({ id: row.id });
    expect(soulStore.has(row.id)).toBe(false);
    expect([...store.values()].map((version) => version.kind)).toEqual(["create", "delete"]);
  });

  test("POST generates the physical id and snapshots the whole stored row", async () => {
    const result = await soul().post({ agentId: "agent-a", key: "role", value: "v1", originatorInstanceId: "forged" });
    expect(result instanceof Response).toBe(false);
    const [version] = [...store.values()];
    const row = soulStore.get(version.rowId)!;
    expect(version.rowId).toBe(row.id);
    expect(version.rowId).not.toBe("agent-a:role");
    expect(row.originatorInstanceId).toBeNull();
    expect(JSON.parse(version.soulSnapshot)).toEqual(row);
  });

  test("PUT without a body id preserves Soul createdAt and records fresh version times", async () => {
    const id = "agent-a:role";
    soulStore.set(id, { id, agentId: "agent-a", key: "role", value: "before", createdAt: NOW, originatorInstanceId: "stored" });
    for (const value of ["v1", "v2"]) {
      const before = Date.now();
      const result = await soul(id).put({ agentId: "agent-a", key: "role", value, createdAt: "forged", originatorInstanceId: "forged" });
      expect(result instanceof Response).toBe(false);
      const row = soulStore.get(id)!;
      const version = [...store.values()].at(-1)!;
      expect(row.id).toBe(id);
      expect(row.createdAt).toBe(NOW);
      expect(row.originatorInstanceId).toBe("stored");
      expect(JSON.parse(version.soulSnapshot)).toEqual(row);
      expect(version.createdAt).not.toBe(NOW);
      expect(Date.parse(version.createdAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(version.createdAt)).toBeLessThanOrEqual(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const versions = [...store.values()];
    expect(Date.parse(versions[1].createdAt)).toBeGreaterThan(Date.parse(versions[0].createdAt));
  });

  test("PATCH strips client server fields before snapshotting the stored row", async () => {
    const id = "agent-a:role";
    soulStore.set(id, { id, agentId: "agent-a", key: "role", value: "before", createdAt: NOW, originatorInstanceId: "stored" });
    const result = await soul(id).patch({ value: "after", createdAt: "forged", originatorInstanceId: "forged" });
    expect(result instanceof Response).toBe(false);
    const row = soulStore.get(id)!;
    expect(row.createdAt).toBe(NOW);
    expect(row.originatorInstanceId).toBe("stored");
    const [version] = [...store.values()];
    expect(JSON.parse(version.soulSnapshot)).toEqual(row);
    expect(version.valueHash).toBe(valueDigest(row.value));
  });

  test("overlapping PATCHes read stored state under the lock and snapshot both changes", async () => {
    const id = "agent-a:role";
    soulStore.set(id, { id, agentId: "agent-a", key: "role", value: "before", durability: "permanent", createdAt: NOW });
    let release!: () => void;
    let started!: () => void;
    let blocked!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const inPatch = new Promise<void>((resolve) => { started = resolve; });
    const waitingOnLock = new Promise<void>((resolve) => { blocked = resolve; });
    pausePatch = async () => { started(); await wait; };
    onBlocked = () => blocked();
    const first = soul(id).patch({ value: "after" });
    await inPatch;
    const reads = soulReads;
    const second = soul(id).patch({ durability: "persistent", originatorInstanceId: "forged" });
    await waitingOnLock;
    expect(soulReads).toBe(reads);
    release();
    const results = await Promise.all([first, second]);
    expect(results.some((r) => r instanceof Response)).toBe(false);
    const versions = [...store.values()];
    expect(JSON.parse(versions[0].soulSnapshot).value).toBe("after");
    expect(JSON.parse(versions[0].soulSnapshot).durability).toBe("permanent");
    expect(JSON.parse(versions[1].soulSnapshot)).toEqual(soulStore.get(id));
    expect(JSON.parse(versions[1].soulSnapshot).value).toBe("after");
    expect(JSON.parse(versions[1].soulSnapshot).durability).toBe("persistent");
    expect(JSON.parse(versions[1].soulSnapshot).originatorInstanceId).toBeUndefined();
  }, 3000);

  test("snapshot serialization failure aborts the staged Soul write and append", async () => {
    soulStore.set("row", { value: "before" });
    const res = await recordVersion(context(), input({ snapshot: () => { throw new Error("snapshot unavailable"); } }), async (shared) => {
      shared.transaction.souls.set("row", { value: "after" });
    });
    expect(res.ok).toBe(false);
    expect(soulStore.get("row")).toEqual({ value: "before" });
    expect(store.size).toBe(0);
  });

  test("key-change tombstone and successor collisions roll back the whole Soul write", async () => {
    for (const collision of ["role", "new"]) {
      store.clear();
      const id = "agent-a:role";
      const before = { id, agentId: "agent-a", key: "role", value: "before", createdAt: NOW };
      soulStore.set(id, before);
      const occupiedId = `soul:agent-a:${collision}:1`;
      const occupied = { id: occupiedId, version: 1n, subjectType: "soul", subjectId: "hidden", recordHash: "unchanged" };
      store.set(occupiedId, occupied);
      const result = await soul(id).put({ agentId: "agent-a", key: "new", value: "after" });
      expect(result.status).toBe(500);
      expect(soulStore.get(id)).toEqual(before);
      expect([...store.values()]).toEqual([occupied]);
    }
  });

  test("an agentId-only PUT to an unoccupied destination closes the old window", async () => {
    const id = "agent-a:role";
    soulStore.set(id, { id, agentId: "agent-a", key: "role", value: "before", createdAt: NOW });
    const result = await soul(id).put({ agentId: "agent-b", key: "role", value: "after" });
    expect(result instanceof Response).toBe(false);
    const oldVersions = [...store.values()].filter((v) => v.subjectId === "agent-a:role");
    const newVersions = [...store.values()].filter((v) => v.subjectId === "agent-b:role");
    expect(oldVersions.map((v) => v.kind)).toEqual(["delete"]);
    expect(oldVersions[0].agentId).toBe("agent-a");
    expect(newVersions.map((v) => v.kind)).toEqual(["update"]);
    expect(newVersions[0].agentId).toBe("agent-b");
    expect(newVersions[0].previousVersionHash).toBeNull();
  });

  test("an agentId-only PATCH to an unoccupied destination closes the old window", async () => {
    const id = "agent-a:role";
    soulStore.set(id, { id, agentId: "agent-a", key: "role", value: "before", createdAt: NOW });
    const result = await soul(id).patch({ agentId: "agent-b" });
    expect(result instanceof Response).toBe(false);
    const oldVersions = [...store.values()].filter((v) => v.subjectId === "agent-a:role");
    const newVersions = [...store.values()].filter((v) => v.subjectId === "agent-b:role");
    expect(oldVersions.map((v) => v.kind)).toEqual(["delete"]);
    expect(newVersions.map((v) => v.kind)).toEqual(["update"]);
    expect(newVersions[0].agentId).toBe("agent-b");
  });

  for (const method of ["put", "patch"] as const) {
    test(`${method} closes the old window for colon-colliding identity pairs`, async () => {
      const id = "physical";
      await soul(id).post({ id, agentId: "a", key: "b:c", value: "before" });
      const created = [...store.values()][0];
      const result = await soul(id)[method]({ agentId: "a:b", key: "c", value: "after" });
      expect(result instanceof Response).toBe(false);
      const oldVersions = [...store.values()].filter((v) => v.agentId === "a" && v.key === "b:c");
      const newVersions = [...store.values()].filter((v) => v.agentId === "a:b" && v.key === "c");
      expect(oldVersions.map((v) => v.kind)).toEqual(["create", "delete"]);
      expect(oldVersions[1].previousVersionHash).toBe(created.recordHash);
      expect(newVersions.map((v) => v.kind)).toEqual(["update"]);
      expect(newVersions[0].previousVersionHash).toBeNull();
      expect(newVersions[0].subjectId).not.toBe(oldVersions[0].subjectId);
      expect(soulStore.get(id)?.agentId).toBe("a:b");
    });

    test(`${method} refuses an occupied destination without changing either row or history`, async () => {
      for (const field of ["agentId", "key"] as const) {
        store.clear(); soulStore.clear();
        const destination = field === "agentId" ? { agentId: "b", key: "role" } : { agentId: "a", key: "other" };
        await soul("source").post({ id: "source", agentId: "a", key: "role", value: "before" });
        await soul("destination").post({ id: "destination", ...destination, value: "occupied" });
        const rows = structuredClone([...soulStore.values()]);
        const versions = structuredClone([...store.values()]);
        const result = await soul("source")[method]({ ...destination, value: "after" });
        expect(result.status).toBe(409);
        expect(await result.json()).toEqual({ error: "soul_subject_occupied" });
        expect([...soulStore.values()]).toEqual(rows);
        expect([...store.values()]).toEqual(versions);
      }
    });
  }

  test("the previous pair closes even when supplied subject strings match", async () => {
    await soul("source").post({ id: "source", agentId: "a", key: "b:c", value: "before" });
    const nextSubject = soulSubjectId("a:b", "c");
    const result = await recordVersion(context(), input({
      subjectId: nextSubject, agentId: "a:b", key: "c", kind: "update", rowId: "source",
      previousSubjectId: nextSubject, previousAgentId: "a", previousKey: "b:c", previousRowId: "source",
    }), async () => okRow());
    expect(result.ok).toBe(true);
    expect([...store.values()].filter((v) => v.agentId === "a").map((v) => v.kind)).toEqual(["create", "delete"]);
  });

  test("legacy colon history continues by pair without taking a colliding pair's head", async () => {
    const subjectId = "a:b:c";
    const legacy = { id: `soul:${subjectId}:1`, subjectType: "soul", subjectId, agentId: "a", key: "b:c", version: 1n, kind: "create", recordHash: "legacy" };
    store.set(legacy.id, legacy);
    store.set(`soul:${subjectId}:2`, { ...legacy, id: `soul:${subjectId}:2`, agentId: "a:b", key: "c", version: 2n, recordHash: "other-pair" });
    soulStore.set("source", { id: "source", agentId: "a", key: "b:c", value: "before" });
    const result = await soul("source").patch({ value: "after" });
    expect(result instanceof Response).toBe(false);
    const latest = [...store.values()].at(-1)!;
    expect(latest.subjectId).toBe(soulSubjectId("a", "b:c"));
    expect(latest.previousVersionHash).toBe("legacy");
    expect(latest.version).toBe(2n);
    expect(store.get(legacy.id)).toEqual(legacy);
  });

  test("a legacy version ID collision rolls back instead of merging pairs", async () => {
    const subjectId = soulSubjectId("a", "b:c");
    const legacy = { id: versionId("soul", subjectId, 1n), subjectType: "soul", subjectId,
      agentId: "", key: '["a","b:c"]', version: 1n, kind: "create", recordHash: "other-pair" };
    store.set(legacy.id, legacy);
    const before = { id: "source", agentId: "a", key: "b:c", value: "before" };
    soulStore.set(before.id, before);
    const result = await soul(before.id).patch({ value: "after" });
    expect(result.status).toBe(500);
    expect(soulStore.get(before.id)).toEqual(before);
    expect([...store.values()]).toEqual([legacy]);
  });

  test("new Soul subject IDs distinguish colon pairs and the encoded namespace", () => {
    expect(soulSubjectId("a", "b:c")).not.toBe(soulSubjectId("a:b", "c"));
    expect(soulSubjectId("", '["a","b:c"]')).not.toBe(soulSubjectId("a", "b:c"));
  });

  test("an identity no-op update continues the same window and opens no new one", async () => {
    const id = "agent-a:role";
    soulStore.set(id, { id, agentId: "agent-a", key: "role", value: "before", createdAt: NOW });
    expect((await soul(id).put({ agentId: "agent-a", key: "role", value: "v1" })) instanceof Response).toBe(false);
    expect((await soul(id).patch({ value: "v2" })) instanceof Response).toBe(false);
    const versions = [...store.values()];
    expect(new Set(versions.map((v) => v.subjectId))).toEqual(new Set(["agent-a:role"]));
    expect(versions.map((v) => v.kind)).toEqual(["update", "update"]);
    expect(versions.some((v) => v.kind === "delete")).toBe(false);
    expect(versions.map((v) => Number(v.version))).toEqual([1, 2]);
  });
});
