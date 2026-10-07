/**
 * memory-feed-ephemeral-expiry.test.ts — flair#2274.
 *
 * FeedMemories.post() writes via the RAW Memory table, bypassing
 * Memory.post()/put(). Before the fix it never stamped the ephemeral tier's
 * expiresAt, so an ephemeral row written through the feed was never reaped by
 * MemoryMaintenance — contradicting the documented 24h ephemeral tier. This is
 * the isolated-lane control for that path: it asserts the stored expiry against
 * the SAME shared rule (resources/memory-durability.ts's stampEphemeralExpiry),
 * not a hand-computed constant. The real-Harper control lives in
 * test/integration/feed-ephemeral-expiry-e2e.test.ts.
 *
 * Isolated: owns the harper mock for MemoryFeed.ts.
 */
import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { stampEphemeralExpiry } from "../../resources/memory-durability.ts";

const ORIGINAL_TTL = process.env.FLAIR_EPHEMERAL_TTL_HOURS;

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

/** The expiry the shared rule would stamp for a fresh ephemeral write now. */
function sharedRuleExpiryMs(): number {
  const row: Record<string, any> = { durability: "ephemeral" };
  stampEphemeralExpiry(row);
  return Date.parse(row.expiresAt);
}

beforeEach(() => {
  memoryStore = new Map();
  // A distinctive TTL so a hardcoded 24h could not accidentally match.
  process.env.FLAIR_EPHEMERAL_TTL_HOURS = "6";
});
afterEach(() => {
  if (ORIGINAL_TTL === undefined) delete process.env.FLAIR_EPHEMERAL_TTL_HOURS;
  else process.env.FLAIR_EPHEMERAL_TTL_HOURS = ORIGINAL_TTL;
});

describe("FeedMemories.post stamps the ephemeral tier expiry (flair#2274)", () => {
  test("a fresh ephemeral feed write carries the shared rule's expiry", async () => {
    const expected = sharedRuleExpiryMs();
    const result: any = await feed().post({ agentId: "alice", content: "feed journal entry, ephemeral" , durability: "ephemeral" });
    expect(result).not.toBeInstanceOf(Response);
    const stored = memoryStore.get(result.id);
    expect(stored.durability).toBe("ephemeral");
    expect(typeof stored.expiresAt).toBe("string");
    // Asserted against the shared rule, not a constant.
    expect(Math.abs(Date.parse(stored.expiresAt) - expected)).toBeLessThan(2000);
  });

  test("no over-fire: a persistent feed write gets NO expiry", async () => {
    const result: any = await feed().post({ agentId: "alice", content: "a durable feed fact", durability: "persistent" });
    expect(result).not.toBeInstanceOf(Response);
    const stored = memoryStore.get(result.id);
    expect(stored.durability).toBe("persistent");
    expect(stored.expiresAt).toBeUndefined();
  });

  test("a caller-supplied expiresAt is preserved", async () => {
    const supplied = new Date(Date.now() + 1_234_567).toISOString();
    const result: any = await feed().post({ agentId: "alice", content: "explicitly dated feed row", durability: "ephemeral", expiresAt: supplied });
    expect(result).not.toBeInstanceOf(Response);
    expect(memoryStore.get(result.id).expiresAt).toBe(supplied);
  });

  test("an update of an ephemeral row carries the stored expiry forward (no re-stamp)", async () => {
    const stored = new Date(Date.now() + 9_000_000).toISOString();
    memoryStore.set("eph-keep", { id: "eph-keep", agentId: "alice", content: "original", durability: "ephemeral", visibility: "private", expiresAt: stored });
    const result: any = await feed().post({ id: "eph-keep", agentId: "alice", content: "edited journal entry", durability: "ephemeral" });
    expect(result).not.toBeInstanceOf(Response);
    expect(memoryStore.get("eph-keep").expiresAt).toBe(stored);
  });
});
