/**
 * FeedMemories updates preserve the record's stored visibility unless the
 * write explicitly changes it. Isolated: owns the harper mock for MemoryFeed.ts.
 */
import { describe, expect, test, beforeEach, afterAll, mock } from "bun:test";
import { computeContentHash } from "../../resources/memory-feed-lib.ts";
import { installFakeHarperTransaction } from "../helpers/fake-harper-txn";

let memoryStore: Map<string, any>;
let getCount = 0;
let failGetAt: number | null = null;

// Model Harper's global transaction (the write-back helper reaches it there).
const txn = installFakeHarperTransaction((id, row) => memoryStore.set(id, row));
afterAll(() => txn.restore());

const databasesMock = {
  flair: {
    Memory: {
      get: async (id: string) => {
        getCount++;
        if (failGetAt !== null && getCount === failGetAt) throw new Error("storage unavailable");
        return memoryStore.get(id) ?? null;
      },
      // Harper PUT semantics: the stored row IS the record (full replacement);
      // a write inside the owned transaction is staged (lands on commit).
      put: async (record: any) => {
        if (txn.stage(record.id, { ...record })) return record;
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
  getCount = 0;
  failGetAt = null;
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

  test("(fd1) the duplicate path returns the existing row without inline pointer fields", async () => {
    const dup = {
      id: "dup-1",
      agentId: "alice",
      content: "dupe note",
      contentHash: computeContentHash("alice", "dupe note"),
      durability: "standard",
      visibility: "shared",
      // A raw writer could leave these on the row; the returned row must not carry them.
      hostSource: JSON.stringify({ v: 1, host: "openclaw", kind: "run", id: "r1" }),
      hostSourceScope: "record",
      hostSourceVisibility: "shared",
    };
    memoryStore.set("dup-1", dup);
    const result: any = await feed().post({ agentId: "alice", content: "dupe note" });
    expect(result).not.toBeInstanceOf(Response); // assertion: the duplicate short-circuits to 200
    expect(result.hostSource).toBeUndefined(); // assertion: inline hostSource removed on the duplicate path
    expect(result.hostSourceScope).toBeUndefined(); // assertion: inline scope removed
    expect(result.hostSourceVisibility).toBeUndefined(); // assertion: inline visibility removed
    expect(result.id).toBe("dup-1"); // assertion: it is still the existing row
  });

  test("(fd2) a failed existing-row lookup fails the feed write and leaves the row and token unchanged", async () => {
    memoryStore.set("boomtok", { id: "boomtok", agentId: "alice", content: "orig", durability: "standard", visibility: "private", instanceToken: "tok-keep" });
    // The token lookup is the THIRD get of this content id (the body-id guard,
    // the authority-field guard, then the token lookup). Fail exactly it.
    failGetAt = 3;
    let threw = false;
    try {
      const res: any = await feed().post({ id: "boomtok", agentId: "alice", content: "changed", durability: "standard" });
      if (res instanceof Response && res.status >= 400) threw = true;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true); // assertion: a failed lookup fails the write
    expect(memoryStore.get("boomtok").content).toBe("orig"); // assertion: the stored row is unchanged
    expect(memoryStore.get("boomtok").instanceToken).toBe("tok-keep"); // assertion: the token is not rotated (a bound pointer stays bound)
  });
});
