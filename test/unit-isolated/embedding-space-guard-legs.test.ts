/**
 * embedding-space-guard-legs.test.ts — the MUTATION TEST for the query-time
 * vector-space uniformity gate (embedding-provider-seam design §3, slice 1).
 *
 * Constructs a TWO-SPACE corpus and drives BOTH runtime cosine legs through
 * their REAL shipped code paths against a mocked harper (the same in-memory
 * technique as memory-integrity.test.ts / semantic-search-scoping.test.ts),
 * asserting the guard's single chokepoint (resources/embedding-space-guard.ts)
 * makes a cross-space cosine impossible on both:
 *   (a) the RECALL leg (resources/SemanticSearch.ts) REFUSES the embedding leg
 *       and degrades to keyword-only LOUDLY (structured mixed-space warning),
 *       while keyword-only STILL serves;
 *   (b) the WRITE-time dedup leg (resources/Memory.ts findConservativeDedupMatch)
 *       NO-OPS (treat as no-match) but NEVER suppresses the write;
 *   (c) after a re-embed converges the corpus, the gate REOPENS and both legs
 *       use embeddings again;
 *   (d) a uniform single-space corpus — INCLUDING today's BARE-name stamp —
 *       does NOT trip.
 *
 * WHY unit-isolated, not a real-Harper spawn: the gate's TRIP state is
 * transient by design — the always-on embedding-stamp migration converges a
 * mixed corpus to one space on the next boot, so a real-Harper end-to-end test
 * cannot hold a two-space corpus deterministically (the migration "fixes" it,
 * or there is no runtime recompute trigger for a live ops-API insert). Driving
 * the SHIPPED SemanticSearch.post() / Memory.post() against a controlled
 * two-space corpus is the faithful, deterministic way to exercise both legs +
 * the latch. Runs in its own process so `mock.module` never races another file.
 *
 * To confirm it FAILS ON UNFIXED (the mutation): make
 * resources/embedding-space-guard.ts's isEmbeddingSpaceUniform() always return
 * true (or delete either leg's guard consult) and re-run — the (a)/(b) tripped
 * assertions go red.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
process.env.FLAIR_HYBRID_RETRIEVAL = "false"; // legacy HNSW-only path — no BM25 index service to stand up
delete (process.env as any).FLAIR_PUBLIC;

const CURRENT = "gguf:nomic-embed-text-v1.5-Q4_K_M+searchprefix";
const BARE = "nomic-embed-text-v1.5-Q4_K_M+searchprefix"; // today's corpus stamp — SAME space as CURRENT
const FOREIGN = "gemma-embed:768"; // a genuinely different vector space

// Constant embedding ⇒ raw cosine is ALWAYS 1.0 between any two docs (isolates
// the dedup lexical gate; makes a semantic-only recall query match by cosine).
// Same deliberate device as memory-integrity.test.ts.
const FAKE_EMBEDDING = [1, 0, 0, 0];
const OTHER_SPACE_VEC = [0, 1, 0, 0]; // stored on the FOREIGN row (never cosined once the gate trips)

mock.module("../../resources/embeddings-provider.ts", () => ({
  getEmbedding: async (_text: string, _inputType?: string) => FAKE_EMBEDDING,
  getMode: () => "local",
  getModelId: () => CURRENT,
  EMBEDDING_ENGINE: "gguf",
}));

// ─── In-memory Harper mock (Memory table class + grants) ─────────────────────
function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function matchesCondition(record: any, cond: any): boolean {
  if (cond.operator && Array.isArray(cond.conditions)) {
    const results = cond.conditions.map((c: any) => matchesCondition(record, c));
    return cond.operator === "or" ? results.some(Boolean) : results.every(Boolean);
  }
  const fieldVal = record[cond.attribute];
  if (cond.comparator === "equals") return fieldVal === cond.value;
  if (cond.comparator === "not_equal" || cond.comparator === "not_equals") return fieldVal !== cond.value;
  return true;
}

let memoryStore: Map<string, any>;
let memoryGrants: any[];
let idCounter = 0;

function memorySearchGen(query: any) {
  const conditions = Array.isArray(query) ? query : Array.isArray(query?.conditions) ? query.conditions : [];
  let records = Array.from(memoryStore.values());
  for (const cond of conditions) records = records.filter((r) => matchesCondition(r, cond));
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
  async post(content: any) {
    const id = content.id ?? `mock-${++idCounter}`;
    content.id = id;
    memoryStore.set(id, { ...content });
    return id;
  }
  async put(content: any) { memoryStore.set(content.id, { ...content }); return undefined; }
  async get(target: any) {
    const id = typeof target === "string" ? target : target?.id;
    return memoryStore.get(id) ?? null;
  }
  search(query: any) { return memorySearchGen(query); }
  static async get(id: any) { return memoryStore.get(id) ?? null; }
  static async put(content: any) { const rec = { ...content }; memoryStore.set(content.id, rec); return rec; }
  static search(query: any) { return memorySearchGen(query); }
}

const databasesMock = {
  flair: {
    Memory: BaseMemory,
    MemoryGrant: {
      search: (query: any) => {
        const conditions = Array.isArray(query?.conditions) ? query.conditions : [];
        let grants = memoryGrants.slice();
        for (const cond of conditions) grants = grants.filter((g) => matchesCondition(g, cond));
        async function* gen() { for (const g of grants) yield g; }
        return gen();
      },
    },
    Agent: { get: async () => null, search: async () => [] },
    Instance: { search: () => { async function* gen() { /* never-federated: no local instance row */ } return gen(); } },
  },
};

mock.module("harper", () => ({ databases: databasesMock, Resource: class {}, server: { getUser: async () => null } }));

const { Memory } = await import("../../resources/Memory.ts");
const { SemanticSearch } = await import("../../resources/SemanticSearch.ts");
const { recomputeLatch, isEmbeddingSpaceUniform, _resetGuardForTests } = await import("../../resources/embedding-space-guard.ts");
const { _resetLocalInstanceIdCacheForTests } = await import("../../resources/instance-identity.ts");

const AGENT = "agent-me";
const OTHER = "agent-other";

function makeMemory(agentId: string) {
  const r: any = new (Memory as any)();
  r.getContext = () => ({ request: { tpsAgent: agentId, tpsAgentIsAdmin: false } });
  return r;
}
function makeSearch(agentId: string) {
  const r: any = new (SemanticSearch as any)();
  r.getContext = () => ({ request: { tpsAgent: agentId, tpsAgentIsAdmin: false } });
  return r;
}

// Two findings that share substance (a true near-duplicate pair — high lexical
// overlap), so the dedup co-gate fires when the space is uniform.
const FINDING = "Federation replication direction is governed by a per-pair sends and receives knob in the pairing config.";
const FINDING_REWORDED = "Federation replication direction is controlled by a per-pair sends and receives knob inside the pairing configuration.";

function seedRow(id: string, agentId: string, content: string, embeddingModel: string, embedding: number[]) {
  memoryStore.set(id, { id, agentId, content, embeddingModel, embedding, visibility: "shared", createdAt: new Date().toISOString() });
}

beforeEach(() => {
  memoryStore = new Map();
  memoryGrants = [];
  idCounter = 0;
  _resetLocalInstanceIdCacheForTests();
  _resetGuardForTests(); // default table getter reads databasesMock; default modelId getter is the mocked CURRENT
});

describe("embedding-space-guard — both runtime legs (mutation test)", () => {
  it("(d) a uniform corpus — including today's BARE-name stamp — does NOT trip", async () => {
    seedRow("m1", AGENT, FINDING, BARE, FAKE_EMBEDDING); // bare == gguf: space
    seedRow("m2", AGENT, "another unrelated bare-stamped note about zebras", BARE, FAKE_EMBEDDING);
    expect(await recomputeLatch()).toBe(true);
    expect(await isEmbeddingSpaceUniform()).toBe(true);

    // recall: a no-keyword query still matches by embedding (leg RAN), no warning
    const res: any = await makeSearch(AGENT).post({ agentId: AGENT, q: "zqxnokeywordhere" });
    expect(res.results.map((r: any) => r.id)).toContain("m1");
    expect(res._warning).toBeUndefined();

    // dedup: a true near-dup IS flagged (leg RAN)
    const w: any = await makeMemory(AGENT).post({ agentId: AGENT, content: FINDING_REWORDED });
    expect(w.written).toBe(true);
    expect(w.deduplicated).toBe(true);
  });

  it("(a) a mixed-space corpus makes the RECALL embedding leg REFUSE → keyword-only, loudly", async () => {
    seedRow("m1", AGENT, FINDING, CURRENT, FAKE_EMBEDDING);
    seedRow("f1", OTHER, "a foreign-space finding", FOREIGN, OTHER_SPACE_VEC);
    expect(await recomputeLatch()).toBe(false);

    // no-keyword semantic query: embedding leg refused ⇒ keyword-only ⇒ nothing
    // matches, and the warning names both spaces + the remedy.
    const semantic: any = await makeSearch(AGENT).post({ agentId: AGENT, q: "zqxnokeywordhere" });
    expect(semantic.results).toEqual([]);
    expect(String(semantic._warning)).toContain("mixed embedding spaces");
    expect(String(semantic._warning)).toContain("flair reembed");
    expect(String(semantic._warning)).toContain(FOREIGN);

    // (a, cont.) keyword-only STILL serves: a query whose term is in the content
    // returns the row even while the embedding leg is refused.
    const keyword: any = await makeSearch(AGENT).post({ agentId: AGENT, q: "replication" });
    expect(keyword.results.map((r: any) => r.id)).toContain("m1");
  });

  it("(b) a mixed-space corpus makes the WRITE-time dedup leg NO-OP (never suppresses the write)", async () => {
    seedRow("m1", AGENT, FINDING, CURRENT, FAKE_EMBEDDING);
    seedRow("f1", OTHER, "a foreign-space finding", FOREIGN, OTHER_SPACE_VEC);
    expect(await recomputeLatch()).toBe(false);

    // A write that WOULD be a near-dup of m1 when uniform: the dedup cosine leg
    // no-ops (deduplicated:false) but the write STILL lands (written:true).
    const w: any = await makeMemory(AGENT).post({ agentId: AGENT, content: FINDING_REWORDED });
    expect(w.written).toBe(true);
    expect(w.deduplicated).toBe(false);
  });

  it("(c) after a re-embed converges the corpus, the gate REOPENS and both legs use embeddings again", async () => {
    seedRow("m1", AGENT, FINDING, CURRENT, FAKE_EMBEDDING);
    seedRow("f1", OTHER, "a foreign-space finding", FOREIGN, OTHER_SPACE_VEC);
    expect(await recomputeLatch()).toBe(false);

    // Re-embed: rewrite the foreign row into the current space.
    memoryStore.set("f1", { ...memoryStore.get("f1"), embeddingModel: CURRENT, embedding: FAKE_EMBEDDING });
    expect(await recomputeLatch()).toBe(true); // "re-embed completion clears it"

    // recall embedding leg works again (no mixed-space warning)
    const res: any = await makeSearch(AGENT).post({ agentId: AGENT, q: "zqxnokeywordhere" });
    expect(res.results.map((r: any) => r.id)).toContain("m1");
    expect(res._warning).toBeUndefined();

    // dedup leg active again
    const w: any = await makeMemory(AGENT).post({ agentId: AGENT, content: FINDING_REWORDED });
    expect(w.written).toBe(true);
    expect(w.deduplicated).toBe(true);
  });
});
