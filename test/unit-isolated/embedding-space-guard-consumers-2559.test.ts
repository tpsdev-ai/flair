/**
 * embedding-space-guard-consumers-2559.test.ts — flair#2559.
 *
 * The remaining request and maintenance paths covered by #2559 now consult the query-time
 * embedding-space guard (resources/embedding-space-guard.ts) with the same
 * policy SemanticSearch and the write-time dedup leg use:
 *   (a) MemoryBootstrap's task-relevant selection REFUSES its task embedding on
 *       a non-uniform verdict, degrades to its non-vector (lexical) selection
 *       and surfaces the SAME state-named warning SemanticSearch emits;
 *   (b) MemoryDedupStats returns NO vector-derived counts (never numbers
 *       computed across spaces) and names the guard state in the response.
 *
 * Both consumers run in this file's process against a Map-backed Harper mock for
 * uniform, mixed and unknown verdicts. Boot stamp migration converges a seeded
 * mixed corpus; the integration tests apply a foreign stamp after boot.
 *
 * Mutation check: delete either consumer's guard consult (the
 * embeddingSpaceVerdict() block in resources/MemoryBootstrap.ts /
 * resources/MemoryDedupStats.ts) and the mixed/unknown assertions go red: the
 * bootstrap warning disappears and the dedup counts come back non-null.
 */
import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSandboxHome } from "../helpers/sandbox-home";

const statsHome = createSandboxHome("flair-2559-home-");
afterAll(statsHome.cleanup);
const statsPath = join(statsHome.dir, ".flair", "rem-dedup-stats.json");
const dedupCluster = await import("../../resources/dedup-cluster.ts");
mock.module("../../resources/dedup-cluster.ts", () => ({
  ...dedupCluster,
  REM_DEDUP_STATS_PATH: statsPath,
}));
process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
process.env.FLAIR_RETRIEVAL_MODE = "vector-only";
delete (process.env as any).FLAIR_PUBLIC;

const CURRENT = "gguf:nomic-embed-text-v1.5-Q4_K_M+searchprefix";
const FOREIGN = "gemma-embed:768"; // a genuinely different vector space
const FAKE_EMBEDDING = [1, 0, 0, 0];
const OTHER_SPACE_VEC = [0, 1, 0, 0];

mock.module("../../resources/embeddings-provider.ts", () => ({
  getEmbedding: async () => FAKE_EMBEDDING,
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
  static search(query: any) { return memorySearchGen(query); }
}

/** A table that yields nothing. */
function emptyTable() {
  return {
    search: () => { async function* gen() {} return gen(); },
    get: async () => null,
  };
}

const flairTables: Record<string, any> = {
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
  Agent: emptyTable(),
  Instance: emptyTable(),
};
const flair = new Proxy(flairTables, {
  get(target: Record<string, any>, prop: string) {
    return prop in target ? target[prop] : emptyTable();
  },
});
const databasesMock = { flair };

mock.module("harper", () => ({ databases: databasesMock, Resource: class {}, server: { getUser: async () => null } }));

const { BootstrapMemories } = await import("../../resources/MemoryBootstrap.ts");
const { SemanticSearch } = await import("../../resources/SemanticSearch.ts");
const { MemoryDedupStats } = await import("../../resources/MemoryDedupStats.ts");
const { recomputeLatch, _resetGuardForTests, _setGuardTableGetterForTests } = await import("../../resources/embedding-space-guard.ts");
const { _resetLocalInstanceIdCacheForTests } = await import("../../resources/instance-identity.ts");

const AGENT = "agent-a";
const OTHER = "agent-b";
const OLD = new Date(Date.now() - 90 * 24 * 3600_000).toISOString(); // outside every recent window

function makeBootstrap(agentId: string) {
  const r: any = new (BootstrapMemories as any)();
  r.getContext = () => ({ request: { tpsAgent: agentId, tpsAgentIsAdmin: false } });
  return r;
}
function makeDedup() {
  const r: any = new (MemoryDedupStats as any)();
  r.getContext = () => ({});
  return r;
}

/** A non-permanent, old, own row: NOT loaded by any lifecycle section
 *  (permanent/recent/predicted), so it can only reach the payload through the
 *  task-relevant (semantic) path — which is what the guard governs. */
function seedReachableRow(id: string, agentId: string, content: string, embeddingModel: string, embedding: number[]) {
  memoryStore.set(id, {
    id, agentId, content, embeddingModel, embedding,
    durability: "persistent", visibility: "shared", createdAt: OLD, updatedAt: OLD,
  });
}

beforeEach(() => {
  memoryStore = new Map();
  memoryGrants = [];
  idCounter = 0;
  mkdirSync(dirname(statsPath), { recursive: true });
  writeFileSync(statsPath, "prior stat\n");
  _resetLocalInstanceIdCacheForTests();
  _resetGuardForTests(); // default table getter reads databasesMock; default modelId getter is the mocked CURRENT
});

// flair#1940: the Memory write path expects the global `transaction` helper.
(globalThis as any).transaction = (ctx: any, cb: (txn: any) => any) => {
  if (ctx?.transaction && ctx.transaction.open === 1) return cb(ctx.transaction);
  const txn: any = { open: 1, saveCommits: false, abort() { this.open = 0; }, commit() { this.open = 0; } };
  const c = ctx && typeof ctx === "object" ? ctx : {};
  c.transaction = txn;
  let r: any;
  try { r = cb(txn); } catch (e) { txn.abort(); throw e; }
  if (r && typeof r.then === "function") {
    return r.then((v: any) => { txn.commit(); return v; }, (e: any) => { txn.abort(); throw e; });
  }
  txn.commit();
  return r;
};

describe("MemoryBootstrap's task-relevant selection consults the guard (flair#2559)", () => {
  it("(uniform) uses the embedding leg and adds no warning", async () => {
    seedReachableRow("m1", AGENT, "the federation replication knob", CURRENT, FAKE_EMBEDDING);
    expect(await recomputeLatch()).toBe(true);

    // No keyword overlap with the row, so only the embedding leg can reach it.
    const res: any = await makeBootstrap(AGENT).post({ agentId: AGENT, currentTask: "zqxnokeyword" });
    expect(res.memories.map((m: any) => m.id)).toContain("m1");
    expect(res._warning).toBeUndefined();
  });

  it("(mixed) refuses the embedding leg, selects lexically and names the state", async () => {
    seedReachableRow("m1", AGENT, "the federation replication knob", CURRENT, FAKE_EMBEDDING);
    memoryStore.set("f1", {
      id: "f1", agentId: OTHER, content: "a foreign-space finding", embeddingModel: FOREIGN,
      embedding: OTHER_SPACE_VEC, durability: "persistent", visibility: "shared", createdAt: OLD, updatedAt: OLD,
    });
    expect(await recomputeLatch()).toBe(false);

    // No-keyword task: the refused embedding leg leaves the lexical leg, which
    // matches nothing ⇒ the row is dropped and the warning names both spaces.
    const semantic: any = await makeBootstrap(AGENT).post({ agentId: AGENT, currentTask: "zqxnokeyword" });
    expect(semantic.memories.map((m: any) => m.id)).not.toContain("m1");
    expect(String(semantic._warning)).toContain("non-current embedding model stamp was observed");
    expect(String(semantic._warning)).toContain("flair reembed");
    expect(String(semantic._warning)).toContain(FOREIGN);

    // A task whose term IS in the content still reaches the row lexically.
    const keyword: any = await makeBootstrap(AGENT).post({ agentId: AGENT, currentTask: "replication" });
    expect(keyword.memories.map((m: any) => m.id)).toContain("m1");
  });

  it("(unknown) fails closed with the not-yet-verified warning", async () => {
    seedReachableRow("m1", AGENT, "the federation replication knob", CURRENT, FAKE_EMBEDDING);
    // beforeEach reset the guard: no scan has reached a verdict yet. The
    // task-relevant consult is the first, so it must fail closed.
    const res: any = await makeBootstrap(AGENT).post({ agentId: AGENT, currentTask: "zqxnokeyword" });
    expect(res.memories.map((m: any) => m.id)).not.toContain("m1");
    expect(String(res._warning)).toContain("embedding space not yet verified");
    expect(String(res._warning)).not.toContain("non-current embedding model stamp was observed");
  });

  it.each(["mixed", "unverified", "scan-failed"])("(%s) retrieves separated task terms in vector-only mode", async (state) => {
    seedReachableRow("m1", AGENT, "federation replication direction", CURRENT, FAKE_EMBEDDING);
    if (state === "mixed") {
      seedReachableRow("f1", OTHER, "foreign-space finding", FOREIGN, OTHER_SPACE_VEC);
      expect(await recomputeLatch()).toBe(false);
    } else if (state === "scan-failed") {
      _setGuardTableGetterForTests(async () => { throw new Error("scan unavailable"); });
      expect(await recomputeLatch()).toBe(false);
    }

    const res: any = await makeBootstrap(AGENT).post({ agentId: AGENT, currentTask: "federation direction" });
    expect(res.memories).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "m1", section: "relevant" }),
    ]));
    expect(res._warning).toBeTruthy();
  });
});

describe("SemanticSearch's guarded vector-only retrieval", () => {
  it("retrieves separated query terms on a mixed verdict", async () => {
    seedReachableRow("m1", AGENT, "federation replication direction", CURRENT, FAKE_EMBEDDING);
    seedReachableRow("f1", OTHER, "foreign-space finding", FOREIGN, OTHER_SPACE_VEC);
    expect(await recomputeLatch()).toBe(false);
    const search: any = new (SemanticSearch as any)();
    search.getContext = () => ({ request: { tpsAgent: AGENT, tpsAgentIsAdmin: false } });

    const res: any = await search.post({ agentId: AGENT, q: "federation direction" });
    expect(res.results.map((r: any) => r.id)).toContain("m1");
    expect(String(res._warning)).toContain("non-current embedding model stamp was observed");
  });
});

describe("MemoryDedupStats consults the guard (flair#2559)", () => {
  it("(uniform) returns the vector-derived counts", async () => {
    seedReachableRow("m1", AGENT, "alpha", CURRENT, FAKE_EMBEDDING);
    seedReachableRow("m2", AGENT, "beta", CURRENT, FAKE_EMBEDDING);
    seedReachableRow("m3", AGENT, "gamma", CURRENT, FAKE_EMBEDDING);
    expect(await recomputeLatch()).toBe(true);

    const res: any = await makeDedup().post({});
    expect(res.clusterCount).toBe(1);
    expect(res.largestClusterSize).toBe(3);
    expect(res.totalMemoriesInClusters).toBe(3);
    expect(res.embeddingSpace).toBeUndefined();
  });

  it("(mixed) returns no counts and names the state", async () => {
    seedReachableRow("m1", AGENT, "alpha", CURRENT, FAKE_EMBEDDING);
    seedReachableRow("m2", AGENT, "beta", CURRENT, FAKE_EMBEDDING);
    memoryStore.set("f1", {
      id: "f1", agentId: OTHER, content: "a foreign-space finding", embeddingModel: FOREIGN,
      embedding: OTHER_SPACE_VEC, durability: "persistent", visibility: "shared", createdAt: OLD, updatedAt: OLD,
    });
    expect(await recomputeLatch()).toBe(false);

    const res: any = await makeDedup().post({});
    expect(res.clusterCount).toBeNull();
    expect(res.largestClusterSize).toBeNull();
    expect(res.totalMemoriesInClusters).toBeNull();
    expect(res.embeddingSpace).toEqual({ state: "mixed", reason: null });
    expect(readFileSync(statsPath, "utf8")).toBe("prior stat\n");
  });

  it("(unknown) returns no counts and names the not-yet-verified state", async () => {
    seedReachableRow("m1", AGENT, "alpha", CURRENT, FAKE_EMBEDDING);
    seedReachableRow("m2", AGENT, "beta", CURRENT, FAKE_EMBEDDING);
    // No scan has reached a verdict yet (beforeEach reset).
    const res: any = await makeDedup().post({});
    expect(res.clusterCount).toBeNull();
    expect(res.embeddingSpace?.state).toBe("unverified");
    expect(res.embeddingSpace?.reason).toBeNull();
    expect(readFileSync(statsPath, "utf8")).toBe("prior stat\n");
  });

  it("(scan-failed) returns no counts and leaves the stat file unchanged", async () => {
    _setGuardTableGetterForTests(async () => { throw new Error("scan unavailable"); });
    expect(await recomputeLatch()).toBe(false);

    const res: any = await makeDedup().post({});
    expect(res.clusterCount).toBeNull();
    expect(res.largestClusterSize).toBeNull();
    expect(res.totalMemoriesInClusters).toBeNull();
    expect(res.embeddingSpace?.state).toBe("scan-failed");
    expect(res.embeddingSpace?.reason).toBeTruthy();
    expect(readFileSync(statsPath, "utf8")).toBe("prior stat\n");
  });
});
