/**
 * federation-pair-repair-atomic-2333.test.ts — flair#2333 slice 1.
 *
 * The re-pair path's supplied-token consume and its Peer write must COMMIT
 * TOGETHER (or neither), inside the SAME owned transaction, before the token
 * lock releases. If a Peer write that rejects INSIDE the transaction callback
 * fails, the token must be left UNCONSUMED and retryable while valid, and the
 * request refused by name (503 peer_write_failed) — not left spent with no peer.
 * (A commit-time error propagates unnamed.)
 *
 * The MODEL in this file: it fakes Harper's `transaction()` with commit/abort (a
 * throw discards the writes staged during the callback), so the ATOMICITY — not
 * only the lock ordering — is observable without a real Harper. The REAL-Harper
 * case lives in test/integration/federation-peer-trust-2333.test.ts, which fails
 * the Peer write through a composed test-only component.
 *
 * Mutation — move the peer write back out of the owned transaction —
 * turns the "the token is NOT consumed" assertion red.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.ts";
import { createFakeReplayNonceTable } from "../helpers/fake-replay-store.ts";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";

const HUB_ID = "flair_hubpair2333atomic";
const HUB_KEY = Buffer.from("hub-public-key-32-bytes-pad!!!!").toString("base64url");

const instanceRows: Record<string, unknown>[] = [
  { id: HUB_ID, publicKey: HUB_KEY, role: "hub", status: "active" },
];
const peers = new Map<string, Record<string, unknown>>();
const tokens = new Map<string, Record<string, unknown>>();

/** Fail the next Peer write, as a store error would. */
let failPeerWrite = false;

function asyncRows<T>(items: T[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

// ── Harper's transaction(), with commit/abort (the part the atomicity rests on) ─
//
// While a callback runs, table writes are STAGED; they land only when it
// resolves. A throw discards them, exactly as Harper aborts. (The replay-store
// fake writes its own rows through its own put; it is not staged here, which is
// correct: a signed request's anti-replay nonce is recorded even on refusal.)
type Staged = { tokens: Map<string, Record<string, unknown>>; peers: Map<string, Record<string, unknown>> };
let staged: Staged | null = null;
const savedTransaction = (globalThis as any).transaction;
(globalThis as any).transaction = async (_ctx: unknown, cb: (ctx: any) => any) => {
  const mine: Staged = { tokens: new Map(), peers: new Map() };
  const prev = staged;
  staged = mine;
  try {
    const out = await cb({});
    for (const [id, row] of mine.tokens) tokens.set(id, { ...row });
    for (const [id, row] of mine.peers) peers.set(id, { ...row });
    return out;
  } finally {
    staged = prev;
  }
};

const databasesMock = {
  flair: {
    Instance: { search: () => asyncRows(instanceRows) },
    Peer: {
      get: async (id: string) => peers.get(id) ?? null,
      put: async (row: Record<string, unknown>) => {
        if (failPeerWrite) throw new Error("mock: Peer write failed");
        if (staged) { staged.peers.set(String(row.id), { ...row }); return row; }
        peers.set(String(row.id), { ...row });
        return row;
      },
    },
    PairingToken: {
      get: async (id: string) => tokens.get(id) ?? null,
      put: async (row: Record<string, unknown>) => {
        if (staged) { staged.tokens.set(String(row.id), { ...row }); return row; }
        tokens.set(String(row.id), { ...row });
        return row;
      },
      // The per-token lock (resources/key-lock.ts) the pairing claim runs under.
      primaryStore: { tryLock: () => true, unlock: () => {}, resetReadTxn: () => {} },
    },
    ReplayNonce: createFakeReplayNonceTable(),
  },
};

mock.module("harper", () => ({
  databases: databasesMock,
  Resource: class {},
  server: { getUser: async () => null, operation: async () => ({}), http: () => {} },
}));

const { FederationPair } = await import("../../resources/Federation.ts");

function makePair() {
  const pair: any = new (FederationPair as any)();
  pair.getContext = () => ({ request: {} });
  return pair;
}

async function readBody(result: unknown): Promise<any> {
  if (result instanceof Response) return result.json();
  return result;
}

function rePairSignedBody(instanceId: string, keyPair: nacl.SignKeyPair, pairingToken?: string) {
  return signBodyFresh(
    {
      instanceId,
      publicKey: Buffer.from(keyPair.publicKey).toString("base64url"),
      role: "spoke",
      endpoint: null,
      ...(pairingToken ? { pairingToken } : {}),
    },
    keyPair.secretKey,
  );
}

beforeEach(() => {
  peers.clear();
  tokens.clear();
  failPeerWrite = false;
});

describe("flair#2333 — a re-pair's token consume and Peer write commit together (isolated)", () => {
  it("a token-supplying re-pair's Peer.put rejection inside the callback leaves the token UNCONSUMED and refuses by name", async () => {
    const k = nacl.sign.keyPair();
    const peer = "flair_spoke_repair_atomic";
    const publicKey = Buffer.from(k.publicKey).toString("base64url");
    peers.set(peer, { id: peer, publicKey, role: "spoke", status: "paired", updatedAt: "2026-01-01T00:00:00.000Z" });
    const token = "pt-repair-atomic";
    tokens.set(token, { id: token, createdBy: "admin", expiresAt: new Date(Date.now() + 60_000).toISOString() });

    // The peer write fails inside the owned transaction.
    failPeerWrite = true;
    const result = await makePair().post(rePairSignedBody(peer, k, token));

    // Refused by name — not a bare 500.
    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    const json = await res.json();
    expect(res.status).toBe(503);
    expect(json.error).toBe("peer_write_failed");

    // The consume rolled back with the failed peer write: the token is unconsumed
    // and retryable while valid.
    expect(tokens.get(token)?.consumedBy).toBeUndefined();
    expect(tokens.get(token)?.consumedAt).toBeUndefined();
    // And no peer write landed (the row keeps its earlier updatedAt).
    expect(peers.get(peer)?.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("CONTROL: a re-pair whose Peer write succeeds consumes the token and pairs the peer", async () => {
    const k = nacl.sign.keyPair();
    const peer = "flair_spoke_repair_ok";
    const publicKey = Buffer.from(k.publicKey).toString("base64url");
    peers.set(peer, { id: peer, publicKey, role: "spoke", status: "paired", updatedAt: "2026-01-01T00:00:00.000Z" });
    const token = "pt-repair-ok";
    tokens.set(token, { id: token, createdBy: "admin", expiresAt: new Date(Date.now() + 60_000).toISOString() });

    const json = await readBody(await makePair().post(rePairSignedBody(peer, k, token)));

    expect(json.paired).toBe(true);
    expect(tokens.get(token)?.consumedBy).toBe(peer);
    expect(peers.get(peer)?.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });
});

// Keep the installed fake scoped to this file's process, like the other
// isolated mocks (bun runs isolated files one process each).
process.on("exit", () => { (globalThis as any).transaction = savedTransaction; });
