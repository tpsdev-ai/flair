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
const { Memory, _resetLocalInstanceIdCacheForTests } = await installMemoryHarperMock();
const { FeedMemories } = await import("../../resources/MemoryFeed.ts");
const { createEmbeddingStampMigration } = await import("../../resources/migrations/embedding-stamp.ts");
const { resolveSkillManifest, resolvableSkillRows, SKILL_ROW_SELECT } = await import("../../resources/skill-manifest.ts");
const table = databasesMock.flair.Memory;
const { SEED_SKILL_ROW_ID } = await import("../../resources/seed-ids.ts");
const { currentSeed, runSkillSeed, skillSeedRestIo } = await import("../../src/lib/skill-seed.ts");

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
  _resetLocalInstanceIdCacheForTests();
});

test("concurrent identical reserved seed PUTs succeed without a second version", async () => {
  const body = { ...skill(SEED_SKILL_ROW_ID, "admin") };
  delete body.createdAt;
  delete body.instanceToken;
  delete body.embedding;
  delete body.embeddingModel;
  const results = await Promise.all([
    writer(body.id, { ...operator, request: { ...operator.request } }).put({ ...body }),
    writer(body.id, { ...operator, request: { ...operator.request } }).put({ ...body }),
  ]);
  for (const result of results) expect(result.id).toBe(body.id);
  expect(results.map((r) => r.written).sort()).toEqual([false, true]);
  expect(harnessState.memoryStore.size).toBe(1);
  expect(harnessState.memoryStore.get(body.id)).toMatchObject(body);
  expect(versions.size).toBe(1);
  expect(versions.get(`skill:${body.id}:1`)?.kind).toBe("create");
});

test("concurrent different reserved seed PUTs refuse the stale write", async () => {
  const body = { ...skill(SEED_SKILL_ROW_ID, "admin") };
  const results = await Promise.all([
    writer(body.id, { ...operator, request: { ...operator.request } }).put({ ...body }),
    writer(body.id, { ...operator, request: { ...operator.request } }).put({ ...body, content: "different" }),
  ]);
  expect(results[0].id).toBe(body.id);
  expect(results[1].status).toBe(409);
  expect(await results[1].json()).toEqual({ error: "skill_target_changed" });
  expect(harnessState.memoryStore.size).toBe(1);
  expect(harnessState.memoryStore.get(body.id)?.content).toBe(body.content);
  expect(versions.size).toBe(1);
});

test("concurrent seed helpers return ok with one row, assignment and version", async () => {
  const assignments = new Map<string, any>();
  const fetchImpl = (async (input: any, init: any = {}) => {
    const [, tableName, encodedId] = new URL(String(input)).pathname.split("/");
    const id = decodeURIComponent(encodedId);
    const rows = tableName === "Memory" ? harnessState.memoryStore : assignments;
    if (init.method === "PUT") {
      const body = JSON.parse(init.body);
      if (tableName === "Memory") {
        const result = await writer(id, { ...operator, request: { ...operator.request } }).put(body);
        return result instanceof Response ? result : Response.json(result);
      }
      rows.set(id, { ...body, id, writer: "admin", sourceClass: "operator" });
      return Response.json({ id });
    }
    return rows.has(id) ? Response.json(rows.get(id)) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const io = () => skillSeedRestIo({ baseUrl: "http://seed.invalid", user: "admin", pass: "test", fetchImpl });
  const results = await Promise.all([runSkillSeed(io(), currentSeed()), runSkillSeed(io(), currentSeed())]);
  expect(results.map((r) => r.kind), JSON.stringify(results)).toEqual(["ok", "ok"]);
  expect(harnessState.memoryStore.size).toBe(1);
  expect(assignments.size).toBe(1);
  expect(versions.size).toBe(1);
  expect(harnessState.memoryStore.get(SEED_SKILL_ROW_ID)?.content).toBe(currentSeed().content);
});

test("concurrent identical seed upgrades append only one update", async () => {
  const created = await writer(SEED_SKILL_ROW_ID).put(skill(SEED_SKILL_ROW_ID, "admin"));
  expect(created.written).toBe(true);
  const body = { id: SEED_SKILL_ROW_ID, agentId: "admin", content: "upgraded text" };
  const results = await Promise.all([
    writer(body.id, { ...operator, request: { ...operator.request } }).put({ ...body }),
    writer(body.id, { ...operator, request: { ...operator.request } }).put({ ...body }),
  ]);
  expect(results.map((r) => r.written).sort()).toEqual([false, true]);
  expect(harnessState.memoryStore.size).toBe(1);
  expect(harnessState.memoryStore.get(body.id)?.content).toBe(body.content);
  expect([...versions.values()].map((v) => v.kind)).toEqual(["create", "update"]);
});

test.each(["content", "trigger", "visibility", "metadata", "createdAt"])("a concurrent different seed %s refuses", async (field) => {
  const body = skill(SEED_SKILL_ROW_ID, "admin");
  const values: Record<string, string> = { content: "different", trigger: "different", visibility: "private", metadata: '{"name":"different"}', createdAt: "2021-01-01T00:00:00.000Z" };
  const results = await Promise.all([
    writer(body.id, { ...operator, request: { ...operator.request } }).put({ ...body }),
    writer(body.id, { ...operator, request: { ...operator.request } }).put({ ...body, [field]: values[field] }),
  ]);
  const winner = results.findIndex((r) => !(r instanceof Response));
  expect(winner).not.toBe(-1);
  expect(results[winner].id).toBe(body.id);
  expect(results[1 - winner].status).toBe(409);
  expect(harnessState.memoryStore.size).toBe(1);
  expect(harnessState.memoryStore.get(body.id)?.[field]).toBe(winner === 0 ? body[field] : values[field]);
  expect(versions.size).toBe(1);
});

test("an admin agent cannot no-op an identical reserved seed PUT", async () => {
  const body = skill(SEED_SKILL_ROW_ID, "admin");
  await writer(body.id).put({ ...body });
  const before = harnessState.memoryStore.get(body.id);
  const result = await writer(body.id, adminAgent).put({ ...body });
  expect(result.status).toBe(403);
  expect(harnessState.memoryStore.get(body.id)).toEqual(before);
  expect(versions.size).toBe(1);
});

test("an identical reserved PUT refuses ambiguous live heads", async () => {
  const body = skill(SEED_SKILL_ROW_ID, "admin");
  await writer(body.id).put({ ...body });
  harnessState.memoryStore.set("other", { ...body, id: "other", skillSubjectId: body.id });
  const before = new Map(harnessState.memoryStore);
  expect((await writer(body.id).put({ ...body })).status).toBe(500);
  expect(harnessState.memoryStore).toEqual(before);
  expect(versions.size).toBe(1);
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

test.each(["content", "trigger", "visibility", "metadata", "expiresAt", "archived", "validTo"])("a %s change with cleared embeddings is applied or refused", async (field) => {
  const row = skill();
  harnessState.memoryStore.set(row.id, row);
  const values: Record<string, unknown> = { content: "edited", trigger: "new trigger", visibility: "private", metadata: JSON.stringify({ name: "renamed" }), expiresAt: "2099-01-01T00:00:00.000Z", archived: true, validTo: "2099-01-01T00:00:00.000Z" };
  const result = await writer(row.id).put({ ...row, [field]: values[field], embedding: null, embeddingModel: null });
  if (field === "archived" || field === "validTo") {
    expect(result.status).toBe(400);
    expect(harnessState.memoryStore.get(row.id)).toEqual(row);
    expect(harnessState.memoryStore.get(row.id)?.archived).toBe(false);
    expect(harnessState.memoryStore.size).toBe(1);
    expect(versions.size).toBe(0);
    return;
  }
  expect(result.id).not.toBe(row.id);
  expect(harnessState.memoryStore.get(result.id)?.[field]).toEqual(values[field]);
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

function feed(ctx = operator): any {
  const resource: any = new FeedMemories();
  resource.getContext = () => ctx;
  // A feed write refuses a body embedding stamp (flair#2354), and skill()
  // carries one, so the feed body is sent without it.
  const post = resource.post.bind(resource);
  resource.post = (body: any) => {
    if (!body || typeof body !== "object") return post(body);
    const { embedding: _embedding, embeddingModel: _embeddingModel, ...rest } = body;
    return post(rest);
  };
  return resource;
}

test.each(["put", "post", "feed"])("an admin agent cannot name another owner's predecessor through %s", async (method) => {
  const row = skill();
  harnessState.memoryStore.set(row.id, row);
  const body = { ...skill("attacker", "admin"), supersedes: row.id };
  const result = method === "feed" ? await feed(adminAgent).post(body) : await writer(body.id, adminAgent)[method](body);
  expect(result.status).toBe(403);
  expect([...harnessState.memoryStore.values()]).toEqual([row]);
  expect(versions.size).toBe(0);
});

test("a granted admin agent preserves the predecessor owner and records the actor separately", async () => {
  const row = skill();
  harnessState.memoryStore.set(row.id, row);
  const grants = databasesMock.flair.MemoryGrant;
  const original = grants.search;
  (grants as any).search = async function* () { yield { scope: "write" }; };
  try {
    const result = await writer("successor", adminAgent).put({ ...skill("successor", "admin"), supersedes: row.id });
    expect(result.id).toBe("successor");
    expect(harnessState.memoryStore.get(result.id)?.agentId).toBe("owner");
    expect(versions.get(`skill:${row.id}:1`)?.agentId).toBe("owner");
    expect(versions.get(`skill:${row.id}:1`)?.actorId).toBe("admin");
    expect(versions.get(`skill:${row.id}:1`)?.sourceClass).toBe("agent");
  } finally { grants.search = original; }
});

test.each([false, true])("stale-id update refuses without creating another live head (explicit=%s)", async (explicit) => {
  const first = skill();
  harnessState.memoryStore.set(first.id, first);
  const result = await writer(first.id).put({ id: first.id, content: "second" });
  const before = [...harnessState.memoryStore.values()];
  const rejected = explicit
    ? await writer("third").put({ ...skill("third"), supersedes: first.id })
    : await writer(first.id).put({ id: first.id, content: "third" });
  expect(rejected.status).toBe(409);
  expect([...harnessState.memoryStore.values()]).toEqual(before);
  expect(harnessState.memoryStore.get(result.id)?.validTo).toBeUndefined();
  expect(versions.size).toBe(1);
});

test("stale-id delete closes the current head and deletes that head's pointer", async () => {
  const first = skill();
  harnessState.memoryStore.set(first.id, first);
  const next = await writer(first.id).put({ id: first.id, content: "second" });
  harnessState.pointerStore.set(next.id, { memoryId: next.id });
  const result = await writer(first.id).delete(first.id);
  expect(result.status).toBe(200);
  expect((await result.json()).id).toBe(next.id);
  expect(harnessState.pointerStore.has(next.id)).toBe(false);
  expect(harnessState.memoryStore.get(next.id)?.validTo).toBeString();
  expect(versions.get(`skill:${first.id}:2`)?.rowId).toBe(next.id);
  expect(versions.get(`skill:${first.id}:2`)?.memoryId).toBeNull();
});

test.each(["ambiguous", "missing"])("%s live heads refuse updates and deletes", async (state) => {
  const row = { ...skill(), skillSubjectId: "subject", ...(state === "missing" ? { validTo: "closed" } : {}) };
  harnessState.memoryStore.set(row.id, row);
  if (state === "ambiguous") harnessState.memoryStore.set("other", { ...skill("other"), skillSubjectId: "subject" });
  const before = [...harnessState.memoryStore.values()];
  expect((await writer(row.id).put({ id: row.id, content: "edit" })).status).toBeGreaterThanOrEqual(400);
  expect((await writer(row.id).delete(row.id)).status).toBeGreaterThanOrEqual(400);
  expect([...harnessState.memoryStore.values()]).toEqual(before);
  expect(versions.size).toBe(0);
});

test.each(["put", "feed"])("%s scans a tagless edit of a stored skill", async (method) => {
  const row = skill();
  harnessState.memoryStore.set(row.id, row);
  const body = { id: row.id, agentId: row.agentId, content: "```bash\nexec(rm -rf /)\n```" };
  const result = method === "feed" ? await feed().post(body) : await writer(row.id).put(body);
  expect(result.status).toBe(400);
  expect((await result.json()).error).toBe("skill_scan_rejected");
  expect([...harnessState.memoryStore.values()]).toEqual([row]);
  expect(versions.size).toBe(0);
});

test.each(["put", "post", "feed"])("%s scans a tagless explicit skill successor", async (method) => {
  const row = skill();
  harnessState.memoryStore.set(row.id, row);
  const body = { id: "next", agentId: "owner", supersedes: row.id, content: "```bash\nexec(rm -rf /)\n```" };
  const result = method === "feed" ? await feed().post(body) : await writer("next")[method](body);
  expect(result.status).toBe(400);
  expect((await result.json()).error).toBe("skill_scan_rejected");
  expect([...harnessState.memoryStore.values()]).toEqual([row]);
  expect(versions.size).toBe(0);
});

test.each(["put", "post", "feed"])("%s refuses a failed predecessor lookup", async (method) => {
  harnessState.getOverride = (id) => { if (id === "unreadable") throw new Error("lookup failed"); };
  const body = { ...skill("next"), supersedes: "unreadable" };
  const result = await (method === "feed" ? feed().post(body) : writer("next")[method](body));
  // flair#2307: the failed read refuses with a named error instead of throwing.
  expect(result).toBeInstanceOf(Response);
  expect(result.status).toBe(503);
  expect((await result.json()).error).toBe("supersedes_target_unreadable");
  expect(harnessState.memoryStore.size).toBe(0);
  expect(versions.size).toBe(0);
});

test("feed re-ingest inherits skill tags and supersedes even when content is unchanged", async () => {
  const first = await feed().post(skill());
  const next = await feed().post({ id: first.id, agentId: "owner", content: first.content, trigger: "changed trigger" });
  expect(next.id).not.toBe(first.id);
  expect(next.supersedes).toBe(first.id);
  expect(next.tags).toEqual(["skill"]);
  expect(next.trigger).toBe("changed trigger");
  expect(harnessState.memoryStore.get(first.id)?.validTo).toBeString();
  expect([...versions.values()].map((v) => v.kind)).toEqual(["create", "update"]);
});

test.each([false, true])("feed stamps a skill inside the transaction (update=%s)", async (update) => {
  harnessState.instanceRow = { id: "local" };
  const stored = { ...skill(), originatorInstanceId: "origin", _originatorInstanceId: "receiver", _syncedFrom: "peer", _syncedAt: "receipt" };
  if (update) harnessState.memoryStore.set(stored.id, stored);
  const result = await feed().post({ ...skill(), originatorInstanceId: "forged", _originatorInstanceId: "forged", _syncedFrom: "forged", _syncedAt: "forged" });
  const written = harnessState.memoryStore.get(result.id);
  expect(written?.originatorInstanceId).toBe(update ? "origin" : "local");
  for (const key of ["_originatorInstanceId", "_syncedFrom", "_syncedAt"] as const) {
    expect(written?.[key]).toBe(update ? stored[key] : undefined);
  }
});

test("feed refuses archive changes and preserves the stored archive state", async () => {
  const row = skill();
  harnessState.memoryStore.set(row.id, row);
  const result = await feed().post({ id: row.id, agentId: "owner", content: row.content, archived: true });
  expect(result.status).toBe(400);
  expect(harnessState.memoryStore.get(row.id)?.archived).toBe(false);
  expect([...harnessState.memoryStore.values()]).toEqual([row]);
  expect(versions.size).toBe(0);
});

test("an admin agent cannot delete another owner's current head through its own old row", async () => {
  const old = { ...skill("old", "admin"), skillSubjectId: "subject", validTo: "closed" };
  const head = { ...skill("head", "victim"), skillSubjectId: "subject" };
  harnessState.memoryStore.set(old.id, old);
  harnessState.memoryStore.set(head.id, head);
  const result = await writer(old.id, adminAgent).delete(old.id);
  expect(result.status).toBe(403);
  expect([...harnessState.memoryStore.values()]).toEqual([old, head]);
  expect(versions.size).toBe(0);
});

test("a target changed after classification refuses under the lock", async () => {
  const row = skill();
  harnessState.memoryStore.set(row.id, row);
  const original = table.search;
  (table as any).search = (query: any, shared: any) => {
    if (query?.conditions?.some((c: any) => c.attribute === "skillSubjectId")) {
      expect(locks.size).toBe(1);
      expect(shared.transaction.open).toBe(1);
      harnessState.memoryStore.set(row.id, { ...row, content: "concurrent edit" });
    }
    return original(query);
  };
  try {
    const result = await writer(row.id).put({ id: row.id, trigger: "updated" });
    expect(result.status).toBe(409);
    expect(harnessState.memoryStore.get(row.id)?.content).toBe("concurrent edit");
    expect(harnessState.memoryStore.size).toBe(1);
    expect(versions.size).toBe(0);
  } finally { table.search = original; }
});

test.each(["put", "feed"])("%s refuses self-supersession", async (method) => {
  const row = skill();
  harnessState.memoryStore.set(row.id, row);
  const body = { ...row, supersedes: row.id };
  const result = method === "feed" ? await feed().post(body) : await writer(row.id).put(body);
  expect(result.status).toBe(409);
  expect([...harnessState.memoryStore.values()]).toEqual([row]);
  expect(versions.size).toBe(0);
});

test("closing an unenrolled successor enrolls its retained row for stale-id deletion", async () => {
  const prior = { ...skill("prior"), validTo: "closed" };
  const row = { ...skill("legacy"), supersedes: prior.id };
  harnessState.memoryStore.set(prior.id, prior);
  harnessState.memoryStore.set(row.id, row);
  const next = await writer(row.id).put({ ...row, content: "edit" });
  expect(harnessState.memoryStore.get(row.id)?.skillSubjectId).toBe(prior.id);
  const deleted = await writer(row.id).delete(row.id);
  expect(deleted.status).toBe(200);
  expect((await deleted.json()).id).toBe(next.id);
  expect(harnessState.memoryStore.get(next.id)?.validTo).toBeString();
});
