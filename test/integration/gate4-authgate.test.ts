// gate4-authgate.test.ts — Integration tests for the 4 resources surfaced by
// the flair#614 CI-assertion backstop (test/unit/resource-allow-decision.test.ts's
// NEEDS_HUMAN_REVIEW list): FederationInstance, FederationPeers, HealthDetail,
// SkillScan. Same authorizeLocal-escalation class as #601/#604/#609/#612.
//
// Each of these four had NO allow* override at all, so Harper's own default
// (`user?.role.permission.super_user`, satisfiable by a genuine admin OR by
// authorizeLocal's forged loopback super_user for ANY credential-less
// LOOPBACK request) silently stood in. Verified empirically pre-fix: a bare
// credential-less `fetch(harper.httpURL + "/FederationInstance")` (no
// Authorization header at all) returned 200 with full instance identity,
// full peer list, full HealthDetail stats (with `caller.isAdmin: true` for
// the unresolved caller — the sharpest of the four), and a working SkillScan
// result — zero credentials required, from loopback.
//
// FederationInstance/FederationPeers → allowRead()=allowAdmin (admin views,
// matching AdminInstance.ts/AdminDashboard.ts's idiom).
// HealthDetail → allowRead()=allowVerified (matches its own docstring's
// stated, previously-unenforced intent) + fixes the backwards internal
// `isAdmin = tpsAgentIsAdmin === true || !callerAgent` default (an unresolved
// caller no longer defaults to admin).
// SkillScan → allowCreate()=allowVerified (matches its own docstring's
// stated, previously-unenforced intent — stateless text scanner, no
// agent/memory data touched, so any verified agent may call it).
//
// MODEL: test/integration/credential-allowread-authgate.test.ts (the
// allowRead-gate proof pattern) + test/integration/flair-agent-deelevation.test.ts
// (the admin-vs-non-admin agent seeding pattern for allowAdmin-gated
// resources).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(op),
  });
}

let harper: HarperInstance;
const nonAdmin = mkAgent("gate4-nonadmin");
const admin = mkAgent("gate4-admin");
const seededPeerId = `gate4-peer-${randomUUID()}`;

describe("flair#614 backstop follow-up: FederationInstance/FederationPeers/HealthDetail/SkillScan gates", () => {
  beforeAll(async () => {
    harper = await startHarper();

    const nonAdminRes = await adminOp(harper, {
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: nonAdmin.id, name: nonAdmin.id, role: "agent", publicKey: nonAdmin.publicKey, createdAt: new Date().toISOString() }],
    });
    expect(nonAdminRes.status).toBe(200);

    const adminRes = await adminOp(harper, {
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: admin.id, name: admin.id, role: "admin", publicKey: admin.publicKey, createdAt: new Date().toISOString() }],
    });
    expect(adminRes.status).toBe(200);

    // Seed a Peer record so FederationPeers has something to (not) leak, and
    // an Instance row so FederationInstance/HealthDetail's federation block
    // has real data.
    const peerKp = nacl.sign.keyPair();
    const peerRes = await adminOp(harper, {
      operation: "insert", database: "flair", table: "Peer",
      records: [{
        id: seededPeerId,
        publicKey: Buffer.from(peerKp.publicKey).toString("base64url"),
        role: "spoke", status: "connected", endpoint: "https://peer.example",
        relayOnly: false, pairedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }],
    });
    expect(peerRes.status, `Peer insert returned ${peerRes.status}: ${await peerRes.text()}`).toBe(200);
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  // ── FederationInstance (allowRead → allowAdmin) ───────────────────────────

  describe("FederationInstance", () => {
    test("credential-less loopback GET → denied (was 200 pre-fix, forged-admin reachable)", async () => {
      const res = await fetch(`${harper.httpURL}/FederationInstance`);
      const text = await res.text();
      expect(res.status, `anon GET /FederationInstance returned ${res.status}: ${text.slice(0, 200)}`).toBe(403);
    }, 30_000);

    test("non-admin verified agent GET → denied", async () => {
      const path = "/FederationInstance";
      const res = await fetch(`${harper.httpURL}${path}`, {
        headers: { Authorization: ed25519Header(nonAdmin, "GET", path) },
      });
      expect(res.status, `non-admin GET ${path} returned ${res.status}`).toBe(403);
    }, 30_000);

    test("admin verified agent GET → authorized, returns instance identity", async () => {
      const path = "/FederationInstance";
      const res = await fetch(`${harper.httpURL}${path}`, {
        headers: { Authorization: ed25519Header(admin, "GET", path) },
      });
      const text = await res.text();
      expect(res.status, `admin GET ${path} returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
      const body = JSON.parse(text);
      expect(body.id).toBeTruthy();
      expect(body.publicKey).toBeTruthy();
    }, 30_000);
  });

  // ── FederationPeers (allowRead → allowAdmin) ──────────────────────────────

  describe("FederationPeers", () => {
    test("credential-less loopback GET → denied (was 200 pre-fix, leaked full peer list)", async () => {
      const res = await fetch(`${harper.httpURL}/FederationPeers`);
      const text = await res.text();
      expect(res.status, `anon GET /FederationPeers returned ${res.status}: ${text.slice(0, 200)}`).toBe(403);
      expect(text).not.toContain(seededPeerId);
    }, 30_000);

    test("non-admin verified agent GET → denied", async () => {
      const path = "/FederationPeers";
      const res = await fetch(`${harper.httpURL}${path}`, {
        headers: { Authorization: ed25519Header(nonAdmin, "GET", path) },
      });
      const text = await res.text();
      expect(res.status, `non-admin GET ${path} returned ${res.status}`).toBe(403);
      expect(text).not.toContain(seededPeerId);
    }, 30_000);

    test("admin verified agent GET → authorized, returns the seeded peer", async () => {
      const path = "/FederationPeers";
      const res = await fetch(`${harper.httpURL}${path}`, {
        headers: { Authorization: ed25519Header(admin, "GET", path) },
      });
      const text = await res.text();
      expect(res.status, `admin GET ${path} returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
      const body = JSON.parse(text);
      expect(body.peers.some((p: any) => p.id === seededPeerId)).toBe(true);
    }, 30_000);
  });

  // ── HealthDetail (allowRead → allowVerified; isAdmin default fix) ─────────

  describe("HealthDetail", () => {
    test("credential-less loopback GET → denied (was 200 pre-fix WITH caller.isAdmin:true — the backwards-default bug)", async () => {
      const res = await fetch(`${harper.httpURL}/HealthDetail`);
      const text = await res.text();
      expect(res.status, `anon GET /HealthDetail returned ${res.status}: ${text.slice(0, 300)}`).toBe(403);
      // Belt-and-suspenders: the pre-fix leak specifically included
      // `"isAdmin":true` in the body for this exact unauthenticated request —
      // confirm no body carrying that claim escapes even if the status check
      // above regresses.
      expect(text).not.toContain('"isAdmin":true');
    }, 30_000);

    test("non-admin verified agent GET → authorized, caller.isAdmin is false (NOT the old unresolved->true default)", async () => {
      const path = "/HealthDetail";
      const res = await fetch(`${harper.httpURL}${path}`, {
        headers: { Authorization: ed25519Header(nonAdmin, "GET", path) },
      });
      const text = await res.text();
      expect(res.status, `non-admin GET ${path} returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
      const body = JSON.parse(text);
      expect(body.caller.agentId).toBe(nonAdmin.id);
      expect(body.caller.isAdmin).toBe(false);
      // Admin-only fields must be redacted for a non-admin caller.
      expect(body.agents.names).toBeUndefined();
      expect(body.federation?.peerList).toBeUndefined();
    }, 30_000);

    test("admin verified agent GET → authorized, caller.isAdmin is true, full detail returned", async () => {
      const path = "/HealthDetail";
      const res = await fetch(`${harper.httpURL}${path}`, {
        headers: { Authorization: ed25519Header(admin, "GET", path) },
      });
      const text = await res.text();
      expect(res.status, `admin GET ${path} returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
      const body = JSON.parse(text);
      expect(body.caller.agentId).toBe(admin.id);
      expect(body.caller.isAdmin).toBe(true);
      expect(Array.isArray(body.agents.names)).toBe(true);
      expect(body.federation?.peerList?.some((p: any) => p.id === seededPeerId)).toBe(true);
    }, 30_000);
  });

  // ── SkillScan (allowCreate → allowVerified) ───────────────────────────────

  describe("SkillScan", () => {
    const scanBody = JSON.stringify({ content: "echo hi | rm -rf /tmp/x" });

    test("credential-less loopback POST → denied (was 200 pre-fix)", async () => {
      const res = await fetch(`${harper.httpURL}/SkillScan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: scanBody,
      });
      const text = await res.text();
      expect(res.status, `anon POST /SkillScan returned ${res.status}: ${text.slice(0, 200)}`).toBe(403);
    }, 30_000);

    test("non-admin verified agent POST → authorized (any verified agent, not admin-only)", async () => {
      const path = "/SkillScan";
      const res = await fetch(`${harper.httpURL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: ed25519Header(nonAdmin, "POST", path) },
        body: scanBody,
      });
      const text = await res.text();
      expect(res.status, `non-admin POST ${path} returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
      const body = JSON.parse(text);
      expect(typeof body.safe).toBe("boolean");
      expect(Array.isArray(body.violations)).toBe(true);
    }, 30_000);

    test("admin verified agent POST → authorized", async () => {
      const path = "/SkillScan";
      const res = await fetch(`${harper.httpURL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: ed25519Header(admin, "POST", path) },
        body: scanBody,
      });
      expect(res.status, `admin POST ${path} returned ${res.status}`).toBe(200);
    }, 30_000);
  });
});
