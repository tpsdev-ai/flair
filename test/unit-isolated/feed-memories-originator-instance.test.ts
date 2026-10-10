/**
 * feed-memories-originator-instance.test.ts — flair#1965 round 2.
 *
 * POST /FeedMemories writes the RAW Memory table (`(databases as any).flair.Memory.put`),
 * NOT Memory.post()/put(), so before this fix it spread the request body straight
 * into a raw row and wrote it without applying the originator rule: a supplied
 * `originatorInstanceId` landed, and an update that omitted it replaced the row
 * without it. This is the powered check that the feed path now applies the SAME
 * create/update rule the four resource writers use (resources/originator-instance.ts):
 *   - CREATE (no stored row) stamps this instance's own id, ignoring any body value;
 *   - UPDATE keeps the STORED value (a body value neither replaces nor clears it);
 *   - an update that OMITS the field leaves the stored value;
 *   - the receiver-side `_originatorInstanceId` bookkeeping is never client-settable.
 *
 * Isolated: owns the harper mock for MemoryFeed.ts (same shape as
 * memory-feed-authority-fields.test.ts), plus an Instance row so localInstanceId()
 * resolves a real id.
 */
import { describe, expect, test, beforeEach, afterAll, mock } from "bun:test";
import { installFakeHarperTransaction } from "../helpers/fake-harper-txn";

const LOCAL_ID = "flair_local_test";
let memoryStore: Map<string, any>;
let instanceRow: any = null;

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
    Instance: {
      search: () => {
        async function* gen() {
          if (instanceRow) yield instanceRow;
        }
        return gen();
      },
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
const { _resetLocalInstanceIdCacheForTests } = await import("../../resources/instance-identity.ts");

function feed() {
  const r: any = new (FeedMemories as any)();
  r.getContext = () => undefined;
  return r;
}

beforeEach(() => {
  memoryStore = new Map();
  instanceRow = null;
  _resetLocalInstanceIdCacheForTests();
});

describe("flair#1965 r2 — FeedMemories.post applies the originator rule", () => {
  test("CREATE: a new feed row is stamped with the local instance id, ignoring a body value", async () => {
    instanceRow = { id: LOCAL_ID };
    const result = await feed().post({
      id: "feed-create",
      agentId: "alice",
      content: "a brand new feed memory",
      originatorInstanceId: "instance-attacker",
    });
    expect(result.id).toBe("feed-create");
    const stored = memoryStore.get("feed-create");
    expect(stored.originatorInstanceId).toBe(LOCAL_ID);
    expect(stored.originatorInstanceId).not.toBe("instance-attacker");
  });

  test("CREATE with no Instance row stamps null (never invents an id)", async () => {
    instanceRow = null;
    await feed().post({ id: "feed-no-instance", agentId: "alice", content: "written before this instance paired" });
    expect(memoryStore.get("feed-no-instance").originatorInstanceId).toBeNull();
  });

  test("UPDATE (existing id): a body value is IGNORED — the stored value stands", async () => {
    instanceRow = { id: LOCAL_ID };
    memoryStore.set("feed-update", {
      id: "feed-update",
      agentId: "alice",
      content: "authored on instance B",
      originatorInstanceId: "instance-B",
    });
    const result = await feed().post({
      id: "feed-update",
      agentId: "alice",
      content: "edited through the feed",
      originatorInstanceId: "instance-attacker",
    });
    expect(result.id).toBe("feed-update");
    const stored = memoryStore.get("feed-update");
    expect(stored.content).toBe("edited through the feed"); // control: the update landed
    expect(stored.originatorInstanceId).toBe("instance-B");
    expect(stored.originatorInstanceId).not.toBe("instance-attacker");
  });

  test("UPDATE (existing id) that OMITS the field leaves the stored value", async () => {
    instanceRow = { id: LOCAL_ID };
    memoryStore.set("feed-omit", {
      id: "feed-omit",
      agentId: "alice",
      content: "authored on instance B",
      originatorInstanceId: "instance-B",
    });
    await feed().post({ id: "feed-omit", agentId: "alice", content: "edited, field omitted" });
    expect(memoryStore.get("feed-omit").originatorInstanceId).toBe("instance-B");
  });

  test("underscore injection: a body `_originatorInstanceId` never lands; the STORED one stands on update", async () => {
    instanceRow = { id: LOCAL_ID };
    // CREATE: a body `_originatorInstanceId` is dropped.
    await feed().post({
      id: "feed-us-create",
      agentId: "alice",
      content: "new feed row with a forged bookkeeping field",
      _originatorInstanceId: "FORGED",
      _syncedFrom: "FORGED",
      _syncedAt: "FORGED",
    });
    const created = memoryStore.get("feed-us-create");
    expect(created._originatorInstanceId).toBeUndefined();
    expect(created._syncedFrom).toBeUndefined();
    expect(created._syncedAt).toBeUndefined();

    // UPDATE: the STORED receiver bookkeeping survives; a forged body value does not.
    memoryStore.set("feed-us-update", {
      id: "feed-us-update",
      agentId: "alice",
      content: "synced from a peer",
      _originatorInstanceId: "inst-orig",
      _syncedFrom: "inst-peer",
      _syncedAt: "2026-01-01T00:00:00.000Z",
    });
    await feed().post({
      id: "feed-us-update",
      agentId: "alice",
      content: "edited locally after sync",
      _originatorInstanceId: "FORGED",
      _syncedFrom: "FORGED",
      _syncedAt: "FORGED",
    });
    const updated = memoryStore.get("feed-us-update");
    expect(updated._originatorInstanceId).toBe("inst-orig");
    expect(updated._syncedFrom).toBe("inst-peer");
    expect(updated._syncedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
