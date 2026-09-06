/**
 * FeedMemories.post() writes the RAW Memory table, not Memory.put, so
 * guardAuthorityFields on the resource class does not run. This file is the
 * powered check that a body-supplied promotion verdict cannot land.
 *
 * Isolated: owns the harper mock for MemoryFeed.ts.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

let memoryStore: Map<string, any>;

function fromStore(): AsyncIterable<any> {
  async function* gen() {
    for (const r of memoryStore.values()) yield r;
  }
  return gen();
}

const databasesMock = {
  flair: {
    Memory: {
      get: async (id: string) => memoryStore.get(id) ?? null,
      put: async (record: any) => {
        memoryStore.set(record.id, { ...record });
        return record;
      },
      search: () => fromStore(),
    },
  },
};

mock.module("harper", () => ({
  databases: databasesMock,
  Resource: class {},
  server: { http: () => {}, getUser: async () => null },
}));

const { FeedMemories } = await import("../../resources/MemoryFeed.ts");

function feed() {
  const r: any = new (FeedMemories as any)();
  r.getContext = () => undefined;
  return r;
}

beforeEach(() => {
  memoryStore = new Map();
});

describe("FeedMemories.post authority fields", () => {
  test("a body with promotionStatus:approved cannot land a forged verdict", async () => {
    const result = await feed().post({
      id: "feed-forged",
      agentId: "alice",
      content: "forged verdict fixture",
      promotionStatus: "approved",
      promotedAt: "2026-09-01T00:00:00.000Z",
      promotedBy: "attacker",
    });
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(403);
    expect(memoryStore.has("feed-forged")).toBe(false);
  });

  test("an ordinary feed write still lands and carries no authority stamps", async () => {
    const result = await feed().post({
      id: "feed-clean",
      agentId: "alice",
      content: "ordinary feed memory",
    });
    expect(result.id).toBe("feed-clean");
    expect(result.content).toBe("ordinary feed memory");
    const stored = memoryStore.get("feed-clean");
    expect(stored.content).toBe("ordinary feed memory");
    expect(stored.promotionStatus).toBeUndefined();
    expect(stored.promotedAt).toBeUndefined();
    expect(stored.promotedBy).toBeUndefined();
  });

  test("unconditional strip drops restored stamps on a feed overwrite", async () => {
    memoryStore.set("feed-overwrite", {
      id: "feed-overwrite",
      agentId: "alice",
      content: "previously approved",
      promotionStatus: "approved",
      promotedAt: "2026-09-01T00:00:00.000Z",
      promotedBy: "reviewer",
    });
    const result = await feed().post({
      id: "feed-overwrite",
      agentId: "alice",
      content: "new unreviewed feed content",
    });
    expect(result.id).toBe("feed-overwrite");
    const stored = memoryStore.get("feed-overwrite");
    expect(stored.content).toBe("new unreviewed feed content");
    expect(stored.promotionStatus).toBeUndefined();
    expect(stored.promotedAt).toBeUndefined();
    expect(stored.promotedBy).toBeUndefined();
  });
});
