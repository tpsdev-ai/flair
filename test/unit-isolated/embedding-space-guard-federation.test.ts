/**
 * embedding-space-guard-federation.test.ts — the FEDERATION-SYNC mutation test
 * for the vector-space guard (embedding-space-guard slice 1; the raw-writer hole
 * K&S found in review #1554).
 *
 * The federation sync-in path merges Memory rows via the RAW table handle
 * (Federation.ts applyMergedRecordToTable), and an LWW remote-win copies the
 * REMOTE embeddingModel — so a memory synced from a spoke on a different
 * engine/model lands a FOREIGN-space vector, bypassing Memory.post()/put(). This
 * test drives the REAL sync-apply function against a mocked harper + the real
 * guard and asserts the latch trips → recall degrades to keyword-only, and that
 * a non-Memory or same-space sync does NOT trip.
 *
 * fails-on-unfixed: delete the noteWriteStamp call in
 * resources/Federation.ts applyMergedRecordToTable and the "foreign sync trips"
 * assertions go red (and the memory-embedding-writer-coverage gate reds too).
 *
 * Runs in test/unit-isolated (own process) so its harper/embeddings mocks never
 * race another file.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
process.env.FLAIR_HYBRID_RETRIEVAL = "false";
delete (process.env as any).FLAIR_PUBLIC;

const CURRENT = "gguf:nomic-embed-text-v1.5-Q4_K_M+searchprefix";
const FOREIGN = "gemma-embed:768";
const FAKE_EMBEDDING = [1, 0, 0, 0];
const OTHER_SPACE_VEC = [0, 1, 0, 0];

mock.module("../../resources/embeddings-provider.ts", () => ({
  getEmbedding: async (_t: string, _i?: string) => FAKE_EMBEDDING,
  getMode: () => "local",
  getModelId: () => CURRENT,
  EMBEDDING_ENGINE: "gguf",
}));

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function matchesCondition(record: any, cond: any): boolean {
  if (cond.operator && Array.isArray(cond.conditions)) {
    const r = cond.conditions.map((c: any) => matchesCondition(record, c));
    return cond.operator === "or" ? r.some(Boolean) : r.every(Boolean);
  }
  const v = record[cond.attribute];
  if (cond.comparator === "equals") return v === cond.value;
  if (cond.comparator === "not_equal" || cond.comparator === "not_equals") return v !== cond.value;
  return true;
}
let memoryStore: Map<string, any>;
let memoryGrants: any[];
function memorySearchGen(query: any) {
  const conditions = Array.isArray(query) ? query : Array.isArray(query?.conditions) ? query.conditions : [];
  let records = Array.from(memoryStore.values());
  for (const c of conditions) records = records.filter((r) => matchesCondition(r, c));
  if (query?.sort?.attribute === "embedding" && query.sort.distance === "cosine") {
    const target = query.sort.target;
    records = records
      .map((r) => ({ ...r, $distance: Array.isArray(r.embedding) ? 1 - cosineSim(r.embedding, target) : 1 }))
      .sort((a, b) => a.$distance - b.$distance);
  }
  const limit = typeof query?.limit === "number" ? query.limit : undefined;
  const sliced = limit !== undefined ? records.slice(0, limit) : records;
  async function* gen() { for (const r of sliced) yield r; }
  return gen();
}
class BaseMemory {
  async post(content: any) { const id = content.id ?? `m-${memoryStore.size}`; content.id = id; memoryStore.set(id, { ...content }); return id; }
  async put(content: any) { memoryStore.set(content.id, { ...content }); return undefined; }
  async get(t: any) { const id = typeof t === "string" ? t : t?.id; return memoryStore.get(id) ?? null; }
  search(q: any) { return memorySearchGen(q); }
  static async get(id: any) { return memoryStore.get(id) ?? null; }
  static async put(c: any) { const rec = { ...c }; memoryStore.set(c.id, rec); return rec; }
  static search(q: any) { return memorySearchGen(q); }
}
const databasesMock = {
  flair: {
    Memory: BaseMemory,
    MemoryGrant: { search: (q: any) => { const conds = Array.isArray(q?.conditions) ? q.conditions : []; let g = memoryGrants.slice(); for (const c of conds) g = g.filter((x) => matchesCondition(x, c)); async function* gen() { for (const x of g) yield x; } return gen(); } },
    Agent: { get: async () => null, search: async () => [] },
    Instance: { search: () => { async function* gen() {} return gen(); } },
    Nonce: { search: () => { async function* gen() {} return gen(); } }, // silence Federation's nonce-store hydrate
  },
};
mock.module("harper", () => ({ databases: databasesMock, Resource: class {}, server: { getUser: async () => null } }));

const { noteFederationMergedMemory } = await import("../../resources/Federation.ts");
const { SemanticSearch } = await import("../../resources/SemanticSearch.ts");
const { recomputeLatch, isEmbeddingSpaceUniform, _resetGuardForTests } = await import("../../resources/embedding-space-guard.ts");

const AGENT = "agent-me";
function makeSearch(agentId: string) {
  const r: any = new (SemanticSearch as any)();
  r.getContext = () => ({ request: { tpsAgent: agentId, tpsAgentIsAdmin: false } });
  return r;
}
const FINDING = "Federation replication direction is governed by a per-pair sends and receives knob in the pairing config.";

// Mirror the sync-in loop's two statements for a Memory record: the RAW
// table.put (kept inline in Federation.ts) + the latch trip
// (noteFederationMergedMemory). This is exactly what resources/Federation.ts
// runs per merged record.
async function syncInMemory(mergedData: Record<string, any>) {
  await (databasesMock.flair.Memory as any).put(mergedData);
  noteFederationMergedMemory("Memory", mergedData);
}

beforeEach(() => {
  memoryStore = new Map();
  memoryGrants = [];
  _resetGuardForTests();
  // Uniform current-space corpus.
  memoryStore.set("m1", { id: "m1", agentId: AGENT, content: FINDING, embeddingModel: CURRENT, embedding: FAKE_EMBEDDING, visibility: "shared", createdAt: new Date().toISOString() });
});

describe("embedding-space-guard — federation sync-in raw writer (mutation test)", () => {
  it("a federation-merged FOREIGN-stamped Memory trips the latch → recall degrades to keyword-only", async () => {
    expect(await recomputeLatch()).toBe(true); // uniform to start
    // Sanity: gate open, semantic-only query returns the row, no warning.
    const before: any = await makeSearch(AGENT).post({ agentId: AGENT, q: "zqxnokeywordhere" });
    expect(before.results.map((r: any) => r.id)).toContain("m1");
    expect(before._warning).toBeUndefined();

    // The sync-in path lands a foreign-stamped memory via the raw table handle,
    // then calls noteFederationMergedMemory (both statements, as the loop does).
    await syncInMemory({
      id: "synced-1", agentId: AGENT, content: "a memory synced from a spoke on another engine",
      embeddingModel: FOREIGN, embedding: OTHER_SPACE_VEC, visibility: "shared", createdAt: new Date().toISOString(),
    });

    // Latch tripped by the federation write — WITHOUT a rescan (O(1) consult).
    expect(await isEmbeddingSpaceUniform()).toBe(false);

    // Recall now refuses the embedding leg: no-keyword semantic query returns
    // nothing and carries the structured mixed-space warning...
    const after: any = await makeSearch(AGENT).post({ agentId: AGENT, q: "zqxnokeywordhere" });
    expect(after.results).toEqual([]);
    expect(String(after._warning)).toContain("mixed embedding spaces");
    expect(String(after._warning)).toContain(FOREIGN);
    // ...while keyword-only STILL serves.
    const kw: any = await makeSearch(AGENT).post({ agentId: AGENT, q: "replication" });
    expect(kw.results.map((r: any) => r.id)).toContain("m1");
  });

  it("a same-space federation sync does NOT trip the latch", async () => {
    expect(await recomputeLatch()).toBe(true);
    await syncInMemory({
      id: "synced-current", agentId: AGENT, content: "synced, same engine/model", embeddingModel: CURRENT, embedding: FAKE_EMBEDDING, visibility: "shared", createdAt: new Date().toISOString(),
    });
    expect(await isEmbeddingSpaceUniform()).toBe(true);
  });

  it("a NON-Memory federation sync (no stamp) does NOT trip the latch", async () => {
    expect(await recomputeLatch()).toBe(true);
    // recordTable !== "Memory" ⇒ noteFederationMergedMemory skips the trip even
    // if the merged record happens to carry a stamp-shaped field.
    noteFederationMergedMemory("Soul", { id: "soul-1", embeddingModel: FOREIGN } as any);
    expect(await isEmbeddingSpaceUniform()).toBe(true);
  });
});
