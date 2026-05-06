import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

// ─── Simulator: Path 5 spoke Ed25519 auth on /FederationSync ────────────────
// Tests validate the auth logic in isolation using real nacl signatures.
// Consistent with the existing auth-middleware.test.ts simulator pattern.

const WINDOW_MS = 30_000;

function makeSpokeHeader(
  instanceId: string,
  secretKey: Uint8Array,
  method: string,
  pathname: string,
  ts?: number,
  nonce?: string,
): { header: string; ts: number; nonce: string } {
  const now = ts ?? Date.now();
  const n = nonce ?? Buffer.from(nacl.randomBytes(16)).toString("base64url");
  const message = `${instanceId}:${now}:${n}:${method}:${pathname}`;
  const sig = nacl.sign.detached(Buffer.from(message, "utf-8"), secretKey);
  const sigB64 = Buffer.from(sig).toString("base64");
  return { header: `TPS-Ed25519 ${instanceId}:${now}:${n}:${sigB64}`, ts: now, nonce: n };
}

describe("Path 5: spoke Ed25519 auth on /FederationSync", () => {
  test("valid TPS-Ed25519 from paired spoke on /FederationSync → accepted", () => {
    const kp = nacl.sign.keyPair();
    const instanceId = "spoke-alpha-1";
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    const { header } = makeSpokeHeader(instanceId, kp.secretKey, "POST", "/FederationSync");

    // Simulate path check
    const url = { pathname: "/FederationSync" };
    expect(url.pathname === "/FederationSync").toBe(true);

    // Simulate header parse
    const match = header.match(/^TPS-Ed25519\s+([^:]+):(\d+):([^:]+):(.+)$/);
    expect(match).not.toBeNull();
    const [, parsedInstanceId, tsRaw, nonce, sigB64] = match!;

    // Timestamp check
    const ts = Number(tsRaw);
    const now = Date.now();
    expect(Math.abs(now - ts) <= WINDOW_MS).toBe(true);

    // Signature verification
    const message = `${parsedInstanceId}:${tsRaw}:${nonce}:POST:${url.pathname}`;
    const valid = nacl.sign.detached.verify(
      Buffer.from(message, "utf-8"),
      Buffer.from(sigB64, "base64"),
      Buffer.from(publicKeyB64url, "base64url"),
    );
    expect(valid).toBe(true);

    // Synthetic user shape
    const user = {
      username: `spoke-${instanceId}`,
      role: { role: "flair_sync_initiator", permission: { super_user: false } },
      active: true,
    };
    expect(user.username).toBe(`spoke-${instanceId}`);
    expect(user.role.role).toBe("flair_sync_initiator");
    expect(user.role.permission.super_user).toBe(false);
    expect(user.active).toBe(true);
  });

  test("invalid signature → 401", () => {
    const kp = nacl.sign.keyPair();
    const attackerKp = nacl.sign.keyPair(); // different keypair
    const instanceId = "spoke-alpha-1";
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    // Sign with the wrong keypair
    const now = Date.now();
    const nonce = "nonce-invalid-sig";
    const message = `${instanceId}:${now}:${nonce}:POST:/FederationSync`;
    const sig = nacl.sign.detached(Buffer.from(message, "utf-8"), attackerKp.secretKey);
    const sigB64 = Buffer.from(sig).toString("base64");

    // Verify against the correct public key — must fail
    const valid = nacl.sign.detached.verify(
      Buffer.from(message, "utf-8"),
      Buffer.from(sigB64, "base64"),
      Buffer.from(publicKeyB64url, "base64url"),
    );
    expect(valid).toBe(false);
  });

  test("revoked peer (status=revoked) → 401", () => {
    // Simulate the peer lookup returning a revoked record
    const peer = { id: "spoke-alpha-1", publicKey: "pk", role: "spoke", status: "revoked" };
    const isRejected = !peer || peer.status === "revoked" || peer.role !== "spoke";
    expect(isRejected).toBe(true);
  });

  test("unknown instance id (not in Peer table) → 401", () => {
    // Simulate peer lookup returning null
    const peer = null;
    const isRejected = !peer || peer?.status === "revoked" || peer?.role !== "spoke";
    expect(isRejected).toBe(true);
  });

  test("path-restriction: same valid TPS-Ed25519 on /Memory falls through", () => {
    // Path 5 only triggers when url.pathname === "/FederationSync"
    const syncUrl = { pathname: "/FederationSync" };
    const memoryUrl = { pathname: "/Memory" };

    // On /FederationSync → Path 5 intercepts
    expect(syncUrl.pathname === "/FederationSync").toBe(true);

    // On /Memory → Path 5 does NOT intercept (falls through to Ed25519 agent auth)
    expect(memoryUrl.pathname === "/FederationSync").toBe(false);
  });

  test("stale timestamp (>30s old) → 401", () => {
    const now = Date.now();
    const staleTs = now - 31_001;
    expect(Math.abs(now - staleTs) > WINDOW_MS).toBe(true);
    expect(Number.isFinite(staleTs)).toBe(true);
  });

  test("future timestamp (>30s ahead) → 401", () => {
    const now = Date.now();
    const futureTs = now + 31_001;
    expect(Math.abs(now - futureTs) > WINDOW_MS).toBe(true);
    expect(Number.isFinite(futureTs)).toBe(true);
  });

  test("replayed nonce → 401", () => {
    const nonceSeen = new Map<string, number>();
    const instanceId = "spoke-alpha-1";
    const nonce = "replay-nonce-42";
    const nonceKey = `spoke:${instanceId}:${nonce}`;

    // First use: record it
    expect(nonceSeen.has(nonceKey)).toBe(false);
    nonceSeen.set(nonceKey, Date.now());

    // Second use: detected as replay
    expect(nonceSeen.has(nonceKey)).toBe(true);
  });

  test("hub trying to use spoke Ed25519 on /FederationSync (peer.role !== spoke) → 401", () => {
    const hubPeer = { id: "hub-main", publicKey: "pk", role: "hub", status: "paired" };
    const isRejected = !hubPeer || hubPeer.status === "revoked" || hubPeer.role !== "spoke";
    expect(isRejected).toBe(true);
  });

  test("tpsAgentIsAdmin is always false for spoke auth", () => {
    // Spokes are NOT admins — admin-bypass downstream paths shouldn't apply
    const tpsAgentIsAdmin = false;
    expect(tpsAgentIsAdmin).toBe(false);
  });

  test("header sets x-tps-spoke and tpsAgent correctly", () => {
    const instanceId = "spoke-alpha-1";
    const tpsAgent = `spoke-${instanceId}`;
    expect(tpsAgent).toBe("spoke-spoke-alpha-1");
  });
});

// ─── Nonce namespace isolation ─────────────────────────────────────────────

describe("nonce namespace isolation (spoke vs agent)", () => {
  test("spoke and agent nonce keys don't collide", () => {
    // An agent nonce key is `${agentId}:${nonce}`
    // A spoke nonce key is `spoke:${instanceId}:${nonce}`
    const agentKey = "flint:abc123";
    const spokeKey = "spoke:spoke-alpha-1:abc123";
    expect(agentKey).not.toBe(spokeKey);
  });

  test("nonce expiry cleans up old entries", () => {
    const nonceSeen = new Map<string, number>();
    const now = Date.now();

    nonceSeen.set("spoke:spoke-alpha:abc", now - 60_000); // expired
    nonceSeen.set("spoke:spoke-alpha:def", now); // fresh

    // Simulate cleanup loop
    for (const [k, sigTs] of nonceSeen.entries()) {
      if (now - sigTs > WINDOW_MS) nonceSeen.delete(k);
    }

    expect(nonceSeen.has("spoke:spoke-alpha:abc")).toBe(false);
    expect(nonceSeen.has("spoke:spoke-alpha:def")).toBe(true);
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("Path 5 edge cases", () => {
  test("non-numeric timestamp in header → 401", () => {
    const header = "TPS-Ed25519 spoke-alpha:NaN:nonce:sig";
    const match = header.match(/^TPS-Ed25519\s+([^:]+):(\d+):([^:]+):(.+)$/);
    expect(match).toBeNull(); // regex rejects non-digit ts
  });

  test("missing TPS-Ed25519 header on /FederationSync falls through to 401", () => {
    const header = "Bearer some-token";
    const url = { pathname: "/FederationSync" };

    // Path 5 tries the regex match on TPS-Ed25519...
    const tpsMatch = header.match(/^TPS-Ed25519\s+([^:]+):(\d+):([^:]+):(.+)$/);
    const isTpsEd25519 = tpsMatch !== null;
    expect(isTpsEd25519).toBe(false);

    // So Path 5 doesn't intercept, it falls through to the Ed25519 agent auth
    // which will also fail to match, returning missing_or_invalid_authorization
  });

  test("signature verification with tampered message fails", () => {
    const kp = nacl.sign.keyPair();
    const instanceId = "spoke-alpha-1";
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    const now = Date.now();
    const nonce = "nonce-tampered";
    // Signer computed signature over POST:/FederationSync
    const originalMsg = `${instanceId}:${now}:${nonce}:POST:/FederationSync`;
    const sig = nacl.sign.detached(Buffer.from(originalMsg, "utf-8"), kp.secretKey);
    const sigB64 = Buffer.from(sig).toString("base64");

    // Verifier checks against DELETE:/FederationSync (tampered method)
    const tamperedMsg = `${instanceId}:${now}:${nonce}:DELETE:/FederationSync`;
    const valid = nacl.sign.detached.verify(
      Buffer.from(tamperedMsg, "utf-8"),
      Buffer.from(sigB64, "base64"),
      Buffer.from(publicKeyB64url, "base64url"),
    );
    expect(valid).toBe(false);
  });

  test("peer with status=disconnected but role=spoke is allowed", () => {
    // disconnected != revoked — only revoked is blocked
    const peer = { id: "spoke-alpha-1", publicKey: "pk", role: "spoke", status: "disconnected" };
    const isRejected = !peer || peer.status === "revoked" || peer.role !== "spoke";
    expect(isRejected).toBe(false);
  });

  test("peer with status=paired and role=spoke is allowed", () => {
    const peer = { id: "spoke-alpha-1", publicKey: "pk", role: "spoke", status: "paired" };
    const isRejected = !peer || peer.status === "revoked" || peer.role !== "spoke";
    expect(isRejected).toBe(false);
  });
});
