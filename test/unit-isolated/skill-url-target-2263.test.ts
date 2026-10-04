// flair#2263 — the URL-bound id is the skill write target; the feed refuses
// reserved seed ids. Mocked transactions/locks, no Harper.
import { beforeEach, expect, test } from "bun:test";
import {
  databasesMock, harnessState, installMemoryHarperMock, resetHarnessState,
} from "../helpers/memory-search-harness";

const versions = new Map<string, any>();
const locks = new Set<string>();
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
    shared.transaction.staged.push(() => versions.set(row.id, { ...row }));
  },
};
const { Memory, _resetLocalInstanceIdCacheForTests } = await installMemoryHarperMock();
const { FeedMemories } = await import("../../resources/MemoryFeed.ts");
const { resolveSkillManifest, resolvableSkillRows, SKILL_ROW_SELECT } = await import("../../resources/skill-manifest.ts");
const table = databasesMock.flair.Memory;
const { SEED_SKILL_ROW_ID } = await import("../../resources/seed-ids.ts");
const { currentSeed, runSkillSeed, skillSeedRestIo } = await import("../../src/lib/skill-seed.ts");

const operator = { request: { tpsAgent: "admin", tpsAgentIsAdmin: true, headers: new Headers({ authorization: "Basic ok" }) } };

function writer(id: string, ctx = operator): any {
  const resource: any = new (Memory as any)();
  resource.getId = () => id;
  resource.getContext = () => ctx;
  return resource;
}
function feed(ctx = operator): any {
  const resource: any = new FeedMemories();
  resource.getContext = () => ctx;
  return resource;
}
function skill(id: string, owner = "owner", content = "procedure"): any {
  return {
    id, agentId: owner, tags: ["skill"], content, trigger: "when it applies",
    durability: "persistent", visibility: "shared", archived: false,
    createdAt: "2020-01-01T00:00:00.000Z", instanceToken: "token",
  };
}

beforeEach(() => {
  resetHarnessState(); versions.clear(); locks.clear();
  _resetLocalInstanceIdCacheForTests();
});

test("a skill PUT whose id is only in the URL creates at that id", async () => {
  const body = { agentId: "owner", content: "c1", trigger: "t", tags: ["skill"], durability: "persistent", visibility: "shared" };
  const result = await writer("url-only").put({ ...body });
  expect(result.id).toBe("url-only");
  expect(harnessState.memoryStore.get("url-only")?.skillSubjectId).toBe("url-only");
  expect(harnessState.memoryStore.size).toBe(1);
  expect(versions.get("skill:url-only:1")?.kind).toBe("create");
  expect(versions.get("skill:url-only:1")?.memoryId).toBe("url-only");
});

test("with no body id, a concurrent edit under the lock refuses with 409 and writes nothing", async () => {
  const row = skill("url-edit");
  harnessState.memoryStore.set(row.id, row);
  const original = table.search;
  (table as any).search = (query: any) => {
    if (query?.conditions?.some((c: any) => c.attribute === "skillSubjectId")) {
      harnessState.memoryStore.set(row.id, { ...row, content: "concurrent edit" });
    }
    return original(query);
  };
  try {
    const result = await writer(row.id).put({ trigger: "updated" });
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: "skill_target_changed" });
    expect(harnessState.memoryStore.get(row.id)?.content).toBe("concurrent edit");
    expect(harnessState.memoryStore.size).toBe(1);
    expect(versions.size).toBe(0);
  } finally { table.search = original; }
});

test("two concurrent different reserved-seed PUTs (id only in the URL) refuse the stale one", async () => {
  const body = { agentId: "admin", content: "seed text", trigger: "t", tags: ["skill"], durability: "persistent", visibility: "shared" };
  const results = await Promise.all([
    writer(SEED_SKILL_ROW_ID).put({ ...body }),
    writer(SEED_SKILL_ROW_ID).put({ ...body, content: "different" }),
  ]);
  const winner = results.findIndex((r) => !(r instanceof Response));
  expect(winner).not.toBe(-1);
  expect(results[winner].id).toBe(SEED_SKILL_ROW_ID);
  expect(results[1 - winner].status).toBe(409);
  expect(harnessState.memoryStore.size).toBe(1);
  expect(harnessState.memoryStore.get(SEED_SKILL_ROW_ID)?.content).toBe(winner === 0 ? body.content : "different");
  expect(versions.size).toBe(1);
});

function seedRow(content: string): any {
  return {
    id: SEED_SKILL_ROW_ID, agentId: "admin", tags: ["skill"], content,
    trigger: currentSeed().trigger, durability: "persistent", visibility: "shared",
    archived: false, createdAt: "2020-01-01T00:00:00.000Z", instanceToken: "token",
    metadata: JSON.stringify({ name: currentSeed().name }),
  };
}

async function manifest(agentId = "reader") {
  const rows: any[] = [];
  for await (const row of table.search({ conditions: [{ attribute: "id", comparator: "equals", value: SEED_SKILL_ROW_ID }], select: SKILL_ROW_SELECT })) rows.push(row);
  const live = resolvableSkillRows(rows, (row) => row.agentId === agentId || row.visibility !== "private");
  return resolveSkillManifest([], [], agentId, {
    assignments: [{ skillName: currentSeed().name, skillRef: SEED_SKILL_ROW_ID, priority: "standard" }],
    rows: live, instanceId: null,
  });
}

test("an operator feed write that names the seed id is refused and the seed row survives a re-seed", async () => {
  harnessState.memoryStore.set(SEED_SKILL_ROW_ID, seedRow(currentSeed().content));
  const before = harnessState.memoryStore.get(SEED_SKILL_ROW_ID);

  const asId = await feed().post({ id: SEED_SKILL_ROW_ID, agentId: "admin", content: "fed", tags: ["skill"] });
  expect(asId.status).toBe(403);
  const asIdBody = await asId.json();
  expect(asIdBody.error).toStartWith("seed_id_reserved");
  expect(asIdBody.error).toContain("flair init");

  const asSupersedes = await feed().post({ id: "feed-new", agentId: "admin", content: "fed", tags: ["skill"], supersedes: SEED_SKILL_ROW_ID });
  expect(asSupersedes.status).toBe(403);
  expect((await asSupersedes.json()).error).toStartWith("seed_id_reserved");

  // The seed row is byte-identical, still open, and still the org manifest's row.
  expect(harnessState.memoryStore.get(SEED_SKILL_ROW_ID)).toEqual(before);
  expect(harnessState.memoryStore.get(SEED_SKILL_ROW_ID)?.validTo).toBeUndefined();
  expect(harnessState.memoryStore.has("feed-new")).toBe(false);
  expect(versions.size).toBe(0);
  expect((await manifest()).skills).toEqual([
    { name: currentSeed().name, skillId: SEED_SKILL_ROW_ID, scope: "org", priority: "standard", source: null },
  ]);

  // A standard re-seed then succeeds (the row is already current).
  const assignments = new Map<string, any>();
  const fetchImpl = (async (input: any, init: any = {}) => {
    const [, tableName, encodedId] = new URL(String(input)).pathname.split("/");
    const id = decodeURIComponent(encodedId);
    if (init.method === "PUT") {
      const body = JSON.parse(init.body);
      if (tableName === "Memory") {
        const result = await writer(id).put(body);
        return result instanceof Response ? result : Response.json(result);
      }
      assignments.set(id, { ...body, id, writer: "admin", sourceClass: "operator" });
      return Response.json({ id });
    }
    const rows = tableName === "Memory" ? harnessState.memoryStore : assignments;
    return rows.has(id) ? Response.json(rows.get(id)) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const io = () => skillSeedRestIo({ baseUrl: "http://seed.invalid", user: "admin", pass: "test", fetchImpl });
  expect(await runSkillSeed(io(), currentSeed())).toMatchObject({ kind: "ok", action: "unchanged" });
  expect(harnessState.memoryStore.get(SEED_SKILL_ROW_ID)).toEqual(before);
});
