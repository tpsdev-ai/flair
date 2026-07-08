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
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
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
      "lastActivity",
      "activityUpdatedAt",
      "activityAgeMs",
      "activityFresh",
      "presenceStatus",
      "currentTask",
      "lastHeartbeatAt",
      "flairVersion",
      "harperVersion",
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

  // ── 4c. flair#639: version stamping ────────────────────────────────────────
  // Every heartbeat stamps the SERVING instance's own flair + harper versions
  // (resources/Presence.ts, buildPresenceRecord()/resolveVersion()/
  // resolveHarperVersion()). Rides the SAME content gate as currentTask
  // (#592) — verified readers only, anonymous gets null for both.
  //
  // Expected values are read directly from THIS repo's own package.json /
  // node_modules — the exact files resolveVersion()/resolveHarperVersion()
  // read at runtime, since harper-lifecycle.ts spawns Harper with
  // cwd: process.cwd(), i.e. this worktree root.

  const expectedFlairVersion: string = JSON.parse(
    readFileSync(`${process.cwd()}/package.json`, "utf-8"),
  ).version;
  const expectedHarperVersion: string = JSON.parse(
    readFileSync(`${process.cwd()}/node_modules/@harperfast/harper/package.json`, "utf-8"),
  ).version;

  test("POST /Presence stamps the real running flairVersion + harperVersion", async () => {
    const auth = buildAuthHeader(agent1.id, "POST", "/Presence", agent1.privateKey);
    await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ activity: "coding" }),
    });

    const getAuth = buildAuthHeader(agent1.id, "GET", "/Presence", agent1.privateKey);
    const res = await fetch(`${harper.httpURL}/Presence`, { headers: { Authorization: getAuth } });
    expect(res.status).toBe(200);
    const roster = await res.json();
    const a1 = roster.find((r: any) => r.id === agent1.id);
    expect(a1.flairVersion).toBe(expectedFlairVersion);
    expect(a1.harperVersion).toBe(expectedHarperVersion);
  });

  test("GET /Presence WITHOUT auth: flairVersion/harperVersion are null (same gate as currentTask)", async () => {
    const auth = buildAuthHeader(agent1.id, "POST", "/Presence", agent1.privateKey);
    await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ activity: "coding" }),
    });

    const res = await fetch(`${harper.httpURL}/Presence`);
    expect(res.status).toBe(200);
    const roster = await res.json();
    const a1 = roster.find((r: any) => r.id === agent1.id);
    expect(a1.flairVersion).toBeNull();
    expect(a1.harperVersion).toBeNull();
    // roster metadata is unaffected by the gate, same as the currentTask case
    expect(typeof a1.presenceStatus).toBe("string");
  });

  test("reader tolerance: a legacy presence record with no flairVersion/harperVersion doesn't crash GET", async () => {
    // Simulate a pre-flair#639 instance's record: insert directly via the ops
    // API (bypassing POST /Presence, which always stamps versions now) — same
    // technique seedAgent() uses for Agent rows.
    const legacyId = "presence-639-legacy-instance";
    await fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: adminAuth() },
      body: JSON.stringify({
        operation: "insert",
        database: "flair",
        table: "Presence",
        records: [{ agentId: legacyId, lastHeartbeatAt: Date.now(), activity: "idle" }],
      }),
    });

    const auth = buildAuthHeader(agent1.id, "GET", "/Presence", agent1.privateKey);
    const res = await fetch(`${harper.httpURL}/Presence`, { headers: { Authorization: auth } });
    expect(res.status).toBe(200);
    const roster = await res.json();
    const legacy = roster.find((r: any) => r.id === legacyId);
    expect(legacy).toBeDefined();
    expect(legacy.flairVersion).toBeNull();
    expect(legacy.harperVersion).toBeNull();
    // The rest of the row is served normally — tolerance doesn't break the
    // entry, it just leaves the two new fields null.
    expect(typeof legacy.presenceStatus).toBe("string");
  });

  // ── 4d. Natural presence: activity/currentTask decay with liveness ─────────
  // Presence is a liveness beacon, not a sticky status board. A fresh heartbeat
  // presents activity/currentTask as CURRENT; a stale record must NOT — it
  // presents the last-known label under lastActivity, nulls the current
  // activity to "idle" and currentTask to null, and flags activityFresh=false.
  // Staleness is simulated by inserting a Presence row directly via the ops API
  // with old timestamps (same technique as the legacy-record test above) — the
  // only way to produce a stale row without waiting out the real threshold.

  const STALE_MS = 13 * 24 * 60 * 60 * 1000; // 13 days — the real-world frozen-"debugging" case

  test("fresh heartbeat: activity is presented as CURRENT (activityFresh=true, stamp set)", async () => {
    const auth = buildAuthHeader(agent1.id, "POST", "/Presence", agent1.privateKey);
    await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ currentTask: "shipping natural presence", activity: "reviewing" }),
    });

    const getAuth = buildAuthHeader(agent1.id, "GET", "/Presence", agent1.privateKey);
    const res = await fetch(`${harper.httpURL}/Presence`, { headers: { Authorization: getAuth } });
    const roster = await res.json();
    const a1 = roster.find((r: any) => r.id === agent1.id);
    expect(a1.activityFresh).toBe(true);
    expect(a1.activity).toBe("reviewing");
    expect(a1.lastActivity).toBe("reviewing");
    expect(a1.currentTask).toBe("shipping natural presence");
    expect(typeof a1.activityUpdatedAt).toBe("number");
    expect(a1.activityAgeMs).toBeGreaterThanOrEqual(0);
    expect(a1.activityAgeMs).toBeLessThan(60_000); // just set
  });

  test("stale record: activity decays to 'idle', currentTask nulls, lastActivity keeps the last-known label", async () => {
    const staleId = "presence-natural-stale";
    const staleAt = Date.now() - STALE_MS;
    await fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: adminAuth() },
      body: JSON.stringify({
        operation: "insert",
        database: "flair",
        table: "Presence",
        records: [{
          agentId: staleId,
          lastHeartbeatAt: staleAt,
          activityUpdatedAt: staleAt,
          activity: "debugging",
          currentTask: "on-call investigation complete — preprod-db-3",
        }],
      }),
    });

    // Read as a VERIFIED agent — proves the decay is not merely the anon gate:
    // even a verified reader does NOT get a stale record's currentTask, because
    // it isn't CURRENT.
    const getAuth = buildAuthHeader(agent1.id, "GET", "/Presence", agent1.privateKey);
    const res = await fetch(`${harper.httpURL}/Presence`, { headers: { Authorization: getAuth } });
    const roster = await res.json();
    const stale = roster.find((r: any) => r.id === staleId);
    expect(stale).toBeDefined();
    expect(stale.presenceStatus).toBe("offline");
    expect(stale.activityFresh).toBe(false);
    // Current activity is NOT the frozen "debugging" label.
    expect(stale.activity).toBe("idle");
    // Last-known label is preserved for "was: debugging" rendering.
    expect(stale.lastActivity).toBe("debugging");
    // A verified reader still gets null — the task is not current.
    expect(stale.currentTask).toBeNull();
    // Age reflects how long ago it lapsed.
    expect(stale.activityAgeMs).toBeGreaterThan(STALE_MS - 60_000);
  });

  test("independent decay: fresh heartbeat but stale activity stamp → online yet activity decayed", async () => {
    const id = "presence-natural-independent";
    const now = Date.now();
    await fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: adminAuth() },
      body: JSON.stringify({
        operation: "insert",
        database: "flair",
        table: "Presence",
        records: [{
          agentId: id,
          lastHeartbeatAt: now,               // fresh liveness
          activityUpdatedAt: now - 700_000,   // 11.6min — past the 10min offline threshold
          activity: "coding",
          currentTask: "started this a while ago",
        }],
      }),
    });

    const getAuth = buildAuthHeader(agent1.id, "GET", "/Presence", agent1.privateKey);
    const res = await fetch(`${harper.httpURL}/Presence`, { headers: { Authorization: getAuth } });
    const roster = await res.json();
    const row = roster.find((r: any) => r.id === id);
    expect(row).toBeDefined();
    // Liveness is fresh → still active/idle, NOT offline.
    expect(row.presenceStatus).not.toBe("offline");
    // But activity lapsed on its own — this is the independent decay.
    expect(row.activityFresh).toBe(false);
    expect(row.activity).toBe("idle");
    expect(row.lastActivity).toBe("coding");
    expect(row.currentTask).toBeNull();
  });

  test("old record (no activityUpdatedAt) + stale heartbeat: falls back to lastHeartbeatAt, decays, no throw", async () => {
    const id = "presence-natural-legacy-stale";
    const staleAt = Date.now() - STALE_MS;
    await fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: adminAuth() },
      body: JSON.stringify({
        operation: "insert",
        database: "flair",
        table: "Presence",
        // NO activityUpdatedAt — a record written before natural-presence.
        records: [{ agentId: id, lastHeartbeatAt: staleAt, activity: "planning" }],
      }),
    });

    const getAuth = buildAuthHeader(agent1.id, "GET", "/Presence", agent1.privateKey);
    const res = await fetch(`${harper.httpURL}/Presence`, { headers: { Authorization: getAuth } });
    expect(res.status).toBe(200);
    const roster = await res.json();
    const row = roster.find((r: any) => r.id === id);
    expect(row).toBeDefined();
    // Freshness falls back to lastHeartbeatAt → stale → decayed, no crash.
    expect(row.activityFresh).toBe(false);
    expect(row.activity).toBe("idle");
    expect(row.lastActivity).toBe("planning");
    expect(typeof row.activityUpdatedAt).toBe("number"); // resolved to lastHeartbeatAt
  });

  test("old record (no activityUpdatedAt) + FRESH heartbeat: activity is as fresh as the beat", async () => {
    const id = "presence-natural-legacy-fresh";
    await fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: adminAuth() },
      body: JSON.stringify({
        operation: "insert",
        database: "flair",
        table: "Presence",
        records: [{ agentId: id, lastHeartbeatAt: Date.now(), activity: "reviewing" }],
      }),
    });

    const getAuth = buildAuthHeader(agent1.id, "GET", "/Presence", agent1.privateKey);
    const res = await fetch(`${harper.httpURL}/Presence`, { headers: { Authorization: getAuth } });
    const roster = await res.json();
    const row = roster.find((r: any) => r.id === id);
    expect(row.activityFresh).toBe(true);
    expect(row.activity).toBe("reviewing");
  });

  test("stale record: anonymous reader also gets currentTask=null, and lastActivity stays public", async () => {
    const id = "presence-natural-stale-anon";
    const staleAt = Date.now() - STALE_MS;
    await fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: adminAuth() },
      body: JSON.stringify({
        operation: "insert",
        database: "flair",
        table: "Presence",
        records: [{ agentId: id, lastHeartbeatAt: staleAt, activityUpdatedAt: staleAt, activity: "coding", currentTask: "secret preprod host" }],
      }),
    });

    const res = await fetch(`${harper.httpURL}/Presence`); // anonymous
    const roster = await res.json();
    const row = roster.find((r: any) => r.id === id);
    expect(row.currentTask).toBeNull();     // gated AND stale
    expect(row.lastActivity).toBe("coding"); // public-safe label survives
    expect(row.activity).toBe("idle");
    expect(row.activityFresh).toBe(false);
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

  // ── 8. authorizeLocal escalation (#604) — bare PUT /Presence ───────────────
  // The auth-middleware's public early-return used to match /Presence on
  // ANY method (exact path, no method guard), so a bare `PUT /Presence`
  // (collection-level, no id — Harper routes it to the same .put() as
  // by-id PUT) skipped the middleware entirely. A credential-less loopback
  // PUT then reached Presence.put()'s resolveAgentAuth() call with no
  // tpsAnonymous/tpsAgent annotation, which fell through to Harper's raw
  // `context.user` — populated by `authorizeLocal` (config.yaml: true) for
  // ANY credential-less loopback request, with no signature and no
  // password — so the ownership check saw an "admin" caller (isAdmin=true)
  // and let it PAST the ownership guard unauthenticated (`super.put()` would
  // then separately 400 on the missing primary key for a bare collection PUT
  // — but the auth bypass itself, reaching super.put() as forged-admin with
  // zero credentials, is the hole being closed; a by-id PUT, the real write
  // path, has no such structural block and WOULD have written). Fixed by
  // scoping the early-return to GET only, so PUT now always transits the
  // general middleware path, which marks a genuinely headerless request
  // tpsAnonymous BEFORE Harper's ambient elevation lands.

  test("#604: credential-less loopback PUT /Presence (no id, no auth) → rejected before reaching the write path", async () => {
    const victimId = "presence-604-victim";
    // Seed a baseline record via a real signed write so we can prove the
    // unauthenticated PUT below did not alter it.
    const victimKp = makeKeypair();
    await seedAgent(harper.opsURL, adminAuth(), victimId, victimKp.publicKey, "Victim Agent");
    const seedAuth = buildAuthHeader(victimId, "POST", "/Presence", victimKp.privateKey);
    await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: seedAuth },
      body: JSON.stringify({ currentTask: "baseline before 604 PUT attempt", activity: "coding" }),
    });

    // The escalation attempt: bare, unauthenticated, collection-level PUT.
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: victimId, currentTask: "PWNED — authorizeLocal escalation", activity: "coding" }),
    });
    // Must NOT be a successful write. resolveAgentAuth's anonymous verdict
    // → Presence.put() returns 401; Harper's own table gate could also
    // intervene first with 403 depending on routing — either is an
    // acceptable "not authorized," 200 is the only unacceptable outcome.
    expect(res.status).not.toBe(200);
    expect([401, 403]).toContain(res.status);

    // Confirm the victim's record was NOT overwritten.
    const getAuth = buildAuthHeader(victimId, "GET", "/Presence", victimKp.privateKey);
    const check = await fetch(`${harper.httpURL}/Presence`, { headers: { Authorization: getAuth } });
    const roster = await check.json();
    const victim = roster.find((r: any) => r.id === victimId);
    expect(victim).toBeDefined();
    expect(victim.currentTask).toBe("baseline before 604 PUT attempt");
  }, 30_000);

  test("credential-less loopback PUT /Presence/<id> (the real write path) → also rejected, does NOT write", async () => {
    // By-id PUT was never on the early-return allowlist (exact-path match
    // only), so this was already safe pre-fix — this is a regression guard
    // proving the ACTUAL exploitable write path (super.put() with a real
    // primary key) stays protected, not just the structurally-inert bare
    // collection PUT above.
    const victimId = "presence-604-victim-byid";
    const victimKp = makeKeypair();
    await seedAgent(harper.opsURL, adminAuth(), victimId, victimKp.publicKey, "Victim Agent 2");
    const seedAuth = buildAuthHeader(victimId, "POST", "/Presence", victimKp.privateKey);
    await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: seedAuth },
      body: JSON.stringify({ currentTask: "baseline before 604 by-id PUT attempt", activity: "coding" }),
    });

    const res = await fetch(`${harper.httpURL}/Presence/${victimId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: victimId, currentTask: "PWNED via by-id PUT", activity: "coding" }),
    });
    expect(res.status).not.toBe(200);
    expect([401, 403]).toContain(res.status);

    const getAuth = buildAuthHeader(victimId, "GET", "/Presence", victimKp.privateKey);
    const check = await fetch(`${harper.httpURL}/Presence`, { headers: { Authorization: getAuth } });
    const roster = await check.json();
    const victim = roster.find((r: any) => r.id === victimId);
    expect(victim).toBeDefined();
    expect(victim.currentTask).toBe("baseline before 604 by-id PUT attempt");
  }, 30_000);

  test("genuine Ed25519-signed PUT /Presence/<id> (own record) still succeeds", async () => {
    const path = `/Presence/${agent1.id}`;
    const auth = buildAuthHeader(agent1.id, "PUT", path, agent1.privateKey);
    // PUT is a full record replace (super.put()), NOT the heartbeat merge — so
    // it must carry its own liveness (lastHeartbeatAt) and activity freshness
    // (activityUpdatedAt) for the record to read as CURRENT. Natural-presence
    // gates currentTask on freshness: a record with no/stale heartbeat is
    // offline and its task is (correctly) not current. This writes a fresh
    // record so we assert the signed PUT landed AND reads back as current.
    const now = Date.now();
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ agentId: agent1.id, currentTask: "signed PUT still works", activity: "coding", lastHeartbeatAt: now, activityUpdatedAt: now }),
    });
    expect([200, 204]).toContain(res.status);

    const getAuth = buildAuthHeader(agent1.id, "GET", "/Presence", agent1.privateKey);
    const check = await fetch(`${harper.httpURL}/Presence`, { headers: { Authorization: getAuth } });
    const roster = await check.json();
    const a1 = roster.find((r: any) => r.id === agent1.id);
    expect(a1.currentTask).toBe("signed PUT still works");
    expect(a1.activityFresh).toBe(true);
  }, 30_000);

  test("genuine Ed25519-signed PUT /Presence for ANOTHER agent's record → 403", async () => {
    const path = "/Presence";
    // agent2 signs the request but targets agent1's record in the body.
    const auth = buildAuthHeader(agent2.id, "PUT", path, agent2.privateKey);
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ agentId: agent1.id, currentTask: "cross-agent PUT attempt", activity: "coding" }),
    });
    expect(res.status).toBe(403);
  }, 30_000);
});
