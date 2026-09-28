/**
 * federation-merge-provenance.test.ts — flair#1940 slice 1, round 22.
 *
 * Drives the REAL `FederationSync.post` apply (Peer lookup → batch signature →
 * per-record merge → `table.put`) rather than mirroring its statements, to pin
 * that the inbound merge PRESERVES provenance:
 *   - (f1-in-new) a NEW synced Memory row keeps the INBOUND provenance value
 *     (`mergeRecord` returns `remote.data` when there is no local row);
 *   - (f1-in-update) a NEWER remote UPDATE keeps the value the merge SELECTED —
 *     the remote one under LWW, NOT always `local.provenance`;
 *   - (f1-in-stale) an OLDER remote record keeps the LOCAL row's provenance.
 *
 * RED against the pre-round-22 code: the merge's `stripServerStampedFields`
 * deleted provenance from `mergedData` and restored only `instanceToken`, so a
 * synced row landed with no originator provenance and an updated row lost it.
 *
 * Runs in test/unit-isolated (own process) so its harper mock never races
 * another file. NOTE: the existing embedding-space-guard-federation test
 * mirrors the raw `table.put` + latch statements; this file instead exercises
 * the strip-and-restore that only the real apply path performs.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import nacl from "tweetnacl";
import { signBody, signBodyFresh } from "../../resources/federation-crypto.js";

const PEER_ID = "inst-remote";
let peerStore: Map<string, any>;
let memoryStore: Map<string, any>;
let syncLogStore: Map<string, any>;

function emptyGen() {
  async function* gen() {}
  return gen();
}

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
      Memory: {
        get: async (id: string) => memoryStore.get(id) ?? null,
        put: async (r: any) => {
          memoryStore.set(r.id, { ...r });
          return r;
        },
        search: () => emptyGen(),
      },
      Soul: { get: async () => null, put: async () => {}, search: () => emptyGen() },
      Agent: { get: async () => null, put: async () => {}, search: () => emptyGen() },
      Relationship: { get: async () => null, put: async () => {}, search: () => emptyGen() },
      Message: { get: async () => null, put: async () => {}, search: () => emptyGen() },
      SyncLog: {
        put: async (r: any) => {
          syncLogStore.set(r.id, r);
          return r;
        },
      },
      Nonce: { search: () => emptyGen(), put: async () => {}, delete: async () => {} },
      Instance: { search: () => emptyGen() },
    },
  },
}));

const { FederationSync } = await import("../../resources/Federation.ts");

function keypair() {
  const pair = nacl.sign.keyPair();
  return { secretKey: pair.secretKey, publicKey: Buffer.from(pair.publicKey).toString("base64url") };
}

function memoryRecord(
  fields: { id: string; data: Record<string, any>; updatedAt: string; originatorInstanceId: string },
  secretKey: Uint8Array,
) {
  const record: any = {
    table: "Memory",
    id: fields.id,
    data: fields.data,
    updatedAt: fields.updatedAt,
    originatorInstanceId: fields.originatorInstanceId,
  };
  // Today's sender signs {v:1, table, id, data, updatedAt, originatorInstanceId}
  // and omits `v` from the wire (receivers default it to 1).
  record.signature = signBody(
    {
      v: 1,
      table: "Memory",
      id: fields.id,
      data: fields.data,
      updatedAt: fields.updatedAt,
      originatorInstanceId: fields.originatorInstanceId,
    },
    secretKey,
  );
  return record;
}

async function postSync(body: Record<string, any>, secretKey: Uint8Array) {
  const signed = signBodyFresh(body, secretKey);
  const r: any = new (FederationSync as any)();
  return r.post(signed);
}

beforeEach(() => {
  peerStore = new Map();
  memoryStore = new Map();
  syncLogStore = new Map();
});

describe("flair#1940 round 22 — the federated merge preserves provenance", () => {
  const OLD = "2026-09-01T00:00:00.000Z";
  const NEW = "2026-09-02T00:00:00.000Z";

  it("(f1-in-new) a NEW synced Memory row keeps the INBOUND provenance", async () => {
    const { secretKey, publicKey } = keypair();
    peerStore.set(PEER_ID, { id: PEER_ID, publicKey, role: "hub", status: "connected" });
    const provenance = JSON.stringify({ v: 1, verified: { agentId: "agent-a", receivedAt: NEW } });
    const record = memoryRecord(
      { id: "m-new", data: { id: "m-new", agentId: "agent-a", content: "synced note", visibility: "shared", provenance }, updatedAt: NEW, originatorInstanceId: PEER_ID },
      secretKey,
    );
    const res: any = await postSync({ instanceId: PEER_ID, records: [record], lamportClock: 1 }, secretKey);
    expect(res.merged).toBe(1); // control: the record actually merged through the real apply
    expect(memoryStore.get("m-new")?.provenance).toBe(provenance); // assertion: the inbound provenance survives the strip
  });

  it("(f1-in-update) a NEWER remote UPDATE keeps the provenance the merge SELECTED (the remote one)", async () => {
    const { secretKey, publicKey } = keypair();
    peerStore.set(PEER_ID, { id: PEER_ID, publicKey, role: "hub", status: "connected" });
    memoryStore.set("m-upd", {
      id: "m-upd", agentId: "agent-a", content: "local body", contentHash: "h-local",
      visibility: "shared", provenance: "LOCAL-PROVENANCE", updatedAt: OLD,
    });
    const remoteProv = "REMOTE-PROVENANCE-NEWER";
    const record = memoryRecord(
      { id: "m-upd", data: { id: "m-upd", agentId: "agent-a", content: "remote body", contentHash: "h-remote", visibility: "shared", provenance: remoteProv }, updatedAt: NEW, originatorInstanceId: PEER_ID },
      secretKey,
    );
    const res: any = await postSync({ instanceId: PEER_ID, records: [record], lamportClock: 2 }, secretKey);
    expect(res.merged).toBe(1); // control: the newer remote record merged
    expect(memoryStore.get("m-upd")?.provenance).toBe(remoteProv); // assertion: the merge's LWW choice survives (NOT local.provenance)
  });

  it("(f1-in-stale) an OLDER remote record keeps the LOCAL row's provenance", async () => {
    const { secretKey, publicKey } = keypair();
    peerStore.set(PEER_ID, { id: PEER_ID, publicKey, role: "hub", status: "connected" });
    memoryStore.set("m-old", {
      id: "m-old", agentId: "agent-a", content: "local body", contentHash: "h-local",
      visibility: "shared", provenance: "LOCAL-PROVENANCE", updatedAt: NEW,
    });
    const record = memoryRecord(
      { id: "m-old", data: { id: "m-old", agentId: "agent-a", content: "stale remote body", contentHash: "h-remote", visibility: "shared", provenance: "STALE-REMOTE-PROVENANCE" }, updatedAt: OLD, originatorInstanceId: PEER_ID },
      secretKey,
    );
    const res: any = await postSync({ instanceId: PEER_ID, records: [record], lamportClock: 3 }, secretKey);
    expect(res.merged).toBe(1); // control: the record merged (its contentHash differs, so not a no-op)
    expect(memoryStore.get("m-old")?.provenance).toBe("LOCAL-PROVENANCE"); // assertion: the merge kept local, so local provenance survives
  });
});
