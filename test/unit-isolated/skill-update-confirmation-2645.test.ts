import { beforeEach, expect, mock, test } from "bun:test";

type Row = Record<string, any>;
const versions = new Map<string, Row>();
const memories = new Map<string, Row>();
let locked = false;
let grantHeld = true;
let dropCloses = false;
let revokeOnRetry = false;
let closeWrites = 0;
let confirmationRead = false;
let failDeleteCommit = false;
let losePredecessor = false;
let activeTransaction: any;
const primaryStore = {
  tryLock: () => { if (locked) return false; locked = true; return true; },
  unlock: () => { locked = false; },
  resetReadTxn() {},
};
const rawVersions = {
  async delete(id: string, ctx: any) { ctx.transaction.versions.delete(id); return true; },
  async get(id: string, ctx: any) {
    expect(locked).toBe(true);
    expect(activeTransaction).toBeUndefined();
    expect(ctx.transaction).toBeUndefined();
    confirmationRead = true;
    return versions.get(id) ?? null;
  },
};
const versionTable = Object.assign(Object.create(rawVersions), {
  primaryStore,
  async *search(query: any, ctx?: any) {
    const rows: Row[] = [...(ctx?.transaction?.versions ?? versions).values()];
    rows.sort((a, b) => Number(b.version) - Number(a.version));
    for (const row of rows.filter((r) => query.conditions.every((c: any) => r[c.attribute] === c.value)).slice(0, query.limit)) yield row;
  },
  async create(row: Row, ctx: any) { ctx.transaction.versions.set(row.id, { ...row }); },
});
const memoryTable = {
  async get(id: string, ctx?: any) { return (ctx?.transaction?.memories ?? memories).get(id) ?? null; },
  async put(row: Row, ctx: any) {
    if (row.id === "predecessor" && row.validTo) {
      closeWrites++;
      if (revokeOnRetry && closeWrites === 2) grantHeld = false;
      ctx.transaction.dropPredecessorClose = dropCloses && (closeWrites === 1 || !revokeOnRetry);
    }
    ctx.transaction.memories.set(row.id, { ...row });
    return true;
  },
  async delete(id: string, ctx: any) { return ctx.transaction.memories.delete(id); },
  async *search(query: any, ctx?: any) {
    for (const row of (ctx?.transaction?.memories ?? memories).values()) {
      if (query.conditions.every((c: any) => row[c.attribute] === c.value)) yield { ...row };
    }
  },
};
const grantTable = {
  async *search() { if (grantHeld) yield { ownerId: "owner", granteeId: "writer", scope: "write" }; },
};
mock.module("harper", () => ({
  Resource: class {}, server: { http() {}, getUser: async () => null },
  databases: { flair: {
    Memory: memoryTable, InstructionVersion: versionTable, MemoryGrant: grantTable,
    Agent: { get: async () => null },
  } },
}));

const { removeAppendedVersion, recordDigest } = await import("../../resources/instruction-version-record.ts");
const { runSkillVersionWrite, defaultSkillHooks, authorizeSkillOwners } = await import("../../resources/skill-version-write.ts");

beforeEach(() => {
  versions.clear(); memories.clear(); locked = false; grantHeld = true;
  dropCloses = false; revokeOnRetry = false; closeWrites = 0; confirmationRead = false; failDeleteCommit = false;
  activeTransaction = undefined; losePredecessor = false;
  (globalThis as any).transaction = async (ctx: any, cb: (txn: any) => Promise<any>) => {
    const txn: any = { open: 1, saveCommits: false, versions: new Map(versions), memories: new Map(memories) };
    ctx.transaction = txn;
    activeTransaction = txn;
    try {
      const result = await cb(txn);
      txn.open = 0;
      if (!failDeleteCommit) { versions.clear(); for (const [id, row] of txn.versions) versions.set(id, row); }
      if (txn.dropPredecessorClose) txn.memories.set("predecessor", memories.get("predecessor"));
      memories.clear(); for (const [id, row] of txn.memories) memories.set(id, row);
      if (losePredecessor) memories.delete("predecessor");
      return result;
    } finally {
      activeTransaction = undefined;
    }
  };
});

function seedVersion(): void {
  const row: Row = {
    id: "v1", subjectType: "skill", subjectId: "subject", agentId: "owner", version: 1n,
    kind: "create", rowId: "predecessor", actorKind: "agent", sourceClass: "agent",
    createdAt: "2020-01-01T00:00:00.000Z", guarded: false,
  };
  row.recordHash = recordDigest(row);
  versions.set(row.id, row);
}

test("version rollback confirms absence after commit with the version lock held", async () => {
  seedVersion();
  expect(await removeAppendedVersion({}, "skill", "subject", "v1")).toBe("removed");
  expect(confirmationRead).toBe(true);
  expect(versions.size).toBe(0);
  expect(locked).toBe(false);
});

test("a delete that does not commit is unconfirmed compensation", async () => {
  seedVersion();
  failDeleteCommit = true;
  expect(await removeAppendedVersion({}, "skill", "subject", "v1")).toBe("unavailable");
  expect(confirmationRead).toBe(true);
  expect(versions.has("v1")).toBe(true);
});

test("a grant revoked after the retry stages its close aborts that close and rolls back the successor", async () => {
  const predecessor = { id: "predecessor", agentId: "owner", content: "v1", tags: ["skill"], visibility: "shared", durability: "persistent", skillSubjectId: "subject", createdAt: "2020-01-01T00:00:00.000Z" };
  const successor = { ...predecessor, id: "successor", content: "v2", instanceToken: "successor-token" };
  memories.set(predecessor.id, predecessor);
  dropCloses = true;
  revokeOnRetry = true;
  const ctx = { request: { tpsAgent: "writer", tpsAgentIsAdmin: false, headers: new Headers({ authorization: "TPS-Ed25519 a1:1:n:s" }) } };
  const auth = { kind: "agent" as const, agentId: "writer", isAdmin: false };
  const result = await runSkillVersionWrite({
    ctx, subjectId: "subject", agentId: "writer", head: async () => predecessor,
    plan: () => ({ kind: "update", predecessor, successor, closePatch: { validTo: "closed" }, value: "v2", visibility: "shared", grantedClose: { granteeId: "writer", ownerId: "owner" } }),
    hooks: { ...defaultSkillHooks, authorizeClose: (row, shared) => authorizeSkillOwners(ctx, auth, [row], shared) },
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.response.status).toBe(409);
  expect((await result.response.json()).error).toBe("granted_close_revoked");
  expect(closeWrites).toBe(2);
  expect(memories.get("predecessor")?.validTo).toBeUndefined();
  expect(memories.has("successor")).toBe(false);
  expect(versions.size).toBe(0);
  expect(confirmationRead).toBe(true);
});

test("a predecessor removed before confirmation refuses and rolls back the successor", async () => {
  const predecessor = { id: "predecessor", agentId: "writer", content: "v1", tags: ["skill"], visibility: "shared", durability: "persistent", skillSubjectId: "subject", createdAt: "2020-01-01T00:00:00.000Z" };
  const successor = { ...predecessor, id: "successor", content: "v2", instanceToken: "successor-token" };
  memories.set(predecessor.id, predecessor);
  losePredecessor = true;
  const result = await runSkillVersionWrite({
    ctx: { request: { tpsAgent: "writer", tpsAgentIsAdmin: false, headers: new Headers({ authorization: "TPS-Ed25519 a1:1:n:s" }) } }, subjectId: "subject", agentId: "writer", head: async () => predecessor,
    plan: () => ({ kind: "update", predecessor, successor, closePatch: { validTo: "closed" }, value: "v2", visibility: "shared", grantedClose: null }),
    hooks: { ...defaultSkillHooks, authorizeClose: async () => null },
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.response.status).toBe(409);
  expect((await result.response.json()).error).toBe("stored_row_changed");
  expect(memories.has("successor")).toBe(false);
  expect(versions.size).toBe(0);
});
