/**
 * memory-locked-provider-timeout-2478.test.ts — every embedding provider call a
 * Memory write makes while it holds the per-id write lock is refused if still
 * pending when the timeout callback runs, or if it settles after the bound:
 * 503 `memory_provider_timeout`, nothing written (flair#2478).
 *
 * Calls resources/Memory.ts put()/patch() against a mocked harper (same
 * technique as patch-refreshes-embedding-2466.test.ts), with the embeddings
 * module mocked to a stub that can be made to hang. The bound is lowered for the
 * test through the fault-injection gate (resources/memory-write-lock.ts,
 * FLAIR_MEMORY_LOCK_PROVIDER_TIMEOUT_MS), so a never-resolving stub is cut off
 * within this file's own bound instead of the production 20 s. This file owns its
 * harper + embeddings mock in its own process (test/unit-isolated/).
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { agentStore } from "../helpers/harper-mock.js";
import { createFakeReplayNonceTable } from "../helpers/fake-replay-store.ts";
import { memoryLockDouble } from "../helpers/memory-lock-double";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;
// Lower the provider bound for every path below. Without the gate the override
// is ignored and the production 20 s bound stands.
process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
process.env.FLAIR_MEMORY_LOCK_PROVIDER_TIMEOUT_MS = "50";

const FAKE_EMBEDDING = [1, 0, 0, 0];
/** The text handed to the engine, and a per-test override: a vector, null for a
 *  failing engine, or a never-resolving promise for a hung provider. */
let embedInputs: string[] = [];
let embedImpl: (text: string) => unknown = () => FAKE_EMBEDDING;

mock.module("../../resources/embeddings-provider.ts", () => ({
  getEmbedding: async (text: string, _inputType?: string) => {
    embedInputs.push(text);
    return embedImpl(text);
  },
  getMode: () => "local",
  getModelId: () => "mock-embedding-model",
  EMBEDDING_ENGINE: "gguf",
}));

function matchesCondition(record: any, cond: any): boolean {
  if (cond.operator && Array.isArray(cond.conditions)) {
    const r = cond.conditions.map((c: any) => matchesCondition(record, c));
    return cond.operator === "or" ? r.some(Boolean) : r.every(Boolean);
  }
  const v = record[cond.attribute];
  if (cond.comparator === "equals") return v === cond.value;
  if (cond.comparator === "not_equal") return v !== cond.value;
  return true;
}

let memoryStore: Map<string, any>;
let memoryGrants: any[];
let idCounter: number;

function memorySearchGen(query: any) {
  let records = Array.from(memoryStore.values());
  const conditions = Array.isArray(query) ? query : Array.isArray(query?.conditions) ? query.conditions : [];
  for (const cond of conditions) records = records.filter((r) => matchesCondition(r, cond));
  const limit = typeof query?.limit === "number" ? query.limit : undefined;
  const sliced = limit !== undefined ? records.slice(0, limit) : records;
  async function* gen() {
    for (const r of sliced) yield r;
  }
  return gen();
}

class BaseMemory {
  /** flair#2478: Memory PUT/PATCH refuse a store with no per-id lock; this
   *  double injects one (test/helpers/memory-lock-double.ts). */
  static primaryStore = memoryLockDouble();
  async post(content: any) {
    const id = content.id ?? `mock-${++idCounter}`;
    content.id = id;
    memoryStore.set(id, { ...content });
    return id;
  }
  getId() {
    return (this as any)._targetId;
  }
  async put(content: any) {
    const id = (this as any)._targetId ?? content.id ?? `mock-${++idCounter}`;
    const rec = { ...content, id };
    memoryStore.set(id, rec);
    return id;
  }
  async get(target?: any) {
    const id = typeof target === "string" ? target : target?.id ?? (this as any)._targetId;
    return memoryStore.get(id) ?? null;
  }
  async patch(content: any) {
    const id = content?.id ?? (this as any)._targetId;
    const merged = { ...(memoryStore.get(id) ?? {}), ...content };
    memoryStore.set(id, merged);
    return undefined;
  }
  search(query: any) {
    return memorySearchGen(query);
  }
  static async get(id: any) {
    return memoryStore.get(id) ?? null;
  }
  static async put(content: any, ctx?: any) {
    const rec = { ...content };
    const staged = ctx?.transaction?.open === 1 ? ctx.transaction.staged : undefined;
    if (Array.isArray(staged)) staged.push(rec);
    else memoryStore.set(content.id, rec);
    return rec;
  }
  static async post(content: any) {
    return new BaseMemory().post(content);
  }
  static async patch(content: any) {
    const id = content?.id;
    memoryStore.set(id, { ...(memoryStore.get(id) ?? {}), ...content });
    return undefined;
  }
  static search(query: any) {
    return memorySearchGen(query);
  }
}

const databasesMock = {
  flair: {
    Memory: BaseMemory,
    MemoryGrant: {
      search: (query: any) => {
        const conditions = Array.isArray(query?.conditions) ? query.conditions : [];
        let grants = memoryGrants.slice();
        for (const cond of conditions) grants = grants.filter((g) => matchesCondition(g, cond));
        async function* gen() {
          for (const g of grants) yield g;
        }
        return gen();
      },
    },
    Agent: {
      get: async (id: string) => agentStore.get(id) ?? null,
      search: async function* () {
        for (const a of agentStore.values()) yield a;
      },
    },
    Instance: {
      search: () => {
        async function* gen() {}
        return gen();
      },
    },
    ReplayNonce: createFakeReplayNonceTable(),
  },
};

mock.module("harper", () => ({
  databases: databasesMock,
  server: {
    getUser: async () => null,
    http: (_fn: any, _opts?: any) => {},
  },
  Resource: class {},
  RequestTarget: class {},
}));

// Harper assigns `transaction` onto the global at load; the Memory write path
// refuses to run a write unwrapped. Same stand-in memory-integrity.test.ts uses.
(globalThis as any).transaction = (ctx: any, cb: (txn: any) => any) => {
  if (ctx?.transaction && ctx.transaction.open === 1) return cb(ctx.transaction);
  const txn: any = {
    open: 1,
    saveCommits: false,
    staged: [] as any[],
    abort() {
      this.open = 0;
      this.staged = [];
    },
    commit() {
      this.open = 0;
      for (const rec of this.staged) memoryStore.set(rec.id, rec);
      this.staged = [];
    },
  };
  const c = ctx && typeof ctx === "object" ? ctx : {};
  c.transaction = txn;
  let r: any;
  try {
    r = cb(txn);
  } catch (e) {
    txn.abort();
    throw e;
  }
  if (r && typeof r.then === "function") {
    return r.then((v: any) => {
      txn.commit();
      return v;
    }, (e: any) => {
      txn.abort();
      throw e;
    });
  }
  txn.commit();
  return r;
};

const { Memory } = await import("../../resources/Memory.ts");

const AGENT = "agent-a";
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });

function makeMemory(ctxRequest: any) {
  const r: any = new (Memory as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
/** A Memory resource whose URL-bound target id is `targetId`. */
function memoryFor(id: string) {
  const r: any = makeMemory(agentCtx(AGENT));
  r._targetId = id;
  return r;
}

function seed(id: string, content: string): void {
  memoryStore.set(id, {
    id, agentId: AGENT, content, archived: false,
    embedding: [0.01, 0.02, 0.03], embeddingModel: "old-model",
    createdAt: new Date().toISOString(),
  });
}

/** A provider that never answers. */
const hangs = () => new Promise<never>(() => {});

beforeEach(() => {
  memoryStore = new Map();
  memoryGrants = [];
  idCounter = 0;
  embedInputs = [];
  embedImpl = () => FAKE_EMBEDDING;
  agentStore.clear();
});

describe("flair#2478 — a provider call under the id lock is bounded", () => {
  it("a PUT that regenerates a vector refuses 503 memory_provider_timeout, writes nothing, and releases the lock", async () => {
    seed("mem-put", "the stored text");
    embedImpl = hangs;
    const res: any = await memoryFor("mem-put").put({ content: "the edited text" });

    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("memory_provider_timeout");
    const stored = await (BaseMemory as any).get("mem-put");
    expect(stored.content).toBe("the stored text");
    expect(stored.embedding).toEqual([0.01, 0.02, 0.03]);

    // The lock was released: the same id writes normally once the provider answers.
    embedImpl = () => FAKE_EMBEDDING;
    await memoryFor("mem-put").put({ content: "the edited text" });
    expect((await (BaseMemory as any).get("mem-put")).content).toBe("the edited text");
  }, 10_000);

  it("a PUT regen whose provider blocks past the bound then resolves refuses 503, writes nothing, and releases the lock", async () => {
    seed("mem-put-blocked", "the stored text");
    const before = structuredClone(memoryStore.get("mem-put-blocked"));
    embedImpl = () => {
      const started = performance.now();
      while (performance.now() - started < 100) {}
      return FAKE_EMBEDDING;
    };
    const res: any = await memoryFor("mem-put-blocked").put({ content: "the edited text" });

    expect(embedInputs).toEqual(["the edited text"]);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("memory_provider_timeout");
    expect(memoryStore.get("mem-put-blocked")).toEqual(before);

    embedImpl = () => FAKE_EMBEDDING;
    const next: any = await memoryFor("mem-put-blocked").put({ content: "the edited text" });
    expect(next instanceof Response ? next.status : 200).toBeLessThan(300);
    expect(memoryStore.get("mem-put-blocked").content).toBe("the edited text");
    expect(memoryStore.get("mem-put-blocked").embedding).toEqual(FAKE_EMBEDDING);
  }, 10_000);

  it("a creating PUT whose dedup probe provider never answers refuses memory_provider_timeout and writes no row", async () => {
    embedImpl = hangs;
    const res: any = await memoryFor("mem-create").put({ content: "a brand new note long enough to embed" });

    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("memory_provider_timeout");
    expect(memoryStore.has("mem-create")).toBe(false);
  }, 10_000);

  it("a content-changing PATCH whose refresh provider never answers refuses memory_provider_timeout and writes nothing", async () => {
    seed("mem-refresh", "the stored text");
    embedImpl = hangs;
    const res: any = await memoryFor("mem-refresh").patch({ content: "the edited text" });

    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("memory_provider_timeout");
    const stored = await (BaseMemory as any).get("mem-refresh");
    expect(stored.content).toBe("the stored text");
    expect(stored.embedding).toEqual([0.01, 0.02, 0.03]);
  }, 10_000);

  it("a re-embed PATCH whose compute never answers refuses memory_provider_timeout and writes nothing", async () => {
    seed("mem-reembed", "the stored text");
    embedImpl = hangs;
    const res: any = await memoryFor("mem-reembed").patch({ embedding: null, embeddingModel: null });

    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("memory_provider_timeout");
    const stored = await (BaseMemory as any).get("mem-reembed");
    expect(stored.embedding).toEqual([0.01, 0.02, 0.03]);
    expect(stored.embeddingModel).toBe("old-model");
  }, 10_000);

  it("a re-embed PATCH whose recompute never answers refuses memory_provider_timeout and writes nothing", async () => {
    seed("mem-recompute", "the first text");
    const before = structuredClone(memoryStore.get("mem-recompute"));
    const calls: string[] = [];
    embedImpl = (text: string) => {
      calls.push(text);
      return calls.length === 1 ? FAKE_EMBEDDING : hangs();
    };
    const staticGet = BaseMemory.get;
    // Both reads in this path go through the static table reader: the first is
    // the verb's authoritative read, the second the re-embed attempt's own
    // in-transaction re-read. The second sees text an edit changed after the
    // first read, so the loop recomputes; that second provider call never answers.
    let reads = 0;
    BaseMemory.get = async (id: any) => {
      reads++;
      const row = memoryStore.get(id) ?? {};
      return reads === 1 ? row : { ...row, content: "the second text" };
    };
    try {
      const res: any = await memoryFor("mem-recompute").patch({ embedding: null, embeddingModel: null });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("memory_provider_timeout");
      expect(calls).toEqual(["the first text", "the second text"]);
      expect(memoryStore.get("mem-recompute")).toEqual(before);
    } finally {
      BaseMemory.get = staticGet;
    }
  }, 10_000);
});
