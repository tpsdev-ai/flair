/**
 * presence-read-gate.test.ts — Integration tests for the flair#1880
 * verified-reader default on GET /Presence, plus the `PRESENCE_PUBLIC_ROSTER`
 * opt-in that restores the pre-#1880 anonymous roster.
 *
 * The read gate is driven by an ENV VAR read at REQUEST time inside the Harper
 * process (resources/Presence.ts, publicRosterEnabled()). Each state therefore
 * needs its own Harper boot with the variable set for that child:
 *
 *   - default (variable ABSENT) → anonymous 401; verified agent full row;
 *     admin credential reads the roster.
 *   - explicitly `false`       → anonymous 401 (same as absent).
 *   - `true`                   → anonymous gets today's allowlisted roster with
 *                                the gated fields null.
 *
 * The child inherits the variable via harper-lifecycle's `{ ...process.env }`
 * spread at spawn time, so we set it immediately before startHarper() and
 * restore it immediately after — the running child keeps its own copy.
 *
 * Real Harper, real spawn, real Ed25519 signatures (mirrors
 * test/integration/presence-api.test.ts's harness conventions).
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeKeypair(): { publicKey: string; privateKey: Uint8Array } {
  const kp = nacl.sign.keyPair();
  return { publicKey: Buffer.from(kp.publicKey).toString("hex"), privateKey: kp.secretKey };
}

function buildAuthHeader(agentId: string, method: string, path: string, secretKey: Uint8Array): string {
  const ts = Date.now().toString();
  const nonce = randomBytes(12).toString("hex");
  const payload = `${agentId}:${ts}:${nonce}:${method}:${path}`;
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(payload), secretKey)).toString("base64");
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${sig}`;
}

async function seedAgent(opsURL: string, adminAuth: string, id: string, publicKey: string, displayName: string) {
  const res = await fetch(opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: adminAuth },
    body: JSON.stringify({
      operation: "insert",
      database: "flair",
      table: "Agent",
      records: [{
        id, name: displayName, displayName, role: "agent", publicKey,
        status: "active", kind: "agent", createdAt: new Date().toISOString(),
      }],
    }),
  });
  expect(res.status).toBe(200);
}

/** Set PRESENCE_PUBLIC_ROSTER for the NEXT Harper boot only; the child inherits it at spawn. */
async function bootWith(envValue: string | undefined): Promise<HarperInstance> {
  const prev = process.env.PRESENCE_PUBLIC_ROSTER;
  if (envValue === undefined) delete process.env.PRESENCE_PUBLIC_ROSTER;
  else process.env.PRESENCE_PUBLIC_ROSTER = envValue;
  try {
    return await startHarper();
  } finally {
    if (prev === undefined) delete process.env.PRESENCE_PUBLIC_ROSTER;
    else process.env.PRESENCE_PUBLIC_ROSTER = prev;
  }
}

const adminAuthOf = (h: HarperInstance) =>
  "Basic " + Buffer.from(`${h.admin.username}:${h.admin.password}`).toString("base64");

/** Seed an agent, then stamp a FRESH presence row via a real signed heartbeat. */
async function seedFreshHeartbeat(h: HarperInstance, agentId: string, kp: { publicKey: string; privateKey: Uint8Array }, task: string) {
  await seedAgent(h.opsURL, adminAuthOf(h), agentId, kp.publicKey, `${agentId} display`);
  const auth = buildAuthHeader(agentId, "POST", "/Presence", kp.privateKey);
  const res = await fetch(`${h.httpURL}/Presence`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ currentTask: task, activity: "coding" }),
  });
  expect(res.status).toBe(200);
}

// ─── (a)/(d)/(e): default (opt-in ABSENT) ────────────────────────────────────

describe("Presence read gate — default (PRESENCE_PUBLIC_ROSTER absent)", () => {
  let harper: HarperInstance;
  const agent = { id: "gate-default-agent", ...makeKeypair() };

  beforeAll(async () => {
    harper = await bootWith(undefined);
    await seedFreshHeartbeat(harper, agent.id, agent, "gate test: default verified reader");
  }, 120_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  // (a) anonymous GET, key absent → 401
  test("(a) anonymous GET /Presence → 401, no redacted roster", async () => {
    const res = await fetch(`${harper.httpURL}/Presence`);
    const text = await res.text();
    expect(res.status, `anon GET /Presence returned ${res.status}: ${text.slice(0, 200)}`).toBe(401);
    // Not a redacted roster: the body must not leak the roster shape at all.
    expect(text).not.toContain(agent.id);
    expect(text).not.toContain("displayName");
  });

  // (d) verified agent → full allowlisted row INCLUDING the gated fields
  test("(d) verified agent GET /Presence → full allowlisted row incl. gated fields", async () => {
    const auth = buildAuthHeader(agent.id, "GET", "/Presence", agent.privateKey);
    const res = await fetch(`${harper.httpURL}/Presence`, { headers: { Authorization: auth } });
    expect(res.status).toBe(200);
    const roster = await res.json();
    expect(Array.isArray(roster)).toBe(true);
    const row = roster.find((r: any) => r.id === agent.id);
    expect(row).toBeDefined();
    expect(row.displayName).toBe(`${agent.id} display`);
    expect(row.presenceStatus).toBe("active");
    expect(row.currentTask).toBe("gate test: default verified reader");
    expect(typeof row.flairVersion).toBe("string");   // stamped by the signed heartbeat
    expect(row.flairVersion.length).toBeGreaterThan(0);
    expect(row.harperVersion).not.toBeUndefined();
  });

  // (e) admin credential → row
  test("(e) admin credential GET /Presence → roster row", async () => {
    const res = await fetch(`${harper.httpURL}/Presence`, { headers: { Authorization: adminAuthOf(harper) } });
    expect(res.status).toBe(200);
    const roster = await res.json();
    expect(Array.isArray(roster)).toBe(true);
    const row = roster.find((r: any) => r.id === agent.id);
    expect(row).toBeDefined();
    expect(row.displayName).toBe(`${agent.id} display`);
  });

  // (f) flair#1880 F2 — an ordinary agent's SIGNED by-id read. GET /Presence/<id>
  // is NOT short-circuited by the middleware, which verifies the signature and
  // records the nonce, so the read gate must resolve THAT verdict rather than
  // re-verifying (which would read as a replay). Red on the PR head (401) and on
  // origin/main (200 with null gated fields).
  test("(f) ordinary agent GET /Presence/<id> → 200 with currentTask/flairVersion/harperVersion present", async () => {
    const path = `/Presence/${agent.id}`;
    const auth = buildAuthHeader(agent.id, "GET", path, agent.privateKey);
    const res = await fetch(`${harper.httpURL}${path}`, { headers: { Authorization: auth } });
    expect(res.status, `signed by-id GET returned ${res.status}`).toBe(200);
    const roster = await res.json();
    expect(Array.isArray(roster)).toBe(true);
    const row = roster.find((r: any) => r.id === agent.id);
    expect(row).toBeDefined();
    expect(row.currentTask).toBe("gate test: default verified reader");
    expect(typeof row.flairVersion).toBe("string");
    expect(row.flairVersion.length).toBeGreaterThan(0);
  });

  // (g) replay of the same signed header is still refused (the nonce store the
  // middleware consumes from is unchanged).
  test("(g) the same signed by-id header sent twice → the second is refused (nonce replay)", async () => {
    const path = `/Presence/${agent.id}`;
    const auth = buildAuthHeader(agent.id, "GET", path, agent.privateKey);
    const first = await fetch(`${harper.httpURL}${path}`, { headers: { Authorization: auth } });
    expect(first.status).toBe(200);
    const second = await fetch(`${harper.httpURL}${path}`, { headers: { Authorization: auth } });
    expect(second.status).toBe(401);
  });
});

// ─── (b): explicitly false ───────────────────────────────────────────────────

describe("Presence read gate — PRESENCE_PUBLIC_ROSTER=false", () => {
  let harper: HarperInstance;

  beforeAll(async () => { harper = await bootWith("false"); }, 120_000);
  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("(b) PRESENCE_PUBLIC_ROSTER=false → anonymous GET /Presence → 401", async () => {
    const res = await fetch(`${harper.httpURL}/Presence`);
    const text = await res.text();
    expect(res.status, `anon GET /Presence returned ${res.status}: ${text.slice(0, 200)}`).toBe(401);
  });
});

// ─── (c): opt-in true ────────────────────────────────────────────────────────

describe("Presence read gate — PRESENCE_PUBLIC_ROSTER=true (opt-in)", () => {
  let harper: HarperInstance;
  const agent = { id: "gate-public-agent", ...makeKeypair() };

  beforeAll(async () => {
    harper = await bootWith("true");
    await seedFreshHeartbeat(harper, agent.id, agent, "gate test: public opt-in");
  }, 120_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("(c) opt-in: anonymous GET /Presence → allowlisted roster, gated fields null", async () => {
    const res = await fetch(`${harper.httpURL}/Presence`);
    expect(res.status).toBe(200);
    const roster = await res.json();
    expect(Array.isArray(roster)).toBe(true);
    const row = roster.find((r: any) => r.id === agent.id);
    expect(row).toBeDefined();
    // allowlisted identity is present …
    expect(row.displayName).toBe(`${agent.id} display`);
    expect(typeof row.presenceStatus).toBe("string");
    // … but the three gated fields are null for an unverified reader.
    expect(row.currentTask).toBeNull();
    expect(row.flairVersion).toBeNull();
    expect(row.harperVersion).toBeNull();
    // Field allowlist still enforced (no leaked non-allowlisted fields).
    const ALLOWED = new Set(["id", "displayName", "role", "runtime", "activity", "lastActivity",
      "activityUpdatedAt", "activityAgeMs", "activityFresh", "presenceStatus", "currentTask",
      "lastHeartbeatAt", "flairVersion", "harperVersion"]);
    for (const key of Object.keys(row)) expect(ALLOWED.has(key)).toBe(true);
  });

  test("(c2) opt-in still serves a verified agent the gated fields", async () => {
    const auth = buildAuthHeader(agent.id, "GET", "/Presence", agent.privateKey);
    const res = await fetch(`${harper.httpURL}/Presence`, { headers: { Authorization: auth } });
    expect(res.status).toBe(200);
    const roster = await res.json();
    const row = roster.find((r: any) => r.id === agent.id);
    expect(row.currentTask).toBe("gate test: public opt-in");
    expect(typeof row.flairVersion).toBe("string");
  });
});
