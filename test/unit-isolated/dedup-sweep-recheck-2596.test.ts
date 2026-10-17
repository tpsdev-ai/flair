/**
 * Exercises the pre-persist guard recheck against a Map-backed Harper mock.
 * Calls `noteWriteStamp` mid-sweep to simulate a guard trip and reads back
 * the temporary stat file to check that it is unchanged.
 */
import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSandboxHome } from "../helpers/sandbox-home";

const statsHome = createSandboxHome("flair-2596-home-");
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
let sweepSearchCalls = 0;

/** One-shot guard trip after the first row a Memory.search generator yields. */
let tripAfterFirstScanRow: (() => void) | undefined;

function memorySearchGen(query: any) {
  if (query?.select?.includes("embedding")) sweepSearchCalls++;
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
  const trip = () => {
    const fire = tripAfterFirstScanRow;
    if (fire) { tripAfterFirstScanRow = undefined; fire(); }
  };
  async function* gen() {
    let first = true;
    for (const r of sliced) {
      yield r;
      if (first) { first = false; trip(); }
    }
  }
  return gen();
}

class BaseMemory {
  async post(content: any) {
    const id = content.id ?? "mock";
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

function emptyTable() {
  return { search: () => { async function* gen() {} return gen(); }, get: async () => null };
}

const flairTables: Record<string, any> = {
  Memory: BaseMemory,
  Agent: emptyTable(),
  Instance: emptyTable(),
};
const flair = new Proxy(flairTables, {
  get(target: Record<string, any>, prop: string) { return prop in target ? target[prop] : emptyTable(); },
});
mock.module("harper", () => ({ databases: { flair }, Resource: class {}, server: { getUser: async () => null } }));

const guard = await import("../../resources/embedding-space-guard.ts");
const realEmbeddingSpaceVerdict = guard.embeddingSpaceVerdict;
let tripOnVerdict = 0;
let verdictCalls = 0;
mock.module("../../resources/embedding-space-guard.ts", () => ({
  ...guard,
  embeddingSpaceVerdict: () => {
    const verdict = realEmbeddingSpaceVerdict();
    if (++verdictCalls === tripOnVerdict) queueMicrotask(() => guard.noteWriteStamp(FOREIGN));
    return verdict;
  },
}));
const { MemoryDedupStats } = await import("../../resources/MemoryDedupStats.ts");
const { createGraphHealMigration } = await import("../../resources/migrations/graph-heal.ts");
const { noteWriteStamp, recomputeLatch, _resetGuardForTests } = guard;

const AGENT = "agent-a";
const OLD = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();

function makeDedup() {
  const r: any = new (MemoryDedupStats as any)();
  r.getContext = () => ({});
  return r;
}

function seedRow(id: string, content: string) {
  memoryStore.set(id, {
    id, agentId: AGENT, content, embeddingModel: CURRENT, embedding: FAKE_EMBEDDING,
    durability: "persistent", visibility: "shared", createdAt: OLD, updatedAt: OLD,
  });
}

beforeEach(() => {
  memoryStore = new Map();
  sweepSearchCalls = 0;
  tripAfterFirstScanRow = undefined;
  tripOnVerdict = 0;
  verdictCalls = 0;
  mkdirSync(dirname(statsPath), { recursive: true });
  writeFileSync(statsPath, "prior stat\n");
  _resetGuardForTests(); // default table getter reads databasesMock; default modelId getter is the mocked CURRENT
});

describe("MemoryDedupStats re-checks the verdict before persisting (flair#2596)", () => {
  it("a pending boot scan keeps counts null after graph-heal consults the guard", async () => {
    seedRow("m1", "alpha");
    let releaseScan!: () => void;
    let enteredScan!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseScan = resolve; });
    const entered = new Promise<void>((resolve) => { enteredScan = resolve; });
    let tableCalls = 0;
    guard._setGuardTableGetterForTests(async () => {
      if (++tableCalls === 1) {
        enteredScan();
        await blocked;
      }
      return BaseMemory;
    });
    guard.scheduleSpaceGuardPrewarm();
    await entered;
    try {
      expect(await createGraphHealMigration().detect()).toBe(false);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(guard.spaceGuardState().state).toBe("unverified");
      expect(tableCalls).toBe(1);
      const res: any = await makeDedup().post({});
      expect(res.clusterCount).toBeNull();
      expect(res.largestClusterSize).toBeNull();
      expect(res.totalMemoriesInClusters).toBeNull();
      expect(res.embeddingSpace).toEqual({ state: "unverified", reason: null });
      expect(sweepSearchCalls).toBe(0);
      expect(readFileSync(statsPath, "utf8")).toBe("prior stat\n");
    } finally {
      releaseScan();
      await guard._prewarmSettledForTests({ FLAIR_ENABLE_TEST_FAULT_INJECTION: "1" });
    }
  });

  it("(control) a sweep with no intervening write persists the counts", async () => {
    seedRow("m1", "alpha");
    seedRow("m2", "beta");
    seedRow("m3", "gamma");
    expect(await recomputeLatch()).toBe(true);

    const res: any = await makeDedup().post({});
    expect(typeof res.clusterCount).toBe("number");
    expect(res.embeddingSpace).toBeUndefined();
    expect(JSON.parse(readFileSync(statsPath, "utf8")).clusterCount).toBe(res.clusterCount);
  });

  it("a guard trip while awaiting the final verdict leaves the stat file unchanged", async () => {
    seedRow("m1", "alpha");
    expect(await recomputeLatch()).toBe(true);
    tripOnVerdict = 2;

    const res: any = await makeDedup().post({});
    expect(verdictCalls).toBe(2);
    expect(res.clusterCount).toBeNull();
    expect(res.largestClusterSize).toBeNull();
    expect(res.totalMemoriesInClusters).toBeNull();
    expect(res.embeddingSpace).toEqual({ state: "mixed", reason: null });
    expect(readFileSync(statsPath, "utf8")).toBe("prior stat\n");
  });

  it("a simulated guard trip during the sweep leaves the stat file unchanged and names the state", async () => {
    seedRow("m1", "alpha");
    seedRow("m2", "beta");
    seedRow("m3", "gamma");
    // The sweep's opening consult sees a uniform store.
    expect(await recomputeLatch()).toBe(true);

    // Trip the write-maintained latch after the sweep has begun loading.
    tripAfterFirstScanRow = () => noteWriteStamp(FOREIGN);

    const res: any = await makeDedup().post({});
    expect(res.clusterCount).toBeNull();
    expect(res.largestClusterSize).toBeNull();
    expect(res.totalMemoriesInClusters).toBeNull();
    expect(res.embeddingSpace).toEqual({ state: "mixed", reason: null });
    // Nothing persisted: the pre-existing stat file is untouched.
    expect(readFileSync(statsPath, "utf8")).toBe("prior stat\n");
  });
});
