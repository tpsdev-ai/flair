/**
 * FeedMemories updates preserve the record's stored visibility unless the
 * write explicitly changes it. Isolated: owns the harper mock for MemoryFeed.ts.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

let memoryStore: Map<string, any>;

const databasesMock = {
  flair: {
    Memory: {
      get: async (id: string) => memoryStore.get(id) ?? null,
      // Harper PUT semantics: the stored row IS the record (full replacement).
      put: async (record: any) => {
        memoryStore.set(record.id, { ...record });
        return record;
      },
      search: () => (async function* () { for (const r of memoryStore.values()) yield r; })(),
    },
  },
};

mock.module("harper", () => ({
  databases: databasesMock,
  Resource: class {},
  server: { http: () => {}, getUser: async () => null },
}));

mock.module("../../resources/agent-auth.ts", () => ({
  allowVerified: async () => true,
  resolveAgentAuth: async () => ({ kind: "agent", agentId: "alice", isAdmin: false }),
}));

const { FeedMemories } = await import("../../resources/MemoryFeed.ts");

function feed() {
  const r: any = new (FeedMemories as any)();
  r.getContext = () => undefined;
  return r;
}

beforeEach(() => {
  memoryStore = new Map();
  memoryStore.set("owned", { id: "owned", agentId: "alice", content: "owner-only note", durability: "standard", visibility: "private" });
});

describe("FeedMemories.post preserves stored visibility on an update", () => {
  test("a changed-content update keeps the stored visibility", async () => {
    const result = await feed().post({ id: "owned", agentId: "alice", content: "edited note" });
    expect(result).not.toBeInstanceOf(Response);
    expect(memoryStore.get("owned").content).toBe("edited note");
    expect(memoryStore.get("owned").visibility).toBe("private"); // assertion: carried
  });

  test("an explicit visibility still wins", async () => {
    await feed().post({ id: "owned", agentId: "alice", content: "now shared", visibility: "shared" });
    expect(memoryStore.get("owned").visibility).toBe("shared");
  });

  test("two feed writes without an id in the same millisecond create two records", async () => {
    const realNow = Date.now;
    Date.now = () => 1790000000000;
    try {
      await feed().post({ agentId: "alice", content: "first note" });
      await feed().post({ agentId: "alice", content: "second note" });
    } finally {
      Date.now = realNow;
    }
    const mine = [...memoryStore.values()].filter((r) => r.id !== "owned");
    expect(mine.length).toBe(2);
    expect(new Set(mine.map((r) => r.id)).size).toBe(2);
  });
});
