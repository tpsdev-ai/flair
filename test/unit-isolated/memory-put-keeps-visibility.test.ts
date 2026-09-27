/**
 * A PUT that omits `visibility` on an existing record keeps the record's
 * stored visibility. Harper's PUT replaces the whole row, so without the carry
 * an omitted field was dropped from the stored row. Isolated: owns the harper
 * mock for Memory.ts.
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
  // Harper PUT semantics: the stored row IS the content (full replacement).
  async put(content: any) {
    memoryStore.set(content.id, { ...content });
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

describe("PUT without visibility keeps the existing record's visibility", () => {
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

  test("a _reindex payload that omits visibility keeps the stored value", async () => {
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
});
