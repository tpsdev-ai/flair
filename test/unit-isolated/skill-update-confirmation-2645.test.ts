import { journalMap } from "../helpers/journal-map.ts";
import { beforeEach, expect, mock, spyOn, test } from "bun:test";

type Row = Record<string, any>;
const versions = new Map<string, Row>();
const memories = new Map<string, Row>();
const pointers = new Map<string, Row>();
let capturedDeletedPointer: any = null;
let successorPointer: Row | undefined;
let laterSuccessorPointer: Row | undefined;
let extraHook: ((ctx: any) => Promise<void>) | undefined;
let capturedJournal: any;
let successorVersion = 1;
let replaceSuccessorVersion = false;
const stagedOperations: any[] = [];
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
let supersedeOnSuccessorConfirmation = false;
let activeTransaction: any;
const primaryStore = {
  tryLock: () => { if (locked) return false; locked = true; return true; },
  unlock: () => { locked = false; },
  resetReadTxn() {},
  getEntry(id: string) { return versions.has(id) ? { value: versions.get(id), version: 1 } : null; },
};
const rawVersions = {
  async delete(id: string, ctx: any) { ctx.transaction.versions.delete(id); return true; },
  async get(id: string, ctx: any) {
    if (ctx?.transaction) return ctx.transaction.versions.get(id) ?? null;
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
  primaryStore: { getEntry(id: string) { return memories.has(id) ? { value: memories.get(id), version: id === "successor" ? successorVersion : 1 } : null; } },
  async get(id: string, ctx?: any) {
    const rows = ctx?.transaction?.memories ?? memories;
    if (id === "successor" && !ctx?.transaction && supersedeOnSuccessorConfirmation) {
      // A later update completed after this request's commit: it closed this
      // request's successor and appended the next version in the chain.
      const appended = versions.get("skill:subject:2");
      if (appended) {
        const following: Row = {
          id: "skill:subject:3", subjectType: "skill", subjectId: "subject", agentId: "writer",
          version: 3n, kind: "update", rowId: "later", memoryId: "later",
          previousVersionHash: appended.recordHash, recordHash: "hash-3",
          createdAt: "2020-01-01T00:00:01.000Z", guarded: false,
        };
        versions.set(following.id, following);
        memories.set("later", { id: "later", agentId: "writer", content: "v3", tags: ["skill"],
          visibility: "shared", durability: "persistent", skillSubjectId: "subject",
          supersedes: "successor", createdAt: "2020-01-01T00:00:01.000Z" });
        memories.set(id, { ...memories.get(id), validTo: "later-close" });
        return { ...memories.get(id) };
      }
    }
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
  primaryStore: { getEntry(id: string) { return pointers.has(id) ? { value: pointers.get(id), version: 1 } : null; } },
  async get(id: string, ctx?: any) { return (ctx?.transaction?.pointers ?? pointers).get(id) ?? null; },
  async delete(id: string, ctx: any) { return ctx.transaction.pointers.delete(id); },
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
    if (confirmationRead && replaceAtRestore && replacementPointer) pointers.set(row.memoryId, replacementPointer);
  },
};
Object.setPrototypeOf(memoryTable, { get: memoryTable.get, put: memoryTable.put, delete: memoryTable.delete });
Object.setPrototypeOf(pointerTable, { get: pointerTable.get, put: pointerTable.put, delete: pointerTable.delete });
(rawVersions as any).put = async (row: Row, ctx: any) => { ctx.transaction.versions.set(row.id, row); };
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

const { WriteJournal, currentWriteJournal } = await import("../../resources/write-journal.ts");
const { removeAppendedVersion, recordDigest } = await import("../../resources/instruction-version-record.ts");
const { confirmSkillClose, runSkillVersionWrite, defaultSkillHooks, authorizeSkillOwners } = await import("../../resources/skill-version-write.ts");

beforeEach(() => {
  successorVersion = 1; replaceSuccessorVersion = false;
  stagedOperations.length = 0; capturedJournal = undefined; extraHook = undefined;
  successorPointer = undefined; laterSuccessorPointer = undefined;
  pointers.clear(); capturedDeletedPointer = null; dropPointerRestore = false; pointerConfirmationRead = false;
  failPointerConfirmation = false; replacementPointer = undefined; replaceAtRestore = false;
  versions.clear(); memories.clear(); locked = false; grantHeld = true;
  dropCloses = false; revokeOnRetry = false; closeWrites = 0; confirmationRead = false; failDeleteCommit = false;
  activeTransaction = undefined; losePredecessor = false; closeSuccessorOnRead = undefined;
  failSuccessorConfirmation = false; failRetryWrite = false; failVersionConfirmation = false;
  supersedeOnSuccessorConfirmation = false;
  (globalThis as any).transaction = async (ctx: any, cb: (txn: any) => Promise<any>) => {
    const writes: any[] = [];
    const txn: any = { open: 1, saveCommits: false, versions: new Map(versions), memories: new Map(memories), pointers: new Map(pointers), addWrite: (write: any) => { const prior = [...writes].reverse().find((value) => value.store === write.store && value.key === write.key); if (prior) write.priorWrite = prior; writes.push(write); if (currentWriteJournal()) stagedOperations.push(write); write.commit(1, write.entry === undefined ? write.store.getEntry(write.key) : write.entry); return write; } };
    txn.versions = journalMap(versions, primaryStore, txn);
    txn.memories = journalMap(memories, memoryTable.primaryStore, txn);
    txn.pointers = journalMap(pointers, pointerTable.primaryStore, txn);
    ctx.transaction = txn;
    activeTransaction = txn;
    try {
      const result = await cb(txn);
      for (const write of writes) {
        if (!write.stagedEntry) write.commit(1, write.store.getEntry(write.key));
      }
      txn.open = 0;
      if (!dropPointerRestore || !txn.pointers.has("predecessor")) {
        pointers.clear(); for (const [id, row] of txn.pointers) pointers.set(id, row);
      }
      if (capturedDeletedPointer && replacementPointer && !replaceAtRestore && !confirmationRead) pointers.set("predecessor", replacementPointer);
      if (!failDeleteCommit) { versions.clear(); for (const [id, row] of txn.versions) versions.set(id, row); }
      if (txn.dropPredecessorClose) Map.prototype.set.call(txn.memories, "predecessor", memories.get("predecessor"));
      memories.clear(); for (const [id, row] of txn.memories) memories.set(id, row);
      if (losePredecessor) memories.delete("predecessor");
      if (replaceSuccessorVersion && !confirmationRead) successorVersion = 2;
      if (laterSuccessorPointer && !confirmationRead) pointers.set("successor", laterSuccessorPointer);
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
  const compensate = spyOn(WriteJournal.prototype, "undo").mockResolvedValue(true);
  const authorize = mock(async () => null);
  const result = await confirmSkillClose({
    ctx: {}, table: memoryTable, expected: { id: "predecessor" },
    closePatch: { validTo: "closed" }, authorize,
    refusal: () => Response.json({ error: "close_not_confirmed" }, { status: 409 }),
    unconfirmed: () => Response.json({ error: "confirmation_unavailable" }, { status: 500 }),
  });
  expect(result).toBeInstanceOf(Response);
  if (!result) throw new Error("expected refusal");
  expect(result.status).toBe(409);
  expect((await result.json()).error).toBe("stored_row_changed");
  expect(compensate).toHaveBeenCalledTimes(1);
  expect(authorize).not.toHaveBeenCalled();
  compensate.mockRestore();
});

test("a missing predecessor without a missing decision refuses when confirmEffect would return null and runs compensation", async () => {
  const compensate = spyOn(WriteJournal.prototype, "undo").mockResolvedValue(true);
  const confirmEffect = mock(async () => null);
  const result = await confirmSkillClose({
    ctx: {}, table: memoryTable, expected: { id: "predecessor" },
    closePatch: { validTo: "closed" }, authorize: async () => null, confirmEffect,
    refusal: () => Response.json({ error: "close_not_confirmed" }, { status: 409 }),
    unconfirmed: () => Response.json({ error: "confirmation_unavailable" }, { status: 500 }),
  });
  expect(result).toBeInstanceOf(Response);
  if (!result) throw new Error("expected refusal");
  expect(result.status).toBe(409);
  expect((await result.json()).error).toBe("stored_row_changed");
  expect(compensate).toHaveBeenCalledTimes(1);
  expect(confirmEffect).not.toHaveBeenCalled();
  compensate.mockRestore();
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
  dropCloses = true;
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
      pointer: async (shared) => {
        capturedDeletedPointer = shared.transaction.pointers.get("predecessor") ?? null;
        await pointerTable.delete("predecessor", shared);
        if (successorPointer) await pointerTable.put(successorPointer, shared);
        await extraHook?.(shared);
        capturedJournal = currentWriteJournal();
        return null;
      },
    },
  });
}

test("a successor closed by the next update in the chain confirms success", async () => {
  seedVersion();
  supersedeOnSuccessorConfirmation = true;
  const predecessor = { id: "predecessor", agentId: "writer", content: "v1", tags: ["skill"], visibility: "shared", durability: "persistent", skillSubjectId: "subject", createdAt: "2020-01-01T00:00:00.000Z" };
  const successor = { ...predecessor, id: "successor", content: "v2", instanceToken: "successor-token" };
  memories.set(predecessor.id, predecessor);
  const result = await runSkillVersionWrite({
    ctx: { request: { tpsAgent: "writer", tpsAgentIsAdmin: false, headers: new Headers({ authorization: "TPS-Ed25519 a1:1:n:s" }) } },
    subjectId: "subject", agentId: "writer", head: async () => predecessor,
    plan: () => ({ kind: "update", predecessor, successor, closePatch: { validTo: "closed" }, value: "v2", visibility: "shared", grantedClose: null }),
    hooks: { ...defaultSkillHooks, authorizeClose: async () => null },
  });
  expect(result.ok, result.ok ? "" : await result.response.clone().text()).toBe(true);
  if (!result.ok) throw new Error("expected success");
  expect(result.version).toBe("skill:subject:2");
  expect(memories.get("successor")?.validTo).toBe("later-close");
  expect(memories.get("later")?.supersedes).toBe("successor");
  expect([...versions.values()].map((row) => Number(row.version))).toEqual([1, 2, 3]);
});

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

for (const existing of [false, true]) {
  test(`journal restores both pointer keys after a refused update (${existing ? "overwrite" : "create"})`, async () => {
    pointers.set("predecessor", originalPointer);
    const prior = { ...originalPointer, memoryId: "successor", hostSource: "prior-successor" };
    if (existing) pointers.set("successor", prior);
    successorPointer = { ...prior, hostSource: "this-attempt" };
    const result = await unlandedUpdate();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.response.status).toBe(409);
    expect((await result.response.json()).error).toBe("skill_update_not_closed");
    expect(pointers.get("predecessor")).toEqual(originalPointer);
    expect(pointers.get("successor")).toEqual(existing ? prior : undefined);
  });
}

test("journal leaves a later successor pointer in place and reports unconfirmed undo", async () => {
  pointers.set("predecessor", originalPointer);
  successorPointer = { ...originalPointer, memoryId: "successor" };
  laterSuccessorPointer = { ...successorPointer, hostSource: "later" };
  const result = await unlandedUpdate();
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.response.status).toBe(500);
  expect((await result.response.json()).error).toBe("skill_update_compensation_failed");
  expect(pointers.get("successor")).toEqual(laterSuccessorPointer);
  expect(pointers.get("predecessor")).toEqual(originalPointer);
  expect(memories.has("successor")).toBe(false);
});

test("every staged operation has an inverse, including additional caller writes", async () => {
  const prior = { id: "extra-overwrite", agentId: "writer", content: "before", createdAt: "2020-01-01T00:00:00.000Z" };
  const deleted = { ...prior, id: "extra-delete" };
  memories.set(prior.id, prior);
  memories.set(deleted.id, deleted);
  extraHook = async (shared) => {
    await memoryTable.put({ ...prior, content: "after" }, shared);
    await memoryTable.put({ ...prior, content: "after-later" }, shared);
    await memoryTable.delete(deleted.id, shared);
    await memoryTable.put({ ...prior, id: "extra-create" }, shared);
  };
  const result = await unlandedUpdate();
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.response.status).toBe(409);
  expect(memories.get(prior.id)).toEqual(prior);
  expect(memories.get(deleted.id)).toEqual(deleted);
  expect(memories.has("extra-create")).toBe(false);
  expect(capturedJournal.entries.map((entry: any) => entry.operation)).toEqual(stagedOperations);
  const overwritten = capturedJournal.entries.find((entry: any) => entry.operation.key === prior.id);
  expect(overwritten.before).toEqual(prior);
  expect(overwritten.after.content).toBe("after");
  const overwrittenAgain = capturedJournal.entries.filter((entry: any) => entry.operation.key === prior.id)[1];
  expect(overwrittenAgain.before.content).toBe("after");
  expect(overwrittenAgain.after.content).toBe("after-later");
  capturedJournal.entries.splice(0, 1);
  expect(() => capturedJournal.assertCoverage()).toThrow("staged write has no inverse");
});

test("journal captures a caller write on a chained transaction", async () => {
  extraHook = async (shared) => {
    const next: any = { writes: [], addWrite(operation: any) {
      this.writes.push(operation);
      operation.commit(1, null);
      return operation;
    } };
    shared.transaction.next = next;
    const row = { id: "chained-create", agentId: "writer", content: "caller write", createdAt: "2020-01-01T00:00:00.000Z" };
    const operation: any = { key: row.id, store: memoryTable.primaryStore, commit() {
      Map.prototype.set.call(shared.transaction.memories, row.id, row);
      operation.stagedEntry = { value: row };
    } };
    next.addWrite(operation);
  };
  const result = await unlandedUpdate();
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.response.status).toBe(409);
  expect(capturedJournal.entries.some((entry: any) => entry.operation.key === "chained-create")).toBe(true);
  expect(memories.has("chained-create")).toBe(false);
});

test("journal preserves a later successor write with identical fields", async () => {
  replaceSuccessorVersion = true;
  const result = await unlandedUpdate();
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.response.status).toBe(500);
  expect((await result.response.json()).error).toBe("skill_update_compensation_failed");
  expect(memories.get("successor")?.content).toBe("v2");
  expect(versions.size).toBe(0);
});

test("a refusal after preparation writes compensates those writes", async () => {
  const result = await runSkillVersionWrite({
    ctx: { request: { tpsAgent: "writer", tpsAgentIsAdmin: false, headers: new Headers({ authorization: "TPS-Ed25519 a1:1:n:s" }) } },
    subjectId: "subject", agentId: "writer", head: async () => null,
    plan: async (_head, shared) => {
      await memoryTable.put({ id: "prepared", agentId: "writer", content: "prepare write", createdAt: "2020-01-01T00:00:00.000Z" }, shared);
      return Response.json({ error: "caller_refused" }, { status: 409 });
    },
    hooks: {},
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.response.status).toBe(409);
  expect((await result.response.json()).error).toBe("caller_refused");
  expect(memories.has("prepared")).toBe(false);
});

test("a refused outer transaction compensates a caller hook's committed inner write", async () => {
  const { withOwnedTransaction } = await import("../../resources/request-transaction.ts");
  const predecessor = { id: "predecessor", agentId: "writer", content: "v1", tags: ["skill"], visibility: "shared", durability: "persistent", skillSubjectId: "subject", createdAt: "2020-01-01T00:00:00.000Z" };
  const successor = { ...predecessor, id: "successor", content: "v2" };
  memories.set(predecessor.id, predecessor);
  const result = await runSkillVersionWrite({
    ctx: { request: { tpsAgent: "writer", tpsAgentIsAdmin: false, headers: new Headers({ authorization: "TPS-Ed25519 a1:1:n:s" }) } },
    subjectId: "subject", agentId: "writer", head: async () => predecessor,
    plan: () => ({ kind: "update", predecessor, successor, closePatch: { validTo: "closed" }, value: "v2", visibility: "shared", grantedClose: null }),
    hooks: { ...defaultSkillHooks, pointer: async (shared) => {
      await withOwnedTransaction(shared, async (inner) => {
        await memoryTable.put({ ...predecessor, id: "inner-write", tags: [] }, inner);
      });
      return Response.json({ error: "caller_refused" }, { status: 409 });
    } },
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.response.status).toBe(409);
  expect((await result.response.json()).error).toBe("caller_refused");
  expect(memories.has("inner-write")).toBe(false);
  expect(memories.has("successor")).toBe(false);
  expect(memories.get("predecessor")).toEqual(predecessor);
});

test("a predecessor deleted after this attempt closed it stays missing with unconfirmed undo", async () => {
  const predecessor = { id: "predecessor", agentId: "writer", content: "v1", tags: ["skill"], visibility: "shared", durability: "persistent", skillSubjectId: "subject", createdAt: "2020-01-01T00:00:00.000Z" };
  const successor = { ...predecessor, id: "successor", content: "v2" };
  memories.set(predecessor.id, predecessor);
  losePredecessor = true;
  const result = await runSkillVersionWrite({
    ctx: { request: { tpsAgent: "writer", tpsAgentIsAdmin: false, headers: new Headers({ authorization: "TPS-Ed25519 a1:1:n:s" }) } },
    subjectId: "subject", agentId: "writer", head: async () => predecessor,
    plan: () => ({ kind: "update", predecessor, successor, closePatch: { validTo: "closed" }, value: "v2", visibility: "shared", grantedClose: null }),
    hooks: { ...defaultSkillHooks, authorizeClose: async () => null },
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.response.status).toBe(500);
  expect((await result.response.json()).error).toBe("skill_update_compensation_failed");
  expect(memories.has("predecessor")).toBe(false);
  expect(memories.has("successor")).toBe(false);
  expect(versions.size).toBe(0);
});

test("journal snapshots and undo read records from Harper's encoder", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = `
    import assert from "node:assert/strict";
    import { createRequire, registerHooks } from "node:module";
    import { existsSync, readFileSync } from "node:fs";
    import { fileURLToPath, pathToFileURL } from "node:url";
    const require = createRequire(process.cwd() + "/journal-fixture.cjs");
    const { RecordEncoder } = require("./node_modules/harper/dist/resources/RecordEncoder.js");
    const encoder = new RecordEncoder({ useVersions: false, randomAccessStructure: true,
      structures: [], saveStructures: () => true, getStructures: () => [] });
    const encode = (row) => encoder.decode(encoder.encode(row), { lazy: true });
    const before = { id: "overwritten", agentId: "writer", content: "before", createdAt: "2020-01-01T00:00:00.000Z" };
    const stored = encode(before);
    assert.deepEqual(Object.keys(stored), []);
    const rows = new Map([[before.id, { value: stored, version: 1 }]]);
    let revision = 1;
    const store = { getEntry: (key) => rows.get(key) };
    const raw = {
      get: async (key) => rows.get(key)?.value ?? null,
      put: async (row) => rows.set(row.id, { value: encode(row), version: revision }),
      delete: async (key) => rows.delete(key),
    };
    const table = Object.assign(Object.create(raw), { primaryStore: store });
    globalThis.journalTables = { flair: { Memory: table } };
    const harper = "data:text/javascript,export const databases = globalThis.journalTables";
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === "harper") return { url: harper, shortCircuit: true };
      if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
        const url = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
      return next(specifier, context);
    }, load(url, context, next) {
      if (url.endsWith(".ts")) return {
        format: "module", shortCircuit: true,
        source: require("typescript").transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
          compilerOptions: { target: "ES2022", module: "ESNext" },
        }).outputText,
      };
      return next(url, context);
    } });
    const { WriteJournal } = await import(pathToFileURL(process.cwd() + "/resources/write-journal.ts"));
    const journal = new WriteJournal();
    const ctx = { transaction: { writes: [], addWrite(operation) {
      this.writes.push(operation); operation.commit(1, store.getEntry(operation.key)); return operation;
    } } };
    await journal.run(() => journal.transaction(ctx, async (capture, complete) => {
      capture();
      for (const row of [{ ...before, content: "after" }, { ...before, id: "created" }]) {
        const operation = { key: row.id, store, commit() {
          const value = encode(row); rows.set(row.id, { value, version: 1 }); this.stagedEntry = { value };
        } };
        ctx.transaction.addWrite(operation);
      }
      complete();
    }));
    assert.deepEqual(journal.entries[0].before, before);
    const undone = await journal.undo({}, async (_ctx, fn) => {
      const time = ++revision;
      return fn({ transaction: { addWrite(guard) { guard.commit(time, store.getEntry(guard.key)); } } });
    });
    assert.equal(undone, true);
    assert.equal(rows.has("created"), false);
    for (const [key, value] of Object.entries(before)) assert.equal(rows.get(before.id).value[key], value);
  `;
  const result = spawnSync("node", ["--input-type=module", "-e", script], {
    cwd: new URL("../..", import.meta.url), encoding: "utf8", timeout: 30_000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}, 35_000);
