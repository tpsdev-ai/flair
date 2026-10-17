/**
 * patch-refreshes-embedding-2466.test.ts — ordinary PATCH embedding cases (flair#2466).
 *
 * Calls resources/Memory.ts patch() directly against a mocked harper (same
 * technique as memory-write-redaction-2407.test.ts). The real-Harper counterpart,
 * including semantic search, the overlapping-edit cases and an actual embedding
 * backend failure, is test/integration/patch-refreshes-embedding-2466.test.ts.
 *
 * These non-re-embed cases cover changed `content` with `embedding` absent after
 * redaction, retention when unchanged/absent `content` accompanies an omitted or
 * redaction-removed `embedding`, and storage of a surviving supplied vector as
 * supplied. An engine returning no vector for changed text yields null
 * embedding/embeddingModel. This file owns its harper + embeddings mock in its
 * own process (test/unit-isolated/).
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { agentStore, middlewareCapture } from "../helpers/harper-mock.js";
import { createFakeReplayNonceTable } from "../helpers/fake-replay-store.ts";
import { memoryLockDouble } from "../helpers/memory-lock-double";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

const FAKE_EMBEDDING = [1, 0, 0, 0];
// Records the exact text handed to the embedding engine.
let embedInputs: string[] = [];
// Per-test override: return a vector, or null to model an engine that fails.
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
    return undefined; // real Table.patch returns undefined on the standard path
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
    http: (fn: any, _opts?: any) => {
      middlewareCapture.value = fn;
    },
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

function makeMemory(ctxRequest: any) {
  const r: any = new (Memory as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
/** A Memory resource whose URL-bound target id is `targetId` (patch() reads it). */
function memoryFor(id: string) {
  const r: any = makeMemory(agentCtx(AGENT));
  r._targetId = id;
  return r;
}
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });

beforeEach(() => {
  memoryStore = new Map();
  memoryGrants = [];
  idCounter = 0;
  embedInputs = [];
  embedImpl = () => FAKE_EMBEDDING;
  agentStore.clear();
});

const AGENT = "agent-a";
const SLACK_TOKEN = `xoxb-${"c".repeat(12)}`;
const REDACTED = "[redacted]";

function seed(id: string, content: string): void {
  memoryStore.set(id, {
    id, agentId: AGENT, content, archived: false,
    embedding: [0.01, 0.02, 0.03], embeddingModel: "old-model",
    createdAt: new Date().toISOString(),
  });
}

describe("flair#2466 — ordinary PATCH embedding cases", () => {
  it("a redacting PATCH of content with no vector computes the REDACTED text's vector", async () => {
    seed("mem-1", "the deploy checklist before the patch");
    const m = memoryFor("mem-1");
    const res: any = await m.patch({ content: `notify via ${SLACK_TOKEN}` });

    const stored = await (BaseMemory as any).get("mem-1");
    expect(stored.content).toBe(`notify via ${REDACTED}`);
    expect(stored.embedding).toEqual(FAKE_EMBEDDING);
    expect(stored.embeddingModel).toBe("mock-embedding-model");
    // The engine was handed the REDACTED text, in exactly one document embed.
    expect(embedInputs).toEqual([`notify via ${REDACTED}`]);
    expect(res).toBeDefined();
  });

  it("a summary-only PATCH keeps the vector and embeds nothing", async () => {
    seed("mem-2", "a note whose vector survives a summary edit");
    const m = memoryFor("mem-2");
    await m.patch({ summary: "an edited summary with no credential" });

    const stored = await (BaseMemory as any).get("mem-2");
    expect(stored.summary).toBe("an edited summary with no credential");
    expect(stored.embedding).toEqual([0.01, 0.02, 0.03]);
    expect(stored.embeddingModel).toBe("old-model");
    expect(embedInputs).toEqual([]);
  });

  it("a PATCH that supplies a vector stores it and embeds nothing", async () => {
    seed("mem-3", "a note replaced by a supplied vector");
    const m = memoryFor("mem-3");
    await m.patch({ content: "the replacement text", embedding: [0.5, 0.25, 0.125] });

    const stored = await (BaseMemory as any).get("mem-3");
    expect(stored.content).toBe("the replacement text");
    expect(stored.embedding).toEqual([0.5, 0.25, 0.125]);
    expect(embedInputs).toEqual([]);
  });

  for (const pairedNulls of [false, true]) {
    it(`a content-changing PATCH with explicit null embedding clears it (null model: ${pairedNulls})`, async () => {
      seed("mem-null", "the earlier text");
      const body: Record<string, unknown> = { content: "the replacement text", embedding: null };
      if (pairedNulls) body.embeddingModel = null;
      await memoryFor("mem-null").patch(body);

      const stored = await BaseMemory.get("mem-null");
      expect(stored.content).toBe("the replacement text");
      expect(stored.embedding).toBeNull();
      expect(stored.embeddingModel).toBe(pairedNulls ? null : "old-model");
      expect(stored.updatedAt).toBeUndefined();
      expect(embedInputs).toEqual([]);
    });
  }

  it("an ordinary PATCH with explicit null embedding skips the committed-row embedding check", async () => {
    seed("mem-null-reread", "the unchanged text");
    const get = BaseMemory.get;
    let tableReads = 0;
    BaseMemory.get = async (id: any) => {
      tableReads++;
      const stored = await get(id);
      // Reads 1 and 2 belong to the patch itself: the pre-write resolve (1) and
      // the post-commit verification read (2, flair#2478). A THIRD read would be
      // the conditional committed-row embedding check this case skips; hand it
      // the concurrent edit so the case stays discriminating.
      return tableReads <= 2 ? stored : { ...stored, content: "a concurrent edit" };
    };
    try {
      await memoryFor("mem-null-reread").patch({ content: "the unchanged text", embedding: null });
      expect(tableReads).toBe(2);
      const stored = await get("mem-null-reread");
      expect(stored.content).toBe("the unchanged text");
      expect(stored.embedding).toBeNull();
      expect(stored.embeddingModel).toBe("old-model");
      expect(embedInputs).toEqual([]);
    } finally {
      BaseMemory.get = get;
    }
  });

  it("a trigger-only PATCH without embedding fields keeps the vector and embeds nothing", async () => {
    seed("mem-5", "an ordinary note; its trigger does not feed its vector");
    const m = memoryFor("mem-5");
    await m.patch({ trigger: "when the deploy job fails" });

    const stored = await (BaseMemory as any).get("mem-5");
    expect(stored.trigger).toBe("when the deploy job fails");
    expect(stored.embedding).toEqual([0.01, 0.02, 0.03]);
    expect(stored.embeddingModel).toBe("old-model");
    expect(stored.updatedAt).toBeUndefined();
    expect(embedInputs).toEqual([]);
  });

  it("a trigger-only PATCH whose supplied vector redaction removes keeps the stored vector and embeds nothing", async () => {
    seed("mem-6", "an ordinary note; a redacted trigger does not feed its vector");
    const m = memoryFor("mem-6");
    await m.patch({ trigger: `when ${SLACK_TOKEN} expires`, embedding: [0.5, 0.25, 0.125], embeddingModel: "client-model" });

    const stored = await (BaseMemory as any).get("mem-6");
    expect(stored.trigger).toBe(`when ${REDACTED} expires`);
    expect(stored.embedding).toEqual([0.01, 0.02, 0.03]);
    expect(stored.embeddingModel).toBe("old-model");
    expect(embedInputs).toEqual([]);
  });

  it("unchanged content with a redaction-removed vector keeps the stored vector and embeds nothing", async () => {
    seed("mem-7", "an ordinary note echoed unchanged");
    embedImpl = () => null; // a failing engine must not be consulted at all
    const m = memoryFor("mem-7");
    await m.patch({ content: "an ordinary note echoed unchanged", trigger: `when ${SLACK_TOKEN} expires`, embedding: [0.5, 0.25, 0.125], embeddingModel: "client-model" });

    const stored = await (BaseMemory as any).get("mem-7");
    expect(stored.trigger).toBe(`when ${REDACTED} expires`);
    expect(stored.embedding).toEqual([0.01, 0.02, 0.03]);
    expect(stored.embeddingModel).toBe("old-model");
    expect(stored.updatedAt).toBeUndefined();
    expect(embedInputs).toEqual([]);
  });

  it("a content-changing PATCH without a supplied vector clears the embedding when the engine returns none", async () => {
    seed("mem-4", "a note edited while the embedding engine is down");
    embedImpl = () => null;
    const m = memoryFor("mem-4");
    await m.patch({ content: "the edited text" });

    const stored = await (BaseMemory as any).get("mem-4");
    expect(stored.content).toBe("the edited text");
    expect(stored.embedding).toBeNull();
    expect(stored.embeddingModel).toBeNull();
    expect(embedInputs).toEqual(["the edited text"]);
  });
});
