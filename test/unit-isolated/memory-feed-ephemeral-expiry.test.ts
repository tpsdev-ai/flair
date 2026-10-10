import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { installFakeHarperTransaction } from "../helpers/fake-harper-txn";
import { stampEphemeralExpiry } from "../../resources/memory-durability.ts";

const ORIGINAL_TTL = process.env.FLAIR_EPHEMERAL_TTL_HOURS;

let memoryStore: Map<string, any>;
let txn: ReturnType<typeof installFakeHarperTransaction>;

const databasesMock = {
  flair: {
    Memory: {
      get: async (id: string) => memoryStore.get(id) ?? null,
      // Harper PUT semantics: the stored row IS the record (full replacement).
      put: async (record: any) => {
        if (!txn.stage(record.id, { ...record })) memoryStore.set(record.id, { ...record });
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
  txn = installFakeHarperTransaction((id, row) => memoryStore.set(id, row));
  // A distinctive TTL so a hardcoded 24h could not accidentally match.
  process.env.FLAIR_EPHEMERAL_TTL_HOURS = "6";
});
afterEach(() => {
  txn.restore();
  if (ORIGINAL_TTL === undefined) delete process.env.FLAIR_EPHEMERAL_TTL_HOURS;
  else process.env.FLAIR_EPHEMERAL_TTL_HOURS = ORIGINAL_TTL;
});

describe("FeedMemories.post ephemeral expiry (flair#2274)", () => {
  test("a fresh ephemeral feed write without expiry gets the shared rule's default", async () => {
    const expected = sharedRuleExpiryMs();
    const result: any = await feed().post({ agentId: "alice", content: "feed journal entry, ephemeral" , durability: "ephemeral" });
    expect(result).not.toBeInstanceOf(Response);
    const stored = memoryStore.get(result.id);
    expect(stored.durability).toBe("ephemeral");
    expect(typeof stored.expiresAt).toBe("string");
    // Asserted against the shared rule, not a constant.
    expect(Math.abs(Date.parse(stored.expiresAt) - expected)).toBeLessThan(2000);
  });

  test("no over-fire: a persistent feed write without a supplied expiry gets NO expiry", async () => {
    const result: any = await feed().post({ agentId: "alice", content: "a durable feed fact", durability: "persistent" });
    expect(result).not.toBeInstanceOf(Response);
    const stored = memoryStore.get(result.id);
    expect(stored.durability).toBe("persistent");
    expect(stored.expiresAt).toBeUndefined();
  });

  test("a canonical caller-supplied UTC expiry is preserved", async () => {
    const supplied = new Date(Date.now() + 1_234_567).toISOString();
    const result: any = await feed().post({ agentId: "alice", content: "explicitly dated feed row", durability: "ephemeral", expiresAt: supplied });
    expect(result).not.toBeInstanceOf(Response);
    expect(memoryStore.get(result.id).expiresAt).toBe(supplied);
  });

  test("an update carries a canonical stored ephemeral expiry without re-stamping it", async () => {
    const stored = new Date(Date.now() + 9_000_000).toISOString();
    memoryStore.set("eph-keep", { id: "eph-keep", agentId: "alice", content: "original", durability: "ephemeral", visibility: "private", createdAt: new Date().toISOString(), expiresAt: stored });
    const result: any = await feed().post({ id: "eph-keep", agentId: "alice", content: "edited journal entry", durability: "ephemeral" });
    expect(result).not.toBeInstanceOf(Response);
    expect(memoryStore.get("eph-keep").expiresAt).toBe(stored);
  });
});

test("feed refuses malformed ephemeral expiry before storing the row", async () => {
  const result = await feed().post({ id: "bad-expiry", agentId: "alice", content: "dated note", durability: "ephemeral", expiresAt: "invalid" });
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(400);
  expect(memoryStore.has("bad-expiry")).toBe(false);
});

for (const [expiresAt, canonical] of [
  ["2026-10-08T00:00:00Z", "2026-10-08T00:00:00.000Z"],
  ["2026-10-08T00:00:00.1Z", "2026-10-08T00:00:00.100Z"],
]) {
  test(`feed stores ${expiresAt} in canonical form`, async () => {
    const result: any = await feed().post({ agentId: "alice", content: "UTC feed note", durability: "ephemeral", expiresAt });
    expect(result).not.toBeInstanceOf(Response);
    expect(memoryStore.get(result.id).expiresAt).toBe(canonical);
  });
}

test("feed refuses a nonzero offset expiry with invalid_expiry", async () => {
  const result = await feed().post({ id: "offset-expiry", agentId: "alice", content: "offset feed note", durability: "ephemeral", expiresAt: "2026-10-08T01:00:00+01:00" });
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(400);
  expect((await (result as Response).json()).error).toBe("invalid_expiry");
  expect(memoryStore.has("offset-expiry")).toBe(false);
});

test("feed refuses malformed stored expiry without replacing the row", async () => {
  const stored = { id: "bad-stored", agentId: "alice", content: "original", createdAt: new Date().toISOString(), durability: "ephemeral", expiresAt: "not-a-date" };
  memoryStore.set(stored.id, stored);
  const result = await feed().post({ id: stored.id, agentId: "alice", content: "changed", durability: "ephemeral" });
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(400);
  expect((await (result as Response).json()).error).toBe("invalid_expiry");
  expect(memoryStore.get(stored.id)).toEqual(stored);
});
