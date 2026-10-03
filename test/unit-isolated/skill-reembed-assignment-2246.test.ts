import { beforeEach, expect, test } from "bun:test";
import {
  databasesMock, harnessState, installMemoryHarperMock, resetHarnessState,
} from "../helpers/memory-search-harness";

const versions = new Map<string, any>();
const locks = new Set<string>();
let failAppend = false;
(databasesMock.flair as any).InstructionVersion = {
  primaryStore: {
    tryLock: (key: unknown) => { const k = JSON.stringify(key); if (locks.has(k)) return false; locks.add(k); return true; },
    unlock: (key: unknown) => locks.delete(JSON.stringify(key)),
    resetReadTxn: () => {},
  },
  async *search(query: any) {
    const rows = [...versions.values()].filter((row) => query.conditions.every((c: any) => row[c.attribute] === c.value));
    rows.sort((a, b) => Number(b.version) - Number(a.version));
    yield* rows.slice(0, query.limit ?? rows.length);
  },
  async create(row: any, shared: any) {
    if (failAppend) throw new Error("append failed");
    shared.transaction.staged.push(() => versions.set(row.id, { ...row }));
  },
};
const { Memory } = await installMemoryHarperMock();
const { createEmbeddingStampMigration } = await import("../../resources/migrations/embedding-stamp.ts");
const { resolveSkillManifest, resolvableSkillRows, SKILL_ROW_SELECT } = await import("../../resources/skill-manifest.ts");
const table = databasesMock.flair.Memory;

const operator = { request: { tpsAgent: "admin", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "Basic ok" }) } };
const adminAgent = { request: { tpsAgent: "admin", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "TPS-Ed25519 a:1:n:s" }) } };
function writer(id: string, ctx = operator): any {
  const resource: any = new (Memory as any)();
  resource.getId = () => id;
  resource.getContext = () => ctx;
  return resource;
}
function skill(id = "ORG_ROW", owner = "owner"): any {
  return {
    id, agentId: owner, tags: ["skill"], metadata: JSON.stringify({ name: "assigned" }),
    content: "procedure", trigger: "when assigned applies", durability: "persistent",
    visibility: "shared", archived: false, createdAt: "2020-01-01T00:00:00.000Z",
    instanceToken: "original-token", embedding: [1, 0], embeddingModel: "old-model",
  };
}
async function manifest(agentId = "reader", own = false) {
  const rows = [];
  for await (const row of table.search({ conditions: [{ attribute: "id", comparator: "equals", value: own ? "OWN_ROW" : "ORG_ROW" }], select: SKILL_ROW_SELECT })) rows.push(row);
  const live = resolvableSkillRows(rows, (row) => row.agentId === agentId || row.visibility !== "private");
  return resolveSkillManifest(own ? [{ value: "assigned" }] : [], own ? live : [], agentId, {
    assignments: own ? [] : [{ skillName: "assigned", skillRef: "ORG_ROW", priority: "standard" }],
    rows: own ? [] : live, instanceId: null,
  });
}

beforeEach(() => {
  resetHarnessState(); versions.clear(); locks.clear(); failAppend = false;
});

test("a PUT create preserves the supplied physical id and org assignment", async () => {
  const result = await writer("ORG_ROW").put(skill());
  expect(result.id).toBe("ORG_ROW");
  expect((await manifest()).skills).toEqual([{ name: "assigned", skillId: "ORG_ROW", scope: "org", priority: "standard", source: null }]);
  expect(versions.get("skill:ORG_ROW:1")?.kind).toBe("create");
});

test("embedding migration preserves org and own assignment ids while appending versions", async () => {
  harnessState.memoryStore.set("ORG_ROW", skill());
  harnessState.memoryStore.set("OWN_ROW", skill("OWN_ROW", "reader"));
  const migration = createEmbeddingStampMigration(() => table, () => "new-model", async (id, existing) => {
    const result = await writer(id).put({ ...existing, embedding: null, embeddingModel: null });
    return !(result instanceof Response);
  });
  const batch = await migration.run(10);
  expect(batch.processed).toBe(2);
  expect((await manifest()).skills[0]?.skillId).toBe("ORG_ROW");
  expect((await manifest("reader", true)).skills[0]?.skillId).toBe("OWN_ROW");
  expect(harnessState.memoryStore.size).toBe(2);
  for (const id of ["ORG_ROW", "OWN_ROW"]) {
    expect(harnessState.memoryStore.get(id)?.validTo).toBeUndefined();
    expect(harnessState.memoryStore.get(id)?.skillSubjectId).toBe(id);
    expect(harnessState.memoryStore.get(id)?.instanceToken).toBe("original-token");
    expect(versions.get(`skill:${id}:1`)?.memoryId).toBe(id);
    expect(versions.get(`skill:${id}:1`)?.kind).toBe("update");
    expect(versions.get(`skill:${id}:1`)?.sourceClass).toBe("operator");
  }
});

test("reembedding a successor preserves its lineage and token", async () => {
  const row = { ...skill("successor"), skillSubjectId: "subject", supersedes: "predecessor", validFrom: "2020-01-01T00:00:00.000Z" };
  harnessState.memoryStore.set(row.id, row);
  const result = await writer(row.id).put({ ...row, embedding: null, embeddingModel: null });
  expect(result.id).toBe(row.id);
  expect(harnessState.memoryStore.get(row.id)?.supersedes).toBe("predecessor");
  expect(harnessState.memoryStore.get(row.id)?.skillSubjectId).toBe("subject");
  expect(versions.get("skill:subject:1")?.memoryId).toBe(row.id);
});

test("reembedding a raw fixture without an incarnation token enrolls it in place", async () => {
  const row = skill();
  delete row.instanceToken;
  harnessState.memoryStore.set(row.id, row);
  const result = await writer(row.id).put({ ...row, embedding: null, embeddingModel: null });
  expect(result.id).toBe(row.id);
  expect(harnessState.memoryStore.get(row.id)?.instanceToken).toBeString();
  expect(harnessState.memoryStore.get(row.id)?.instanceToken.length).toBeGreaterThan(0);
  expect(harnessState.memoryStore.get(row.id)?.validTo).toBeUndefined();
  expect((await manifest()).skills[0]?.skillId).toBe(row.id);
});

test("reembedding an unenrolled successor resolves the addressed live row", async () => {
  const predecessor = { ...skill("predecessor"), validTo: "2020-01-01T00:00:00.000Z" };
  const row = { ...skill("successor"), supersedes: predecessor.id, validFrom: "2020-01-01T00:00:00.000Z" };
  harnessState.memoryStore.set(predecessor.id, predecessor);
  harnessState.memoryStore.set(row.id, row);
  const result = await writer(row.id).put({ ...row, embedding: null, embeddingModel: null });
  expect(result.id).toBe(row.id);
  expect(harnessState.memoryStore.get(row.id)?.supersedes).toBe(predecessor.id);
  expect(harnessState.memoryStore.get(row.id)?.skillSubjectId).toBe(predecessor.id);
  expect(harnessState.memoryStore.get(row.id)?.validTo).toBeUndefined();
  expect(harnessState.memoryStore.get(predecessor.id)).toEqual(predecessor);
  expect(versions.get(`skill:${predecessor.id}:1`)?.memoryId).toBe(row.id);
});

test.each(["content", "trigger", "visibility", "metadata", "expiresAt", "archived", "validTo"])("a %s change with cleared embeddings still supersedes atomically", async (field) => {
  const row = skill();
  harnessState.memoryStore.set(row.id, row);
  const values: Record<string, unknown> = { content: "edited", trigger: "new trigger", visibility: "private", metadata: JSON.stringify({ name: "renamed" }), expiresAt: "2099-01-01T00:00:00.000Z", archived: true, validTo: "2099-01-01T00:00:00.000Z" };
  const result = await writer(row.id).put({ ...row, [field]: values[field], embedding: null, embeddingModel: null });
  expect(result.id).not.toBe(row.id);
  expect(harnessState.memoryStore.get(row.id)?.validTo).toBeString();
  expect(harnessState.memoryStore.get(result.id)?.skillSubjectId).toBe(row.id);
  expect(versions.get(`skill:${row.id}:1`)?.memoryId).toBe(result.id);
});

test("a failed append rolls back an in-place reembedding", async () => {
  const row = skill();
  harnessState.memoryStore.set(row.id, row);
  failAppend = true;
  const result = await writer(row.id).put({ ...row, embedding: null, embeddingModel: null });
  expect(result).toBeInstanceOf(Response);
  expect(result.status).toBeGreaterThanOrEqual(500);
  expect(harnessState.memoryStore.get(row.id)).toEqual(row);
  expect(versions.size).toBe(0);
});

test("an admin agent cannot reembed another agent's skill", async () => {
  const row = skill();
  harnessState.memoryStore.set(row.id, row);
  const result = await writer(row.id, adminAgent).put({ ...row, embedding: null, embeddingModel: null });
  expect(result.status).toBe(403);
  expect(harnessState.memoryStore.get(row.id)).toEqual(row);
  expect(versions.size).toBe(0);
});
