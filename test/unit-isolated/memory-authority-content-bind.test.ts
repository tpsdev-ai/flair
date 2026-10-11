/**
 * Powered check that a content-changing Memory write cannot keep an echoed
 * promotion verdict (Sherlock #3 / #1524 leftover). Isolated: owns the harper
 * mock for Memory.ts.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

mock.module("../../resources/embeddings-provider.ts", () => ({
  getEmbedding: async () => [1, 0, 0, 0],
  getModelId: () => "mock-embedding-model",
  getMode: () => "local",
  EMBEDDING_ENGINE: "gguf", // embedding-space-guard slice 1 — guard imports this transitively via Memory.ts
}));

let memoryStore: Map<string, any>;
/** The open transaction's staged Memory writes (null outside a transaction). */
let staged: Map<string, any> | null = null;

class BaseMemory {
  async get(target?: any) {
    const id = typeof target === "string" ? target : target?.id ?? (this as any).id;
    return memoryStore.get(id) ?? null;
  }
  static async get(id: any) {
    return memoryStore.get(typeof id === "string" ? id : id?.id) ?? null;
  }
  static async put(content: any) {
    // flair#2441: inside an open transaction the write is STAGED (the store is
    // the committed state until commit; an abort discards it), as in real
    // Harper — Memory.put re-reads the committed row before its commit.
    if (staged) { staged.set(content.id, { ...content }); return undefined; }
    memoryStore.set(content.id, { ...content });
    return undefined;
  }
  static async delete(id: any) { memoryStore.delete(typeof id === "string" ? id : id?.id); return { ok: true }; }
  async put(content: any) {
    memoryStore.set(content.id, { ...content });
  }
  async patch(content: any) {
    const id = (this as any).id;
    const existing = memoryStore.get(id) ?? {};
    memoryStore.set(id, { ...existing, ...content });
  }
  search() {
    async function* gen() { for (const r of memoryStore.values()) yield r; }
    return gen();
  }
}

mock.module("harper", () => ({
  databases: {
    flair: {
      Memory: BaseMemory,
      MemoryGrant: { search: () => (async function* () {})() },
      Agent: { get: async () => null, search: async () => [] },
      Instance: { search: () => (async function* () {})() },
    },
  },
  Resource: class {},
  logger: { warn: () => {} },
  server: { http: () => {}, getUser: async () => null },
}));

const { Memory } = await import("../../resources/Memory.ts");

function makeMemory(id: string) {
  const r: any = new (Memory as any)();
  r.id = id;
  r.getContext = () => ({ request: { tpsAgent: "alice", tpsAgentIsAdmin: false } });
  return r;
}

const STAMPS = {
  promotionStatus: "approved",
  promotedAt: "2026-09-01T00:00:00.000Z",
  promotedBy: "trusted-reviewer",
};

beforeEach(() => {
  memoryStore = new Map();
  memoryStore.set("stamped", {
    id: "stamped",
    agentId: "alice",
    content: "reviewed text",
    durability: "persistent",
    ...STAMPS,
  });
});

// flair#1940: Harper assigns `transaction` onto the global at load, and the
// Memory write path creates one when a caller has no request context, refusing
// to run a write unwrapped. Provide it in this isolated mock.
(globalThis as any).transaction = (ctx: any, cb: (txn: any) => any) => {
  if (ctx?.transaction && ctx.transaction.open === 1) return cb(ctx.transaction);
  const writes = new Map<string, any>();
  const txn: any = {
    open: 1, saveCommits: false,
    abort() { this.open = 0; writes.clear(); staged = null; },
    commit() { if (this.open === 1) for (const [id, row] of writes) memoryStore.set(id, row); this.open = 0; staged = null; },
  };
  staged = writes;
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

describe("Memory writes bind the verdict to reviewed content", () => {
  test("PUT that echoes stamps while changing content drops the verdict", async () => {
    const result = await makeMemory("stamped").put({
      id: "stamped",
      agentId: "alice",
      content: "unreviewed claim",
      durability: "persistent",
      ...STAMPS,
    });
    expect(result).not.toBeInstanceOf(Response);
    const stored = memoryStore.get("stamped");
    expect(stored.content).toBe("unreviewed claim");
    expect(stored.promotionStatus).toBeFalsy();
    expect(stored.promotedBy).toBeFalsy();
    expect(stored.promotedAt).toBeFalsy();
  });

  test("PATCH that changes content drops the verdict; metadata-only PATCH keeps it", async () => {
    const meta = await makeMemory("stamped").patch({ durability: "standard", archived: true });
    expect(meta).not.toBeInstanceOf(Response);
    expect(memoryStore.get("stamped").promotionStatus).toBe("approved");
    expect(memoryStore.get("stamped").content).toBe("reviewed text");

    const changed = await makeMemory("stamped").patch({ content: "patched unreviewed claim", ...STAMPS });
    expect(changed).not.toBeInstanceOf(Response);
    const stored = memoryStore.get("stamped");
    expect(stored.content).toBe("patched unreviewed claim");
    expect(stored.promotionStatus).toBeFalsy();
    expect(stored.promotedBy).toBeFalsy();
  });
});
