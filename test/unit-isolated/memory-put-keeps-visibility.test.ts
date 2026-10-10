/**
 * Memory updates (PUT, PATCH and reindex) keep a stored private or shared
 * visibility unless the write explicitly sets a new one. Isolated: owns the
 * harper mock for Memory.ts.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

mock.module("../../resources/embeddings-provider.ts", () => ({
  getEmbedding: async () => [1, 0, 0, 0],
  getModelId: () => "mock-embedding-model",
  getMode: () => "local",
  EMBEDDING_ENGINE: "gguf",
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
    const key = typeof id === "string" ? id : id?.id;
    if (key === "boom") throw new Error("storage unavailable");
    return memoryStore.get(key) ?? null;
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
  // Harper PUT semantics: the stored row IS the content (full replacement).
  async put(content: any) {
    memoryStore.set(content.id, { ...content });
  }
  // Harper PATCH semantics: merge the body into the stored row.
  async patch(content: any) {
    const id = (this as any).id;
    const merged = { ...(memoryStore.get(id) ?? {}), ...content };
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
    memoryStore.set(id, merged);
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

beforeEach(() => {
  memoryStore = new Map();
  memoryStore.set("priv", { id: "priv", agentId: "alice", content: "owner-only note", durability: "standard", visibility: "private" });
  memoryStore.set("pub", { id: "pub", agentId: "alice", content: "shared note", durability: "persistent", visibility: "shared" });
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

describe("Memory updates preserve stored visibility", () => {
  test("a private record stays private", async () => {
    const result = await makeMemory("priv").put({ id: "priv", agentId: "alice", content: "edited note", durability: "standard" });
    expect(result).not.toBeInstanceOf(Response);
    expect(memoryStore.get("priv").content).toBe("edited note");
    expect(memoryStore.get("priv").visibility).toBe("private"); // assertion: carried
  });

  test("a shared record stays shared", async () => {
    await makeMemory("pub").put({ id: "pub", agentId: "alice", content: "edited", durability: "persistent" });
    expect(memoryStore.get("pub").visibility).toBe("shared");
  });

  test("an explicit visibility on the write still wins", async () => {
    await makeMemory("priv").put({ id: "priv", agentId: "alice", content: "now shared", durability: "persistent", visibility: "shared" });
    expect(memoryStore.get("priv").visibility).toBe("shared");
  });

  test("the guards see the carried value: moving a shared record to ephemeral without visibility is refused", async () => {
    const result = await makeMemory("pub").put({ id: "pub", agentId: "alice", content: "x", durability: "ephemeral" });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    expect(memoryStore.get("pub").durability).toBe("persistent"); // nothing written
  });

  test("a NEW record still gets the durability-keyed default", async () => {
    await makeMemory("fresh").put({ id: "fresh", agentId: "alice", content: "new", durability: "standard" });
    expect(memoryStore.get("fresh").visibility).toBe("private");
  });

  test("a _reindex update keeps the stored visibility", async () => {
    const r: any = new (Memory as any)();
    r.id = "priv";
    r.getContext = () => undefined; // internal caller: the admin gate passes
    await r.put({ id: "priv", agentId: "alice", content: "owner-only note", durability: "standard", _reindex: true });
    expect(memoryStore.get("priv").visibility).toBe("private");
  });

  test("a failed existing-record lookup fails the write instead of treating it as a create", async () => {
    memoryStore.set("boom", { id: "boom", agentId: "alice", content: "x", durability: "standard", visibility: "private" });
    let threw = false;
    try {
      const result = await makeMemory("boom").put({ id: "boom", agentId: "alice", content: "y", durability: "standard" });
      if (result instanceof Response && result.status >= 400) threw = true;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(memoryStore.get("boom").content).toBe("x"); // nothing written
  });

  test("a PATCH with visibility null keeps the stored value", async () => {
    await makeMemory("priv").patch({ visibility: null, content: "patched" });
    expect(memoryStore.get("priv").visibility).toBe("private");
    expect(memoryStore.get("priv").content).toBe("patched");
  });

  test("a PATCH with an invalid visibility is refused", async () => {
    const result = await makeMemory("priv").patch({ visibility: "prvate" });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    expect(memoryStore.get("priv").visibility).toBe("private");
  });

  test("a PATCH moving a shared record to ephemeral is refused", async () => {
    const result = await makeMemory("pub").patch({ durability: "ephemeral" });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    expect(memoryStore.get("pub").durability).toBe("persistent");
  });

  test("an in-process PATCH carrying visibility: undefined keeps the stored value", async () => {
    await makeMemory("priv").patch({ visibility: undefined, content: "patched again" });
    expect(memoryStore.get("priv").visibility).toBe("private");
  });

  test("(rc1) a failed reindex existing-row lookup fails the write and leaves the row and token unchanged", async () => {
    // The harness's STATIC table get throws for id "boom", the same way a real
    // failed lookup does. The reindex path's token lookup must NOT swallow it.
    memoryStore.set("boom", { id: "boom", agentId: "alice", content: "orig", durability: "standard", visibility: "private", instanceToken: "tok-keep" });
    const r: any = new (Memory as any)();
    r.id = "boom";
    r.getContext = () => undefined; // internal caller: the admin gate passes
    let threw = false;
    try {
      const res = await r.put({ id: "boom", agentId: "alice", content: "changed", durability: "standard", _reindex: true });
      if (res instanceof Response && res.status >= 400) threw = true;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true); // assertion: a failed lookup fails the write
    expect(memoryStore.get("boom").content).toBe("orig"); // assertion: the stored row is unchanged
    expect(memoryStore.get("boom").instanceToken).toBe("tok-keep"); // assertion: the token is not rotated (a bound pointer stays bound)
  });
});
