/**
 * FeedMemories.post() writes the RAW Memory table, not Memory.put, so
 * guardAuthorityFields on the resource class does not run. This file is the
 * powered check that a body-supplied promotion verdict cannot land.
 *
 * Isolated: owns the harper mock for MemoryFeed.ts.
 */
import { describe, expect, test, beforeEach, afterAll, mock } from "bun:test";
import { installFakeHarperTransaction } from "../helpers/fake-harper-txn";

let memoryStore: Map<string, any>;

// Model Harper's global transaction (the write-back helper reaches it there).
const txn = installFakeHarperTransaction((id, row) => memoryStore.set(id, row));
afterAll(() => txn.restore());

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
        if (txn.stage(record.id, { ...record })) return record;
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
});

describe("FeedMemories.post authority fields", () => {
  test("(r23-feed-update) a full-row feed update RE-STAMPS provenance (flair#1960 r2) — the legacy stored blob is not carried forward", async () => {
    const legacy = '{ "v": 1, "verified": {"agentId":"alice", "timestamp":"2026-01-01T00:00:00.000Z"} }\n';
    memoryStore.set("feed-provenance", {
      id: "feed-provenance", agentId: "alice", content: "original body",
      provenance: legacy, instanceToken: "original-token",
    });
    const before = Date.now();
    const result = await feed().post({
      id: "feed-provenance", agentId: "alice", content: "changed feed body",
      provenance: "FORGED", instanceToken: "FORGED-TOKEN",
    });
    expect(result.id).toBe("feed-provenance");
    const stored = memoryStore.get(result.id);
    expect(stored.content).toBe("changed feed body"); // control: the full-row put ran
    // A changed-content re-ingest is a semantic write: provenance is re-derived
    // from the trusted identity + server clock, never the stored/legacy blob.
    const provenance = JSON.parse(stored.provenance);
    expect(provenance.verified.agentId).toBe("alice");
    expect(provenance.verified.timestamp).not.toBe("2026-01-01T00:00:00.000Z"); // not the legacy value
    expect(provenance.verified.timestamp).not.toBe("FORGED");
    expect(Date.parse(provenance.verified.timestamp)).toBeGreaterThanOrEqual(before);
    expect(provenance.verified.timestamp).toBe(provenance.verified.receivedAt);
    // The incarnation token is still preserved (a re-ingest is not a reincarnation).
    expect(stored.instanceToken).toBe("original-token");
  });

  test.each([false, true])("(r23-feed-stamp) a new or unstamped feed row gets trusted provenance (existing=%s)", async (existing) => {
    if (existing) memoryStore.set("feed-stamp", {
      id: "feed-stamp", agentId: "alice", content: "unstamped legacy body",
      instanceToken: "legacy-token",
    });
    const before = Date.now();
    const result = await feed().post({
      id: "feed-stamp", agentId: "alice", content: "new feed body",
      provenance: "FORGED", instanceToken: "FORGED-TOKEN",
      createdAt: "1900-01-01T00:00:00.000Z", updatedAt: "1900-01-01T00:00:00.000Z",
      model: "claimed-model", claimedClient: "claimed-client",
    });
    const stored = memoryStore.get("feed-stamp");
    expect(result.id).toBe("feed-stamp");
    expect(stored.content).toBe("new feed body");
    const provenance = JSON.parse(stored.provenance);
    expect(provenance.v).toBe(1);
    expect(provenance.verified.agentId).toBe("alice");
    for (const field of ["timestamp", "receivedAt"]) {
      expect(Date.parse(provenance.verified[field])).toBeGreaterThanOrEqual(before);
      expect(Date.parse(provenance.verified[field])).toBeLessThanOrEqual(Date.now());
    }
    // flair#1960: the feed's own createdAt is a CLAIM — recorded under
    // claimed.createdAt (the row keeps it too), never as a verified timestamp.
    expect(provenance.claimed).toEqual({ createdAt: "1900-01-01T00:00:00.000Z", model: "claimed-model", client: "claimed-client" });
    expect(provenance.verified.timestamp).not.toBe("1900-01-01T00:00:00.000Z");
    expect(stored.createdAt).toBe("1900-01-01T00:00:00.000Z");
    expect(stored.model).toBeUndefined();
    expect(stored.claimedClient).toBeUndefined();
    expect(stored.instanceToken).not.toBe("FORGED-TOKEN");
    expect(typeof stored.instanceToken).toBe("string");
    if (existing) expect(stored.instanceToken).toBe("legacy-token");
  });

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
