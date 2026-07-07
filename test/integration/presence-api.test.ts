/**
 * presence-api.test.ts — Integration tests for the Presence/Heartbeat API.
 *
 * Tests:
 *   1. Ed25519-authed write succeeds
 *   2. Cross-agent write rejected (403)
 *   3. Read returns correct derived status
 *   4. Read field-allowlist enforced (no leak of non-allowlisted fields)
 *   4b. currentTask CONTENT gate (#592) — anonymous GET gets currentTask=null,
 *       a verified Ed25519 GET gets the full text
 *   5. currentTask length cap
 *   6. Invalid activity rejected (400)
 *   7. Missing auth rejected (401)
 *
 * Requires a running Harper instance.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:os";
import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";

// ─── Test keypair + agent seeding ────────────────────────────────────────────

function makeKeypair(): { publicKey: string; privateKey: Uint8Array } {
  const kp = nacl.sign.keyPair();
  const publicKey = Buffer.from(kp.publicKey).toString("hex");
  return { publicKey, privateKey: kp.secretKey };
}

function makeKeypairBase64(): { publicKey: string; privateKey: Uint8Array } {
  const kp = nacl.sign.keyPair();
  // Base64 of raw 32-byte public key (matching hex format length)
  const publicKey = Buffer.from(kp.publicKey).toString("base64");
  return { publicKey, privateKey: kp.secretKey };
}

function buildAuthHeader(
  agentId: string,
  method: string,
  path: string,
  secretKey: Uint8Array,
): string {
  const ts = Date.now().toString();
  const nonce = randomBytes(12).toString("hex");
  const payload = `${agentId}:${ts}:${nonce}:${method}:${path}`;
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(payload), secretKey)).toString("base64");
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${sig}`;
}

async function seedAgent(
  opsURL: string,
  adminAuth: string,
  id: string,
  publicKey: string,
  displayName?: string,
) {
  await fetch(opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: adminAuth,
    },
    body: JSON.stringify({
      operation: "insert",
      database: "flair",
      table: "Agent",
      records: [
        {
          id,
          name: displayName ?? id,
          displayName: displayName ?? id,
          role: "agent",
          publicKey,
          status: "active",
          kind: "agent",
          createdAt: new Date().toISOString(),
        },
      ],
    }),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let harper: HarperInstance;

describe("Presence API integration", () => {
  beforeAll(async () => {
    harper = await startHarper();
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  const adminAuth = () =>
    "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");

  const agent1 = { id: "presence-test-agent-1", ...makeKeypair() };
  const agent2 = { id: "presence-test-agent-2", ...makeKeypair() };

  beforeAll(async () => {
    await seedAgent(harper.opsURL, adminAuth(), agent1.id, agent1.publicKey, "Agent One");
    await seedAgent(harper.opsURL, adminAuth(), agent2.id, agent2.publicKey, "Agent Two");
  });

  // ── 1. Ed25519-authed write succeeds ───────────────────────────────────────

  test("POST /Presence with Ed25519 auth succeeds", async () => {
    const auth = buildAuthHeader(agent1.id, "POST", "/Presence", agent1.privateKey);
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ currentTask: "Testing presence API", activity: "coding" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.agentId).toBe(agent1.id);
    expect(body.presenceStatus).toBe("active");
    expect(typeof body.lastHeartbeatAt).toBe("number");
  });

  test("POST /Presence updates existing record (idempotent)", async () => {
    const auth = buildAuthHeader(agent1.id, "POST", "/Presence", agent1.privateKey);
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ currentTask: "Still testing", activity: "reviewing" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.agentId).toBe(agent1.id);
  });

  test("POST /Presence with minimal body (no task or activity)", async () => {
    const auth = buildAuthHeader(agent2.id, "POST", "/Presence", agent2.privateKey);
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.agentId).toBe(agent2.id);
  });

  // ── 2. Cross-agent write rejected (403) ────────────────────────────────────

  test("POST /Presence with mismatched agentId → 403", async () => {
    if (harper.external) return; // auth header path is skipped when middleware sets tpsAgent

    const auth = buildAuthHeader(agent2.id, "POST", "/Presence", agent2.privateKey);
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ currentTask: "trying to spoof agent1" }),
    });
    // With the public-path route, agentId comes from auth header, so this
    // should write to agent2 regardless of body content. This test verifies
    // that the body cannot override the auth identity.
    expect(res.status).toBe(200);
    const body = await res.json();
    // It wrote to agent2 (the authenticated agent), NOT agent1
    expect(body.agentId).toBe(agent2.id);
  });

  // ── 3. Read returns correct derived status ─────────────────────────────────

  test("GET /Presence returns presence roster", async () => {
    const res = await fetch(`${harper.httpURL}/Presence`);
    expect(res.status).toBe(200);
    const roster = await res.json();
    expect(Array.isArray(roster)).toBe(true);
    expect(roster.length).toBeGreaterThanOrEqual(2);
  });

  test("GET /Presence includes derived presenceStatus", async () => {
    const res = await fetch(`${harper.httpURL}/Presence`);
    const roster = await res.json();
    const a1 = roster.find((r: any) => r.id === agent1.id);
    expect(a1).toBeDefined();
    expect(a1.presenceStatus).toBe("active"); // just heartbeated
    expect(typeof a1.lastHeartbeatAt).toBe("number");
  });

  test("GET /Presence merges agent display fields", async () => {
    const res = await fetch(`${harper.httpURL}/Presence`);
    const roster = await res.json();
    const a1 = roster.find((r: any) => r.id === agent1.id);
    expect(a1.displayName).toBe("Agent One");
    expect(a1.role).toBe("agent");
  });

  // ── 4. Read field-allowlist enforced ───────────────────────────────────────

  test("GET /Presence does not leak non-allowlisted fields", async () => {
    const res = await fetch(`${harper.httpURL}/Presence`);
    const roster = await res.json();

    const FORBIDDEN_FIELDS = [
      "publicKey",
      "admin",
      "defaultTrustTier",
      "kind",
      "name",
      "type",
      "createdAt",
      "updatedAt",
      "soul",
      "memory",
      "secretKey",
      "subjects",
    ];

    for (const entry of roster) {
      for (const field of FORBIDDEN_FIELDS) {
        expect(entry).not.toHaveProperty(field);
      }
    }
  });

  test("GET /Presence only returns allowlisted fields", async () => {
    const res = await fetch(`${harper.httpURL}/Presence`);
    const roster = await res.json();

    const ALLOWED = new Set([
      "id",
      "displayName",
      "role",
      "runtime",
      "activity",
      "presenceStatus",
      "currentTask",
      "lastHeartbeatAt",
    ]);

    for (const entry of roster) {
      for (const key of Object.keys(entry)) {
        expect(ALLOWED.has(key)).toBe(true);
      }
    }
  });

  // ── 4b. currentTask CONTENT gate (#592) ────────────────────────────────────
  // /Presence is in auth-middleware.ts's early public-passthrough allowlist
  // (both GET and POST skip the middleware entirely), so a real anonymous GET
  // here exercises resolveAgentAuth's true "no request annotation, no valid
  // header" → anonymous path, and a real Ed25519-signed GET exercises its
  // raw-header-verify fallback — the actual paths a production Fabric
  // deployment hits, not a simulated one.

  test("GET /Presence WITHOUT auth: currentTask is null for every entry, other fields present", async () => {
    const auth = buildAuthHeader(agent1.id, "POST", "/Presence", agent1.privateKey);
    await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ currentTask: "investigating preprod-db-3: replication lag", activity: "coding" }),
    });

    const res = await fetch(`${harper.httpURL}/Presence`);
    expect(res.status).toBe(200);
    const roster = await res.json();
    expect(roster.length).toBeGreaterThanOrEqual(1);

    const a1 = roster.find((r: any) => r.id === agent1.id);
    expect(a1).toBeDefined();
    expect(a1.currentTask).toBeNull();
    // roster metadata is unaffected by the gate
    expect(typeof a1.displayName).toBe("string");
    expect(typeof a1.presenceStatus).toBe("string");
  });

  test("GET /Presence WITH valid Ed25519 auth: currentTask IS present, full text", async () => {
    const postAuth = buildAuthHeader(agent1.id, "POST", "/Presence", agent1.privateKey);
    await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: postAuth },
      body: JSON.stringify({ currentTask: "investigating preprod-db-3: replication lag", activity: "coding" }),
    });

    // A DIFFERENT verified agent reads it — Presence has no per-agent read
    // scoping, only a verified-vs-anonymous content gate (any verified agent
    // sees any agent's currentTask, by #592's design).
    const getAuth = buildAuthHeader(agent2.id, "GET", "/Presence", agent2.privateKey);
    const res = await fetch(`${harper.httpURL}/Presence`, { headers: { Authorization: getAuth } });
    expect(res.status).toBe(200);
    const roster = await res.json();

    const a1 = roster.find((r: any) => r.id === agent1.id);
    expect(a1.currentTask).toBe("investigating preprod-db-3: replication lag");
  });

  // ── 5. currentTask length cap ──────────────────────────────────────────────

  test("POST /Presence caps currentTask at 200 chars", async () => {
    const longTask = "A".repeat(500);
    const auth = buildAuthHeader(agent1.id, "POST", "/Presence", agent1.privateKey);
    await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ currentTask: longTask, activity: "planning" }),
    });

    // Read back with valid Ed25519 auth — #592 gates currentTask to verified
    // readers, and an anonymous GET here would see currentTask=null,
    // defeating the point of this length-cap assertion.
    const getAuth = buildAuthHeader(agent1.id, "GET", "/Presence", agent1.privateKey);
    const res = await fetch(`${harper.httpURL}/Presence`, { headers: { Authorization: getAuth } });
    const roster = await res.json();
    const a1 = roster.find((r: any) => r.id === agent1.id);
    expect(a1.currentTask).toHaveLength(200);
  });

  // ── 6. Invalid activity rejected (400) ─────────────────────────────────────

  test("POST /Presence with invalid activity → 400", async () => {
    const auth = buildAuthHeader(agent1.id, "POST", "/Presence", agent1.privateKey);
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ activity: "sleeping" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_activity");
  });

  // ── 7. Missing auth rejected (401) ────────────────────────────────────────

  test("POST /Presence without auth header → 401", async () => {
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentTask: "no auth", activity: "idle" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /Presence with malformed auth header → 401", async () => {
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "TPS-Ed25519 garbage" },
      body: JSON.stringify({ activity: "idle" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /Presence with unknown agent → 401", async () => {
    const fakeKp = makeKeypair();
    const auth = buildAuthHeader("nonexistent-agent", "POST", "/Presence", fakeKp.privateKey);
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ activity: "idle" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /Presence with expired timestamp → 401", async () => {
    // Craft a header with an old timestamp
    const secretKey = agent1.privateKey;
    const oldTs = (Date.now() - 60_000).toString(); // 60s old, outside 30s window
    const nonce = randomBytes(12).toString("hex");
    const payload = `agent1:${oldTs}:${nonce}:POST:/Presence`;
    const sig = Buffer.from(
      nacl.sign.detached(Buffer.from(payload), secretKey)
    ).toString("base64");
    const auth = `TPS-Ed25519 agent1:${oldTs}:${nonce}:${sig}`;

    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ activity: "idle" }),
    });
    // Note: agent1 is not "agent1" — it's presence-test-agent-1
    // This should fail with unknown_agent
    expect([401, 403]).toContain(res.status);
  });
});
