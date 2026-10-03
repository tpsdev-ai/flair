// ─── flair#2139 S2 — the transactional skill version writer ─────────────────
//
// resources/skill-version-write.ts runs one skill write atomically inside the
// append helper's per-subject lock and ONE owned transaction: re-read the live
// Memory head, build the successor, close the predecessor, pointer writes, and
// append the version. This file drives it against a mocked Harper (the same
// technique test/unit-isolated/instruction-version-record.test.ts uses) and
// injects a failure at each step, asserting NO successor, NO close and NO
// version row survive.
import { describe, expect, test, beforeEach, mock } from "bun:test";

type Row = Record<string, any>;
const store = new Map<string, Row>();       // InstructionVersion rows
const memoryStore = new Map<string, Row>(); // Memory rows
const locks = new Set<string>();
let failNextAppend = false;
let hideHead = false;

const primaryStore = {
  tryLock: (key: unknown) => { const k = JSON.stringify(key); if (locks.has(k)) return false; locks.add(k); return true; },
  unlock: (key: unknown) => { locks.delete(JSON.stringify(key)); },
  resetReadTxn: () => {},
};

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
  async create(record: Row, ctx: any): Promise<void> {
    if (failNextAppend) { failNextAppend = false; throw new Error("append-write-failed"); }
    const rows = ctx?.transaction?.versions ?? store;
    if (rows.has(record.id)) throw new Error("Record already exists");
    rows.set(record.id, { ...record });
  },
};

const MemoryTable = {
  async *search(query: any, ctx?: any): AsyncGenerator<Row> {
    const conds: any[] = query?.conditions ?? [];
    for (const row of [...(ctx?.transaction?.memories ?? memoryStore).values()]) {
      if (conds.every((c) => row[c.attribute] === c.value)) yield { ...row };
    }
  },
  async get(id: string, ctx?: any) { return (ctx?.transaction?.memories ?? memoryStore).get(id) ?? null; },
};

mock.module("harper", () => ({
  Resource: class {}, server: { http() {}, getUser: async () => null },
  databases: {
    flair: {
      InstructionVersion: InstructionVersionTable,
      Memory: MemoryTable,
      MemoryCandidate: { async *search() {} },
      Soul: { async *search() {} },
      Instance: { async *search() {} },
      Agent: { get: async () => null, search: async () => [] },
    },
  },
}));

function mockTransaction(ctx: any, cb: (txn: any) => any): any {
  const context = ctx && typeof ctx === "object" ? ctx : {};
  if (context.transaction && context.transaction.open === 1) return cb(context.transaction);
  const txn: any = {
    open: 1, saveCommits: false, aborted: false,
    versions: new Map(store), memories: new Map(memoryStore),
    abort() { this.open = 0; this.aborted = true; },
    commit() {
      this.open = 0;
      store.clear(); for (const [id, row] of this.versions) store.set(id, row);
      memoryStore.clear(); for (const [id, row] of this.memories) memoryStore.set(id, row);
    },
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

const { runSkillVersionWrite, resolveSkillHead } = await import("../../resources/skill-version-write.ts");
const { recordDigest, valueDigest } = await import("../../resources/instruction-version-record.ts");
const { deriveSkillSubjectId } = await import("../../resources/skill-subject.ts");

const agentCtx = () => ({ request: { tpsAgent: "agent-a", tpsAgentIsAdmin: false, headers: new Headers({ authorization: "TPS-Ed25519 a1:1:n:s" }) } });
const operatorCtx = () => ({ request: { tpsAgent: "admin", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "Basic ok" }) } });

function failHook<T>(message: string): () => Promise<T> {
  return async () => { throw new Error(message); };
}

beforeEach(() => {
  store.clear(); memoryStore.clear(); locks.clear();
  failNextAppend = false; hideHead = false;
  (globalThis as any).transaction = mockTransaction;
});

/** The successor/close hooks write into the shared transaction's Memory map. */
const createSuccessor = async (successor: Row, shared: any) => {
  shared.transaction.memories.set(successor.id, { ...successor });
  return successor.id;
};
const closePredecessor = async (predecessor: Row, patch: Record<string, unknown>, shared: any) => {
  const rows = shared.transaction.memories;
  const existing = rows.get(predecessor.id);
  if (!existing) throw new Error(`close: ${predecessor.id} not found`);
  rows.set(predecessor.id, { ...existing, ...patch });
};

function liveSkill(id: string, subjectId: string | null, content: string, visibility = "shared"): Row {
  return { id, agentId: "agent-a", tags: ["skill"], trigger: "t", content, visibility, durability: "persistent", createdAt: "2020-01-01T00:00:00.000Z", ...(subjectId ? { skillSubjectId: subjectId } : {}) };
}

describe("flair#2139 S2 — skill version write: create", () => {
  test("a first create appends a create version referencing the successor", async () => {
    const successor = liveSkill("m1", null, "c1");
    successor.skillSubjectId = "m1";
    const res = await runSkillVersionWrite({
      ctx: agentCtx(), subjectId: "m1", agentId: "agent-a",
      head: (shared) => resolveSkillHead("m1", null, shared),
      plan: () => ({ kind: "create", predecessor: null, successor, closePatch: {}, value: "c1", visibility: "shared" }),
      hooks: { createSuccessor, closePredecessor },
    });
    expect(res.ok).toBe(true);
    const v = store.get("skill:m1:1")!;
    expect(v.subjectType).toBe("skill");
    expect(v.subjectId).toBe("m1");
    expect(v.kind).toBe("create");
    expect(v.memoryId).toBe("m1");
    expect(v.rowId).toBe("m1");
    expect(v.valueHash).toBe(valueDigest("c1"));
    expect(v.soulSnapshot).toBeNull();
    expect(v.actorKind).toBe("agent");
    expect(v.actorId).toBe("agent-a");
    expect(v.sourceClass).toBe("agent");
    expect(memoryStore.has("m1")).toBe(true);
  });

  test("an operator (Basic admin) is attributed as operator with the operator's id", async () => {
    const successor = liveSkill("m1", "m1", "c1");
    await runSkillVersionWrite({
      ctx: operatorCtx(), subjectId: "m1", agentId: "agent-a",
      head: (shared) => resolveSkillHead("m1", null, shared),
      plan: () => ({ kind: "create", predecessor: null, successor, closePatch: {}, value: "c1", visibility: "shared" }),
      hooks: { createSuccessor, closePredecessor },
    });
    const v = store.get("skill:m1:1")!;
    expect(v.actorKind).toBe("operator");
    expect(v.actorId).toBe("admin");
    expect(v.sourceClass).toBe("operator");
    expect(v.agentId, "the subject owner is distinct from the actor").toBe("agent-a");
  });
});

describe("flair#2139 S2 — skill version write: supersede and delete", () => {
  test("an update creates a successor, closes the predecessor, and chains the version", async () => {
    memoryStore.set("m1", liveSkill("m1", "m1", "c1"));
    const successor = { ...liveSkill("m2", "m1", "c2"), supersedes: "m1", createdAt: "2020-01-02T00:00:00.000Z" };
    const res = await runSkillVersionWrite({
      ctx: agentCtx(), subjectId: "m1", agentId: "agent-a",
      head: (shared) => resolveSkillHead("m1", null, shared),
      plan: (head) => {
        expect(head?.id).toBe("m1");
        return { kind: "update", predecessor: head, successor, closePatch: { validTo: "2020-01-02T00:00:00.000Z" }, value: "c2", visibility: "shared" };
      },
      hooks: { createSuccessor, closePredecessor },
    });
    expect(res.ok).toBe(true);
    const v = store.get("skill:m1:1")!;
    expect(v.kind).toBe("update");
    expect(v.memoryId).toBe("m2");
    expect(memoryStore.get("m1")!.validTo).toBe("2020-01-02T00:00:00.000Z");
    expect(memoryStore.get("m2")!.supersedes).toBe("m1");
    expect(memoryStore.get("m2")!.skillSubjectId).toBe("m1");
  });

  test("a logical delete closes the head and appends a tombstone with no payload", async () => {
    memoryStore.set("m1", liveSkill("m1", "m1", "c1"));
    const res = await runSkillVersionWrite({
      ctx: agentCtx(), subjectId: "m1", agentId: "agent-a",
      head: (shared) => resolveSkillHead("m1", null, shared),
      plan: (head) => ({ kind: "delete", predecessor: head!, closePatch: { validTo: "2020-01-09T00:00:00.000Z" }, value: null, visibility: "shared" }),
      hooks: { createSuccessor, closePredecessor },
    });
    expect(res.ok).toBe(true);
    const v = store.get("skill:m1:1")!;
    expect(v.kind).toBe("delete");
    expect(v.memoryId ?? null).toBeNull();
    expect(v.valueHash).toBeNull();
    expect(memoryStore.get("m1")!.validTo).toBe("2020-01-09T00:00:00.000Z");
  });

  test("the subject id a successor carries is the predecessor's established subject", () => {
    // An unenrolled predecessor adopts its own id as the subject.
    const subject = deriveSkillSubjectId({ newPhysicalId: "m2", predecessor: { id: "m1" } });
    expect(subject).toBe("m1");
  });
});

describe("flair#2139 S2 — skill version write atomicity", () => {
  async function attemptUpdate(overrides: any = {}) {
    memoryStore.set("m1", liveSkill("m1", "m1", "c1"));
    const successor = { ...liveSkill("m2", "m1", "c2"), supersedes: "m1", createdAt: "2020-01-02T00:00:00.000Z" };
    return runSkillVersionWrite({
      ctx: agentCtx(), subjectId: "m1", agentId: "agent-a",
      head: (shared) => resolveSkillHead("m1", null, shared),
      plan: () => ({ kind: "update", predecessor: memoryStore.get("m1") ?? null, successor, closePatch: { validTo: "2020-01-02T00:00:00.000Z" }, value: "c2", visibility: "shared" }),
      hooks: { createSuccessor, closePredecessor, ...overrides },
    });
  }

  test("a successor-write failure leaves NO successor, NO close and NO version", async () => {
    const res = await attemptUpdate({ createSuccessor: failHook("successor-write-failed") });
    expect(res.ok).toBe(false);
    expect(memoryStore.get("m1")!.validTo).toBeUndefined();
    expect(memoryStore.has("m2")).toBe(false);
    expect(store.size).toBe(0);
  });

  test("a predecessor-close failure rolls the successor back and appends NO version", async () => {
    const res = await attemptUpdate({ closePredecessor: failHook("close-failed") });
    expect(res.ok).toBe(false);
    expect(memoryStore.get("m1")!.validTo).toBeUndefined();
    expect(memoryStore.has("m2")).toBe(false);
    expect(store.size).toBe(0);
  });

  test("a version-append failure rolls back the successor and the close", async () => {
    failNextAppend = true;
    const res = await attemptUpdate();
    expect(res.ok).toBe(false);
    expect(memoryStore.get("m1")!.validTo).toBeUndefined();
    expect(memoryStore.has("m2")).toBe(false);
    expect(store.size).toBe(0);
  });

  test("a duplicate version id rolls the whole write back", async () => {
    memoryStore.set("m1", liveSkill("m1", "m1", "c1"));
    // Hide the head so the next append is allocated the already-occupied sequence.
    store.set("skill:m1:1", { id: "skill:m1:1", version: 1n, recordHash: "x", subjectType: "skill", subjectId: "m1", kind: "create" });
    hideHead = true;
    const successor = { ...liveSkill("m2", "m1", "c2"), supersedes: "m1", createdAt: "2020-01-02T00:00:00.000Z" };
    const res = await runSkillVersionWrite({
      ctx: agentCtx(), subjectId: "m1", agentId: "agent-a",
      head: (shared) => resolveSkillHead("m1", null, shared),
      plan: () => ({ kind: "update", predecessor: memoryStore.get("m1") ?? null, successor, closePatch: { validTo: "2020-01-02T00:00:00.000Z" }, value: "c2", visibility: "shared" }),
      hooks: { createSuccessor, closePredecessor },
    });
    expect(res.ok).toBe(false);
    expect(store.size).toBe(1);
    expect(store.get("skill:m1:1")!.recordHash).toBe("x");
    expect(memoryStore.get("m1")!.validTo).toBeUndefined();
    expect(memoryStore.has("m2")).toBe(false);
  });

  test("the appended record digest chains to the predecessor digest", async () => {
    memoryStore.set("m1", liveSkill("m1", "m1", "c1"));
    const s2 = { ...liveSkill("m2", "m1", "c2"), supersedes: "m1", createdAt: "2020-01-02T00:00:00.000Z" };
    await runSkillVersionWrite({
      ctx: agentCtx(), subjectId: "m1", agentId: "agent-a",
      head: (shared) => resolveSkillHead("m1", null, shared),
      plan: () => ({ kind: "create", predecessor: null, successor: s2, closePatch: {}, value: "c2", visibility: "shared" }),
      hooks: { createSuccessor, closePredecessor },
    });
    const s3 = { ...liveSkill("m3", "m1", "c3"), supersedes: "m2", createdAt: "2020-01-03T00:00:00.000Z" };
    await runSkillVersionWrite({
      ctx: agentCtx(), subjectId: "m1", agentId: "agent-a",
      head: (shared) => resolveSkillHead("m1", null, shared),
      plan: (head) => ({ kind: "update", predecessor: head, successor: s3, closePatch: { validTo: "2020-01-03T00:00:00.000Z" }, value: "c3", visibility: "shared" }),
      hooks: { createSuccessor, closePredecessor },
    });
    const v1 = store.get("skill:m1:1")!;
    const v2 = store.get("skill:m1:2")!;
    expect(v2.previousVersionHash).toBe(v1.recordHash);
    for (const v of [v1, v2]) expect(v.recordHash).toBe(recordDigest(v));
  });
});
