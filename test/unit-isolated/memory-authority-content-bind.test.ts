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

class BaseMemory {
  async get(target?: any) {
    const id = typeof target === "string" ? target : target?.id ?? (this as any).id;
    return memoryStore.get(id) ?? null;
  }
  static async get(id: any) {
    return memoryStore.get(typeof id === "string" ? id : id?.id) ?? null;
  }
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
