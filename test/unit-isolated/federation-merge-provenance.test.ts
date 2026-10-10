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
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import nacl from "tweetnacl";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { signBody, signBodyFresh } from "../../resources/federation-crypto.js";
import { createFakeReplayNonceTable } from "../helpers/fake-replay-store.ts";
import { installFakeHarperTransaction } from "../helpers/fake-harper-txn.ts";

const PEER_ID = "inst-remote";
let peerStore: Map<string, any>;
let memoryStore: Map<string, any>;
let syncLogStore: Map<string, any>;

function emptyGen() {
  async function* gen() {}
  return gen();
}

const harperTxn = installFakeHarperTransaction((id: string, payload: { row: any }) => {
  memoryStore.set(id, { ...payload.row });
});

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
          // flair#2441: the merge's Memory write is a write-back inside an owned
          // transaction — stage it so the committed re-read still sees the
          // committed store row (as real Harper does).
          if (harperTxn.stage(r.id, { row: r })) return r;
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
      // Signed federation bodies record their nonce here (flair#2061).
      ReplayNonce: createFakeReplayNonceTable(),
      Instance: { search: () => emptyGen() },
    },
  },
}));

let senderSeed: Uint8Array;
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

  it("(f1-in-new-legacy) a NEW synced row carrying a LEGACY provenance (caller-chosen verified.timestamp, no claimed/receivedAt) keeps it byte-for-byte", async () => {
    // flair#1960 r2 documented preservation case: a federated receive is not a
    // local write, so it does NOT re-stamp — the originator's stored blob is
    // preserved verbatim, legacy timestamp and all. Record signatures
    // authenticate those bytes; there is no bulk rewrite.
    const { secretKey, publicKey } = keypair();
    peerStore.set(PEER_ID, { id: PEER_ID, publicKey, role: "hub", status: "connected" });
    const legacy = JSON.stringify({ v: 1, verified: { agentId: "agent-a", timestamp: "2001-01-01T00:00:00.000Z" } });
    const record = memoryRecord(
      { id: "m-legacy", data: { id: "m-legacy", agentId: "agent-a", content: "legacy synced note", visibility: "shared", provenance: legacy }, updatedAt: NEW, originatorInstanceId: PEER_ID },
      secretKey,
    );
    const res: any = await postSync({ instanceId: PEER_ID, records: [record], lamportClock: 9 }, secretKey);
    expect(res.merged).toBe(1); // control: the record merged
    expect(memoryStore.get("m-legacy")?.provenance).toBe(legacy); // assertion: the legacy originator stamp is preserved verbatim
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


describe("round 23 — sender projection through signed federation receive", () => {
  it.each([false, true])("(r23-federation-roundtrip) meta and kind survive sync (update=%s)", async (update) => {
    const { secretKey, publicKey } = keypair();
    senderSeed = secretKey.slice(0, 32);
    peerStore.set(PEER_ID, { id: PEER_ID, publicKey, role: "hub", status: "connected" });
    const row = {
      id: "roundtrip", agentId: "agent-a", content: "remote content", contentHash: "remote-hash",
      visibility: "shared", updatedAt: "2026-09-02T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
      provenance: JSON.stringify({ v: 1, verified: { agentId: "agent-a" } }),
      meta: { seq: 7, processUUID: "capture-process", custom: { nested: ["kept", 8] } },
      kind: "session",
      _originatorInstanceId: "previous-origin", _syncedFrom: "previous-peer", _syncedAt: "previous-time",
      instanceToken: "remote-token",
      hostSource: "POINTER-MUST-NOT-LEAVE", hostSourceScope: "record", hostSourceVisibility: "shared",
      undeclaredProbe: "MUST-NOT-LEAVE",
    };
    if (update) memoryStore.set(row.id, {
      ...row, content: "local content", contentHash: "local-hash", updatedAt: "2026-09-01T00:00:00.000Z",
      meta: { seq: 1 }, kind: "old-kind", instanceToken: "local-token",
    });
    const sent: any[] = [];
    let projectionCalls = 0;
    globalThis.fetch = mock(async (urlInput: string | URL | Request, init?: RequestInit) => {
      const url = String(urlInput);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.endsWith("/FederationPeers")) return Response.json({ peers: [
        { id: "hub", role: "hub", status: "connected", endpoint: "http://roundtrip-hub:9926", lastSyncAt: "2026-08-01T00:00:00.000Z" },
      ] });
      if (url.endsWith("/FederationInstance")) return Response.json({ id: PEER_ID, publicKey, role: "spoke" });
      if (body?.operation === "search_by_conditions") {
        if (body.table !== "Memory") return Response.json([]);
        // The REAL sender query passes Harper's ops validation and projection.
        // A fetch mock returning the entire row would hide this regression.
        projectionCalls++;
        const projected = execFileSync("node", [fileURLToPath(new URL("../helpers/harper-memory-projection.cjs", import.meta.url))], {
          input: JSON.stringify({ query: body, rows: body.conditions[0].search_type === "greater_than" ? [row] : [] }),
          encoding: "utf8", timeout: 10_000,
        });
        return Response.json(JSON.parse(projected));
      }
      if (url.endsWith("/FederationSync")) {
        sent.push(...structuredClone(body.records));
        const result = await new (FederationSync as any)().post(body);
        return result instanceof Response ? result : Response.json(result);
      }
      if (body?.operation === "search_by_value" && body.table === "Peer") {
        return Response.json([{ id: "hub", role: "hub", status: "connected" }]);
      }
      if (body?.operation === "update" || body?.operation === "upsert") return Response.json({ update_hashes: ["hub"] });
      throw new Error(`Unexpected round-trip fetch: ${url} ${body?.operation}`);
    }) as any;
    const { runFederationSyncOnce } = await import("../../src/cli.ts");
    const result = await runFederationSyncOnce({
      target: "http://roundtrip-local:9926", opsTarget: "http://roundtrip-local:9925", adminPass: "fixture-password",
    });
    expect(result.error).toBeUndefined();
    expect(result.pushed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(projectionCalls).toBe(2);
    expect(sent).toHaveLength(1);
    const outbound = sent[0].data;
    expect(outbound.meta).toEqual(row.meta);
    expect(outbound.kind).toBe(row.kind);
    for (const field of ["_originatorInstanceId", "_syncedFrom", "_syncedAt"] as const) {
      expect(outbound[field]).toBe(row[field]);
    }
    for (const field of ["hostSource", "hostSourceScope", "hostSourceVisibility", "undeclaredProbe"]) {
      expect(outbound).not.toHaveProperty(field);
    }
    const stored = memoryStore.get(row.id);
    expect(stored.content).toBe(row.content);
    expect(stored.meta).toEqual(row.meta);
    expect(stored.kind).toBe(row.kind);
    expect(stored.provenance).toBe(row.provenance);
    expect(stored._originatorInstanceId).toBe(PEER_ID);
    expect(stored._syncedFrom).toBe(PEER_ID);
    expect(stored._syncedAt).not.toBe(row._syncedAt);
    expect(stored.instanceToken).not.toBe(row.instanceToken);
    if (update) expect(stored.instanceToken).toBe("local-token");
    for (const field of ["hostSource", "hostSourceScope", "hostSourceVisibility", "undeclaredProbe"]) {
      expect(stored).not.toHaveProperty(field);
    }
  });
});
