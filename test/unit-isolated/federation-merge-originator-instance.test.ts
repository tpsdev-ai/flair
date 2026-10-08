/**
 * federation-merge-originator-instance.test.ts — flair#1965.
 *
 * Drives the REAL `FederationSync.post` apply (Peer lookup → batch signature →
 * per-record merge → `table.put`) for EACH synced table and pins that the
 * inbound merge KEEPS THE PUSHED ROW'S `originatorInstanceId` verbatim:
 *   - the value written comes from `record.data` — the merge never re-stamps it
 *     with the RECEIVING instance's id and never replaces it with the relaying
 *     sender's id;
 *   - on an update the merge's LWW choice is the remote value, same as today;
 *   - the receiver's own bookkeeping stamp is the separate `_originatorInstanceId`.
 *
 * Scope note (no authorship claim): this pins PRESERVATION of an authenticated
 * peer's row value. The fixture signs the `instance-origin` row with the
 * RELAYING peer's key, so it does NOT prove the named instance authored the
 * value; proving authorship would need a per-originator signature check, which
 * this test deliberately does not assert.
 *
 * This is the "federation merges keep the pushed row's originating value" leg of
 * #1965. The path applies rows through the RAW table handle (`table.put`), never
 * through a resource's post()/put()/patch(), so it never takes a field from a
 * resource request body — which is why it keeps the remote value without
 * reopening client writability.
 *
 * Runs in test/unit-isolated (own process) so its harper mock never races
 * another file.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import nacl from "tweetnacl";
import { signBody, signBodyFresh } from "../../resources/federation-crypto.js";
import { createFakeReplayNonceTable, ensureGlobalHarperTransaction } from "../helpers/fake-replay-store.ts";

const PEER_ID = "inst-remote";
const ORIGIN = "instance-origin";
const LOCAL_ORIGIN = "instance-local";
const OLD = "2026-09-01T00:00:00.000Z";
const NEW = "2026-09-02T00:00:00.000Z";

let peerStore: Map<string, any>;
let syncLogStore: Map<string, any>;
let stores: Record<string, Map<string, any>>;

function emptyGen() {
  async function* gen() {}
  return gen();
}

function table(name: string) {
  return {
    get: async (id: string) => stores[name].get(id) ?? null,
    put: async (r: any) => {
      if (name === "Memory") {
        for (const field of ["agentId", "content", "createdAt"]) expect(typeof r[field]).toBe("string");
      }
      stores[name].set(r.id, JSON.parse(JSON.stringify(r)));
      return r;
    },
    search: () => emptyGen(),
  };
}

ensureGlobalHarperTransaction();

mock.module("harper", () => ({
  Resource: class {},
  server: { http: () => {}, getUser: async () => null },
  databases: {
    flair: {
      Peer: {
        get: async (id: string) => peerStore.get(id) ?? null,
        put: async (r: any) => {
          peerStore.set(r.id, r);
          return r;
        },
        search: () => emptyGen(),
      },
      Memory: table("Memory"),
      Soul: table("Soul"),
      Agent: table("Agent"),
      Relationship: table("Relationship"),
      Message: table("Message"),
      SyncLog: {
        put: async (r: any) => {
          syncLogStore.set(r.id, r);
          return r;
        },
      },
      // Signed federation bodies record their nonce here (flair#2061).
      ReplayNonce: createFakeReplayNonceTable(),
      Instance: { search: () => emptyGen() },
    },
  },
}));

let senderSeed!: Uint8Array;
mock.module("../../src/keystore.ts", () => ({
  keystore: { getPrivateKeySeed: () => senderSeed },
  keyPath: () => { throw new Error("round-trip fixture must use the in-memory key"); },
  // flair#2200: the mint path records a seed's owner via these exports.
  recordSeedOwner: () => {},
  readSeedOwnerAt: () => ({ state: "absent" }),
  SEED_OWNER_SUFFIX: ".owner.json",
}));
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const { FederationSync } = await import("../../resources/Federation.ts");

function keypair() {
  const pair = nacl.sign.keyPair();
  return { secretKey: pair.secretKey, publicKey: Buffer.from(pair.publicKey).toString("base64url") };
}

/**
 * A pushed record as src/commands/federation.ts builds it today: the ENVELOPE
 * `originatorInstanceId` is the SENDER's own instance id (used for the
 * per-record signature), while the ROW (`data`) carries whatever
 * `originatorInstanceId` the stored record held — here `ORIGIN`, the value the
 * row CLAIMS. A hub relaying a spoke's row looks exactly like this. NOTE: the
 * signature below is made with the relaying peer's key, so `ORIGIN` is not
 * cryptographically proven here — the test pins PRESERVATION of the pushed row's
 * value, not authorship.
 */
function pushedRecord(
  tableName: string,
  id: string,
  data: Record<string, any>,
  updatedAt: string,
  secretKey: Uint8Array,
) {
  const record: any = { table: tableName, id, data, updatedAt, originatorInstanceId: PEER_ID };
  record.signature = signBody(
    { v: 1, table: tableName, id, data, updatedAt, originatorInstanceId: PEER_ID },
    secretKey,
  );
  return record;
}

async function postSync(body: Record<string, any>, secretKey: Uint8Array) {
  const signed = signBodyFresh(body, secretKey);
  const r: any = new (FederationSync as any)();
  return r.post(signed);
}

const ROWS: Record<string, { data: (origin: string) => Record<string, any>; field: string }> = {
  Memory: {
    field: "content",
    data: (origin) => ({ id: "row-1", agentId: "agent-a", content: "synced body", contentHash: "h1", createdAt: OLD, visibility: "shared", originatorInstanceId: origin }),
  },
  Soul: {
    field: "value",
    data: (origin) => ({ id: "row-1", agentId: "agent-a", key: "identity", value: "synced soul", createdAt: OLD, originatorInstanceId: origin }),
  },
  Agent: {
    field: "name",
    data: (origin) => ({ id: "row-1", name: "Synced Principal", publicKey: "pending", createdAt: OLD, originatorInstanceId: origin }),
  },
  Relationship: {
    field: "object",
    data: (origin) => ({ id: "row-1", agentId: "agent-a", subject: "a", predicate: "manages", object: "b", createdAt: OLD, originatorInstanceId: origin }),
  },
};

beforeEach(() => {
  peerStore = new Map();
  syncLogStore = new Map();
  stores = { Memory: new Map(), Soul: new Map(), Agent: new Map(), Relationship: new Map(), Message: new Map() };
});

describe("flair#1965 — the federated merge preserves an authenticated peer's row value", () => {
  for (const tableName of ["Memory", "Soul", "Agent", "Relationship"]) {
    it(`${tableName}: a NEW inbound row is stored with the pushed ROW's originatorInstanceId (preserved verbatim), not the receiver's or sender's`, async () => {
      const { secretKey, publicKey } = keypair();
      peerStore.set(PEER_ID, { id: PEER_ID, publicKey, createdAt: OLD, role: "hub", status: "connected" });
      const data = ROWS[tableName].data(ORIGIN);
      const record = pushedRecord(tableName, data.id, data, NEW, secretKey);
      const res: any = await postSync({ instanceId: PEER_ID, records: [record], lamportClock: 1 }, secretKey);

      expect(res.merged).toBe(1); // control: the record actually merged through the real apply
      const stored = stores[tableName].get(data.id);
      expect(stored.originatorInstanceId).toBe(ORIGIN);
      expect(stored.originatorInstanceId).not.toBe(PEER_ID);
      expect(stored.originatorInstanceId).not.toBe(LOCAL_ORIGIN);
      // the receiver's OWN bookkeeping stamp is the separate underscore field
      expect(stored._originatorInstanceId).toBe(PEER_ID);
    });

    it(`${tableName}: a NEWER inbound update keeps the REMOTE (pushed-row) value over the local row's`, async () => {
      const { secretKey, publicKey } = keypair();
      peerStore.set(PEER_ID, { id: PEER_ID, publicKey, createdAt: OLD, role: "hub", status: "connected" });
      const local = ROWS[tableName].data(LOCAL_ORIGIN);
      stores[tableName].set(local.id, { ...local, updatedAt: OLD });

      const data = ROWS[tableName].data(ORIGIN);
      const record = pushedRecord(tableName, data.id, data, NEW, secretKey);
      const res: any = await postSync({ instanceId: PEER_ID, records: [record], lamportClock: 2 }, secretKey);

      expect(res.merged).toBe(1);
      const stored = stores[tableName].get(data.id);
      expect(stored.originatorInstanceId).toBe(ORIGIN); // the originator's value, selected by the merge's LWW
      expect(stored.originatorInstanceId).not.toBe(LOCAL_ORIGIN); // never the receiver's local stamp
      expect(stored[ROWS[tableName].field]).toBe(data[ROWS[tableName].field]); // control: the merge really applied the remote row
    });
  }
});

describe("FederationSync ephemeral expiry", () => {
  it("stores receiver-clock expiry with a backdated incoming createdAt", async () => {
    const prior = process.env.FLAIR_EPHEMERAL_TTL_HOURS;
    process.env.FLAIR_EPHEMERAL_TTL_HOURS = "6";
    try {
      const { secretKey, publicKey } = keypair();
      peerStore.set(PEER_ID, { id: PEER_ID, publicKey, createdAt: OLD, role: "spoke", status: "paired" });
      const data = { id: "expiry-row", agentId: "agent-a", content: "received note", durability: "ephemeral", visibility: "private", createdAt: OLD, updatedAt: NEW };
      stores.Memory.set(data.id, { ...data, updatedAt: OLD, expiresAt: OLD });
      const before = Date.now();
      const res: any = await postSync({ instanceId: PEER_ID, records: [pushedRecord("Memory", data.id, data, NEW, secretKey)], lamportClock: 1 }, secretKey);
      expect(res.merged).toBe(1);
      const stored = stores.Memory.get(data.id);
      expect(stored.createdAt).toBe(OLD);
      expect(Date.parse(stored.expiresAt)).toBeGreaterThanOrEqual(before + 6 * 3600000);
      expect(Date.parse(stored.expiresAt)).toBeLessThanOrEqual(Date.now() + 6 * 3600000);
    } finally {
      if (prior === undefined) delete process.env.FLAIR_EPHEMERAL_TTL_HOURS;
      else process.env.FLAIR_EPHEMERAL_TTL_HOURS = prior;
    }
  });
});
