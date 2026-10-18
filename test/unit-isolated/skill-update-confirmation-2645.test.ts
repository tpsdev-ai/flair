import { beforeEach, expect, mock, test } from "bun:test";

type Row = Record<string, any>;
const versions = new Map<string, Row>();
const memories = new Map<string, Row>();
const pointers = new Map<string, Row>();
let removedPointer: any = null;
let dropPointerRestore = false;
let pointerConfirmationRead = false;
let failPointerConfirmation = false;
let replacementPointer: Row | undefined;
let replaceAtRestore = false;
const originalPointer = {
  memoryId: "predecessor", hostSource: JSON.stringify({ v: 1, host: "openclaw", kind: "run", id: "round6" }),
  scopeAtWrite: "shared", authorId: "writer", memoryInstanceToken: "predecessor-token", receivedAt: "2020-01-01T00:00:00.000Z",
};
let locked = false;
let grantHeld = true;
let dropCloses = false;
let revokeOnRetry = false;
let closeWrites = 0;
let confirmationRead = false;
let failDeleteCommit = false;
let losePredecessor = false;
let closeSuccessorOnRead: "committed" | "transaction" | undefined;
let failSuccessorConfirmation = false;
let failRetryWrite = false;
let failVersionConfirmation = false;
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
    if (failVersionConfirmation) throw new Error("version confirmation unavailable");
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
  async get(id: string, ctx?: any) {
    const rows = ctx?.transaction?.memories ?? memories;
    if (id === "successor" && confirmationRead) {
      expect(locked).toBe(true);
      if (closeSuccessorOnRead === (ctx?.transaction ? "transaction" : "committed")) {
        rows.set(id, { ...rows.get(id), validTo: "later-close" });
        memories.set(id, { ...memories.get(id), validTo: "later-close" });
        closeSuccessorOnRead = undefined;
      }
      if (failSuccessorConfirmation && !ctx?.transaction && !rows.has(id)) throw new Error("successor confirmation unavailable");
    }
    return rows.get(id) ?? null;
  },
  async put(row: Row, ctx: any) {
    if (row.id === "predecessor" && row.validTo) {
      closeWrites++;
      if (failRetryWrite && closeWrites > 1) throw new Error("retry write failed");
      if (revokeOnRetry && closeWrites === 2) grantHeld = false;
      ctx.transaction.dropPredecessorClose = dropCloses && (closeWrites === 1 || !revokeOnRetry);
    }
    ctx.transaction.memories.set(row.id, { ...row });
    return true;
  },
  async delete(id: string, ctx: any) { expect(locked).toBe(true); return ctx.transaction.memories.delete(id); },
  async *search(query: any, ctx?: any) {
    for (const row of (ctx?.transaction?.memories ?? memories).values()) {
      if (query.conditions.every((c: any) => row[c.attribute] === c.value)) yield { ...row };
    }
  },
};
const pointerTable = {
  primaryStore: {},
  async *search(_query: any, ctx?: any) {
    if (confirmationRead && !ctx?.transaction) {
      expect(locked).toBe(true);
      expect(activeTransaction).toBeUndefined();
      if (failPointerConfirmation) throw new Error("pointer confirmation unavailable");
      if (pointers.has("predecessor")) pointerConfirmationRead = true;
    }
    for (const row of (ctx?.transaction?.pointers ?? pointers).values()) yield { ...row };
  },
  async put(row: Row, ctx: any) {
    expect(locked).toBe(true);
    ctx.transaction.pointers.set(row.memoryId, { ...row });
    if (replaceAtRestore && replacementPointer) pointers.set(row.memoryId, replacementPointer);
  },
};
const grantTable = {
  async *search() { if (grantHeld) yield { ownerId: "owner", granteeId: "writer", scope: "write" }; },
};
mock.module("harper", () => ({
  Resource: class {}, server: { http() {}, getUser: async () => null },
  databases: { flair: {
    Memory: memoryTable, MemoryHostSource: pointerTable, InstructionVersion: versionTable, MemoryGrant: grantTable,
    Agent: { get: async () => null },
  } },
}));

const { removeAppendedVersion, recordDigest } = await import("../../resources/instruction-version-record.ts");
const { confirmSkillClose, runSkillVersionWrite, defaultSkillHooks, authorizeSkillOwners } = await import("../../resources/skill-version-write.ts");

beforeEach(() => {
  pointers.clear(); removedPointer = null; dropPointerRestore = false; pointerConfirmationRead = false;
  failPointerConfirmation = false; replacementPointer = undefined; replaceAtRestore = false;
  versions.clear(); memories.clear(); locked = false; grantHeld = true;
  dropCloses = false; revokeOnRetry = false; closeWrites = 0; confirmationRead = false; failDeleteCommit = false;
  activeTransaction = undefined; losePredecessor = false; closeSuccessorOnRead = undefined;
  failSuccessorConfirmation = false; failRetryWrite = false; failVersionConfirmation = false;
  (globalThis as any).transaction = async (ctx: any, cb: (txn: any) => Promise<any>) => {
    const writes: any[] = [];
    const txn: any = { open: 1, saveCommits: false, versions: new Map(versions), memories: new Map(memories), pointers: new Map(pointers), addWrite: (write: any) => writes.push(write) };
    ctx.transaction = txn;
    activeTransaction = txn;
    try {
      const result = await cb(txn);
      for (const write of writes) write.commit(0, pointers.has(write.key) ? { value: pointers.get(write.key) } : null);
      txn.open = 0;
      if (!dropPointerRestore || writes.length === 0) {
        pointers.clear(); for (const [id, row] of txn.pointers) pointers.set(id, row);
      }
      if (removedPointer && replacementPointer && !replaceAtRestore && writes.length === 0) pointers.set("predecessor", replacementPointer);
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

test("a missing predecessor without caller handling refuses and compensates", async () => {
  const compensate = mock(async () => null);
  const authorize = mock(async () => null);
  const result = await confirmSkillClose({
    ctx: {}, table: memoryTable, expected: { id: "predecessor" },
    closePatch: { validTo: "closed" }, authorize, compensate,
    refusal: () => Response.json({ error: "close_not_confirmed" }, { status: 409 }),
    unconfirmed: () => Response.json({ error: "confirmation_unavailable" }, { status: 500 }),
  });
  expect(result).toBeInstanceOf(Response);
  if (!result) throw new Error("expected refusal");
  expect(result.status).toBe(409);
  expect((await result.json()).error).toBe("stored_row_changed");
  expect(compensate).toHaveBeenCalledTimes(1);
  expect(authorize).not.toHaveBeenCalled();
});

test("a missing predecessor without a missing decision refuses when confirmEffect would return null and runs compensation", async () => {
  const compensate = mock(async () => null);
  const confirmEffect = mock(async () => null);
  const result = await confirmSkillClose({
    ctx: {}, table: memoryTable, expected: { id: "predecessor" },
    closePatch: { validTo: "closed" }, authorize: async () => null, compensate, confirmEffect,
    refusal: () => Response.json({ error: "close_not_confirmed" }, { status: 409 }),
    unconfirmed: () => Response.json({ error: "confirmation_unavailable" }, { status: 500 }),
  });
  expect(result).toBeInstanceOf(Response);
  if (!result) throw new Error("expected refusal");
  expect(result.status).toBe(409);
  expect((await result.json()).error).toBe("stored_row_changed");
  expect(compensate).toHaveBeenCalledTimes(1);
  expect(confirmEffect).not.toHaveBeenCalled();
});

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

async function unlandedUpdate() {
  const predecessor = { id: "predecessor", agentId: "writer", content: "v1", tags: ["skill"], visibility: "shared", durability: "persistent", skillSubjectId: "subject", createdAt: "2020-01-01T00:00:00.000Z" };
  const successor = { ...predecessor, id: "successor", content: "v2", instanceToken: "successor-token" };
  memories.set(predecessor.id, predecessor);
  dropCloses = true;
  return runSkillVersionWrite({
    ctx: { request: { tpsAgent: "writer", tpsAgentIsAdmin: false, headers: new Headers({ authorization: "TPS-Ed25519 a1:1:n:s" }) } },
    subjectId: "subject", agentId: "writer", head: async () => predecessor,
    plan: () => ({ kind: "update", predecessor, successor, closePatch: { validTo: "closed" }, value: "v2", visibility: "shared", grantedClose: null }),
    hooks: {
      ...defaultSkillHooks, authorizeClose: async () => null,
      removedPointer: () => removedPointer,
      pointer: async (shared) => {
        removedPointer = shared.transaction.pointers.get("predecessor") ?? null;
        shared.transaction.pointers.delete("predecessor");
        return null;
      },
    },
  });
}

for (const read of ["committed", "transaction"] as const) {
  test(`compensation preserves a successor closed before its ${read} identity check`, async () => {
    closeSuccessorOnRead = read;
    const result = await unlandedUpdate();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.response.status).toBe(500);
    expect((await result.response.json()).error).toBe("skill_update_compensation_failed");
    expect(memories.has("successor")).toBe(true);
    expect(memories.get("successor")?.validTo).toBe("later-close");
  });
}

test("compensation confirms successor absence after commit under the version lock", async () => {
  const result = await unlandedUpdate();
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.response.status).toBe(409);
  expect((await result.response.json()).error).toBe("skill_update_not_closed");
  expect(memories.has("successor")).toBe(false);
  expect(versions.size).toBe(0);
  expect(locked).toBe(false);
});

test("a failed retry write reports uncertain confirmation", async () => {
  failRetryWrite = true;
  const result = await unlandedUpdate();
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.response.status).toBe(500);
  expect(await result.response.json()).toEqual({ error: "skill_update_unconfirmed", message: "the skill update could not be confirmed" });
});

for (const failure of ["version", "successor"] as const) {
  test(`a failed ${failure} confirmation read reports unconfirmed undo`, async () => {
    failVersionConfirmation = failure === "version";
    failSuccessorConfirmation = failure === "successor";
    const result = await unlandedUpdate();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.response.status).toBe(500);
    expect(await result.response.json()).toEqual({ error: "skill_update_compensation_failed", message: "the undo of a close that did not land could not be confirmed" });
  });
}

test("exhausted update restores the exact removed pointer and confirms it after commit under the version lock", async () => {
  pointers.set("predecessor", originalPointer);
  const result = await unlandedUpdate();
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.response.status).toBe(409);
  expect((await result.response.json()).error).toBe("skill_update_not_closed");
  expect(pointers.get("predecessor")).toEqual(originalPointer);
  expect(pointerConfirmationRead).toBe(true);
  expect(memories.has("successor")).toBe(false);
  expect(versions.size).toBe(0);
});

for (const failure of ["commit", "read"] as const) {
  test(`unconfirmed pointer restoration after a failed ${failure} reports unconfirmed undo`, async () => {
    pointers.set("predecessor", originalPointer);
    dropPointerRestore = failure === "commit";
    failPointerConfirmation = failure === "read";
    const result = await unlandedUpdate();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.response.status).toBe(500);
    expect(await result.response.json()).toEqual({ error: "skill_update_compensation_failed", message: "the undo of a close that did not land could not be confirmed" });
  });
}

for (const timing of ["before", "during"] as const) {
  test(`compensation preserves and reports a later pointer set ${timing} restoration`, async () => {
    pointers.set("predecessor", originalPointer);
    replacementPointer = { ...originalPointer, hostSource: "later-pointer", receivedAt: "2021-01-01T00:00:00.000Z" };
    replaceAtRestore = timing === "during";
    const result = await unlandedUpdate();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.response.status).toBe(500);
    expect(await result.response.json()).toEqual({ error: "skill_update_compensation_failed", message: "the undo of a close that did not land could not be confirmed; a different host-pointer row was left in place" });
    expect(pointers.get("predecessor")).toEqual(replacementPointer);
    expect(pointerConfirmationRead).toBe(true);
  });
}
