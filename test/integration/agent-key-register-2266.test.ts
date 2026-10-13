// agent-key-register-2266.test.ts — flair#2266, against a REAL Harper.
//
// POST /AgentKeyRegister (resources/AgentKeyRegister.ts) registers a caller-held
// Ed25519 public key on an Agent row whose stored `publicKey` is exactly
// `pending`, admin only. Every case below drives this instance's own ephemeral
// Harper booted from the built component; the concurrency and rollback cases arm
// the operation's in-transaction pause point
// (resources/txn-pause-point.ts, enabled for THIS file's Harper by
// FLAIR_ENABLE_TEST_FAULT_INJECTION + FLAIR_TEST_PAUSE_DIR).
//
// Build prerequisite: dist/resources/*.js (`bun run build`).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { AGENT_KEY_REGISTER_PAUSE_POINT, keyFingerprint } from "../../src/lib/agent-key-register.js";

const sfx = Date.now().toString(36);
const LOCAL_ID = `inst-local-${sfx}`;
const FOREIGN_HOME = `peer-x-${sfx}`;
let harper: HarperInstance;
let pauseDir: string;

function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

const basic = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

interface AgentKey { pub: string; priv: Uint8Array; }
function mkKey(): AgentKey {
  const kp = nacl.sign.keyPair();
  return { pub: Buffer.from(kp.publicKey).toString("base64url"), priv: kp.secretKey };
}
function edHeader(agentId: string, key: Uint8Array, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${agentId}:${ts}:${nonce}:${method}:${path}`), key);
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function ops(op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify({ database: "flair", ...op }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  expect(res.status, `${op.operation} returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
  return text.length ? JSON.parse(text) : null;
}

async function rowIn(table: string, id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", table, ids: [id], get_attributes: ["*"] });
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function countRows(sql: string): Promise<number> {
  const rows = await ops({ operation: "sql", sql });
  return Array.isArray(rows) ? rows.length : 0;
}

/** POST /AgentKeyRegister as the admin operator (Basic). Returns status + body. */
async function registerAsAdmin(agentId: string, publicKey: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${harper.httpURL}/AgentKeyRegister`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify({ agentId, publicKey }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  return { status: res.status, body: text.length ? JSON.parse(text) : undefined };
}

async function seedAgent(rec: Record<string, unknown>): Promise<void> {
  await ops({ operation: "insert", table: "Agent", records: [{ name: rec.id, role: "agent", createdAt: new Date().toISOString(), ...rec }] });
}

// ── Pause-point helpers (resources/txn-pause-point.ts) ───────────────────────
function pausePoints(point: string) {
  return {
    arm: join(pauseDir, `arm.${point}`),
    paused: join(pauseDir, `paused.${point}`),
    released: join(pauseDir, `released.${point}`),
    go: join(pauseDir, `go.${point}`),
  };
}
async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
/** Arm `point`, start `work`, once paused run `compete`, then release. */
async function withPausedPoint<R>(point: string, work: () => Promise<R>, compete: () => Promise<void>): Promise<{ result: R; paused: boolean }> {
  const p = pausePoints(point);
  for (const marker of ["arm", "claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(p.arm, "");
  const pending = work();
  const paused = await waitForFile(p.paused, 20_000);
  try {
    if (paused) await compete();
  } finally {
    writeFileSync(p.go, "");
  }
  return { result: await pending, paused };
}

describe("flair#2266 — admin key registration on a pending Agent row", () => {
  const successId = `akr-ok-${sfx}`;
  const edAdminId = `akr-edadmin-${sfx}`;
  const edTargetId = `akr-edtarget-${sfx}`;
  const nonAdminId = `akr-nonadmin-${sfx}`;
  const repeatId = `akr-repeat-${sfx}`;
  const nonPendingId = `akr-nonpending-${sfx}`;
  const foreignId = `akr-foreign-${sfx}`;
  const inactiveId = `akr-inactive-${sfx}`;
  const missingId = `akr-missing-${sfx}`;
  const loopbackId = `akr-loopback-${sfx}`;
  const enrollId = `akr-enroll-${sfx}`;
  const concId = `akr-conc-${sfx}`;
  const rollbackId = `akr-rollback-${sfx}`;

  const edAdminKey = mkKey();
  const successKey = mkKey();
  const nonAdminKey = mkKey();

  beforeAll(async () => {
    pauseDir = mkdtempSync(join(tmpdir(), "flair-2266-pause-"));
    const savedFault = process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION;
    const savedPause = process.env.FLAIR_TEST_PAUSE_DIR;
    process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
    process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
    try {
      harper = await startHarper();
    } finally {
      if (savedFault === undefined) delete process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION; else process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = savedFault;
      if (savedPause === undefined) delete process.env.FLAIR_TEST_PAUSE_DIR; else process.env.FLAIR_TEST_PAUSE_DIR = savedPause;
    }
    assertOwnInstance(harper);

    // One Instance row, so this instance has a canonical identity.
    for (const r of (await ops({ operation: "sql", sql: "SELECT id FROM flair.Instance" })) ?? []) {
      if (r?.id) await ops({ operation: "delete", table: "Instance", ids: [r.id] });
    }
    await ops({ operation: "insert", table: "Instance", records: [{ id: LOCAL_ID, role: "hub", publicKey: "local-pub", createdAt: new Date().toISOString() }] });

    await seedAgent({ id: edAdminId, role: "admin", admin: true, status: "active", publicKey: edAdminKey.pub });
    await seedAgent({ id: nonAdminId, status: "active", publicKey: nonAdminKey.pub });
    await seedAgent({ id: successId, status: "active", publicKey: "pending" });
    await seedAgent({ id: edTargetId, status: "active", publicKey: "pending" });
    await seedAgent({ id: repeatId, status: "active", publicKey: "pending" });
    await seedAgent({ id: nonPendingId, status: "active", publicKey: mkKey().pub });
    await seedAgent({ id: foreignId, status: "active", publicKey: "pending", originatorInstanceId: FOREIGN_HOME });
    await seedAgent({ id: inactiveId, status: "deactivated", publicKey: "pending" });
    await seedAgent({ id: loopbackId, status: "active", publicKey: "pending" });
    await seedAgent({ id: enrollId, status: "active", publicKey: "pending" });
    await seedAgent({ id: concId, status: "active", publicKey: "pending" });
    await seedAgent({ id: rollbackId, status: "active", publicKey: "pending", updatedAt: "2026-01-01T00:00:00.000Z" });
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  }, 30_000);

  test("an admin registers a caller-held key on a legacy pending row; read-back equals; audit + OrgEvent carry the fingerprint only", async () => {
    const before = await rowIn("Agent", successId);
    expect(before?.publicKey).toBe("pending");

    const { status, body } = await registerAsAdmin(successId, successKey.pub);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.agentId).toBe(successId);
    expect(body.publicKey).toBe(successKey.pub);
    expect(typeof body.updatedAt).toBe("string");
    expect(typeof body.registrationId).toBe("string");

    // Read-back equals the response.
    const after = await rowIn("Agent", successId);
    expect(after?.publicKey).toBe(body.publicKey);
    expect(after?.updatedAt).toBe(body.updatedAt);

    // Audit row: fingerprint only, never the key.
    const audit = await rowIn("AgentKeyRegistration", body.registrationId);
    expect(audit).not.toBeNull();
    expect(audit.agentId).toBe(successId);
    expect(audit.actorId).toBe("admin");
    expect(audit.instanceId).toBe(LOCAL_ID);
    expect(audit.keyFingerprint).toBe(keyFingerprint(successKey.pub));
    expect(JSON.stringify(audit)).not.toContain(successKey.pub);

    // OrgEvent carries the fingerprint, never the key.
    const event = await rowIn("OrgEvent", `admin-${body.updatedAt}-${body.registrationId}`);
    expect(event).not.toBeNull();
    expect(event.kind).toBe("agent_key_registered");
    expect(event.refId).toBe(successId);
    expect(String(event.detail)).toContain(keyFingerprint(successKey.pub));
    expect(JSON.stringify(event)).not.toContain(successKey.pub);
  }, 30_000);

  test("the registered key now authenticates the agent against this Harper", async () => {
    const path = `/Agent/${successId}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "GET",
      headers: { Authorization: edHeader(successId, successKey.priv, "GET", path) },
      signal: AbortSignal.timeout(15_000),
    });
    expect(res.status, `the registered key did not authenticate: ${res.status} ${(await res.text()).slice(0, 200)}`).toBeLessThan(300);
  }, 30_000);

  test("a repeat call is refused agent_key_not_pending with no change (full-row snapshot)", async () => {
    const first = await registerAsAdmin(repeatId, mkKey().pub);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const before = await rowIn("Agent", repeatId);

    const again = await registerAsAdmin(repeatId, mkKey().pub);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error).toBe("agent_key_not_pending");

    expect(await rowIn("Agent", repeatId)).toEqual(before);
  }, 30_000);

  test("a non-pending row is refused agent_key_not_pending with no change", async () => {
    const before = await rowIn("Agent", nonPendingId);
    const { status, body } = await registerAsAdmin(nonPendingId, mkKey().pub);
    expect(status).toBe(409);
    expect(body.error).toBe("agent_key_not_pending");
    expect(await rowIn("Agent", nonPendingId)).toEqual(before);
  }, 30_000);

  test("a foreign-origin row is refused agent_not_local with no change", async () => {
    const before = await rowIn("Agent", foreignId);
    const { status, body } = await registerAsAdmin(foreignId, mkKey().pub);
    expect(status).toBe(403);
    expect(body.error).toBe("agent_not_local");
    expect(await rowIn("Agent", foreignId)).toEqual(before);
  }, 30_000);

  test("a deactivated row is refused agent_inactive with no change", async () => {
    const before = await rowIn("Agent", inactiveId);
    const { status, body } = await registerAsAdmin(inactiveId, mkKey().pub);
    expect(status).toBe(403);
    expect(body.error).toBe("agent_inactive");
    expect(await rowIn("Agent", inactiveId)).toEqual(before);
  }, 30_000);

  test("a missing row is refused agent_not_found", async () => {
    const { status, body } = await registerAsAdmin(missingId, mkKey().pub);
    expect(status).toBe(404);
    expect(body.error).toBe("agent_not_found");
  }, 30_000);

  test("a malformed body is refused registration_request_invalid", async () => {
    const bad = await registerAsAdmin(successId, "not-a-key");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("registration_request_invalid");
    const noId = await registerAsAdmin("", mkKey().pub);
    expect(noId.status).toBe(400);
    expect(noId.body.error).toBe("registration_request_invalid");
  }, 30_000);

  test("a non-admin agent-signed caller is refused 403 with no change", async () => {
    const before = await rowIn("Agent", nonAdminId);
    const path = "/AgentKeyRegister";
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: edHeader(nonAdminId, nonAdminKey.priv, "POST", path) },
      body: JSON.stringify({ agentId: nonAdminId, publicKey: mkKey().pub }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(res.status, (await res.text()).slice(0, 200)).toBe(403);
    expect(await rowIn("Agent", nonAdminId)).toEqual(before);
  }, 30_000);

  test("a credential-less loopback request is refused 401 (the authorizeLocal forgery case) with no change", async () => {
    const before = await rowIn("Agent", loopbackId);
    const res = await fetch(`${harper.httpURL}/AgentKeyRegister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: loopbackId, publicKey: mkKey().pub }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(res.status, (await res.text()).slice(0, 200)).toBe(401);
    expect(await rowIn("Agent", loopbackId)).toEqual(before);
  }, 30_000);

  test("a Flair-Enroll Authorization is refused outright with no change", async () => {
    const before = await rowIn("Agent", enrollId);
    const res = await fetch(`${harper.httpURL}/AgentKeyRegister`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Flair-Enroll abcdef" },
      body: JSON.stringify({ agentId: enrollId, publicKey: mkKey().pub }),
      signal: AbortSignal.timeout(15_000),
    });
    // Refused outright: the enrollment scheme is not an accepted credential, so
    // the request never registers anything. (Harper's own auth refuses the
    // unparseable Authorization header; the resource's own check is the
    // fail-closed backstop for any configuration that reaches it.)
    expect(res.status, (await res.text()).slice(0, 200)).toBe(401);
    expect(await rowIn("Agent", enrollId)).toEqual(before);
  }, 30_000);

  test("an Ed25519 admin (the isAdmin annotation) registers a key", async () => {
    const key = mkKey();
    const path = "/AgentKeyRegister";
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: edHeader(edAdminId, edAdminKey.priv, "POST", path) },
      body: JSON.stringify({ agentId: edTargetId, publicKey: key.pub }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    expect(res.status, text.slice(0, 200)).toBe(200);
    expect(JSON.parse(text).publicKey).toBe(key.pub);
    expect((await rowIn("Agent", edTargetId))?.publicKey).toBe(key.pub);
  }, 30_000);

  test("two concurrent admin registrations: exactly one wins, the other is refused, no partial state", async () => {
    const auditBefore = await countRows(`SELECT id FROM flair.AgentKeyRegistration WHERE agentId = '${concId}'`);
    const keyA = mkKey();
    const keyB = mkKey();
    let loser: { status: number; body: any } | undefined;
    const { result: winner, paused } = await withPausedPoint(
      AGENT_KEY_REGISTER_PAUSE_POINT,
      () => registerAsAdmin(concId, keyA.pub),
      async () => {
        loser = await registerAsAdmin(concId, keyB.pub);
      },
    );
    expect(paused, "the pause point did not fire").toBe(true);
    expect(winner.status, JSON.stringify(winner.body)).toBe(200);
    expect(loser?.status).toBe(409);
    expect(["agent_key_not_pending", "registration_conflict"]).toContain(String(loser?.body?.error));

    const row = await rowIn("Agent", concId);
    expect([keyA.pub, keyB.pub]).toContain(row.publicKey);
    expect(row.publicKey).toBe(winner.body.publicKey);
    // Exactly one audit row and one OrgEvent, from the single winner.
    const auditAfter = await countRows(`SELECT id FROM flair.AgentKeyRegistration WHERE agentId = '${concId}'`);
    expect(auditAfter - auditBefore).toBe(1);
    expect(await rowIn("AgentKeyRegistration", winner.body.registrationId)).not.toBeNull();
    const events = await countRows(`SELECT id FROM flair.OrgEvent WHERE refId = '${concId}' AND kind = 'agent_key_registered'`);
    expect(events).toBe(1);
  }, 60_000);

  test("a competing committed change before the commit aborts the whole registration: rollback, no audit, no OrgEvent", async () => {
    const keyA = mkKey();
    const before = await rowIn("Agent", rollbackId);
    const { result, paused } = await withPausedPoint(
      AGENT_KEY_REGISTER_PAUSE_POINT,
      () => registerAsAdmin(rollbackId, keyA.pub),
      async () => {
        // A competing writer commits an unrelated field change while the
        // registration is paused inside its transaction, after staging.
        await ops({ operation: "update", table: "Agent", records: [{ id: rollbackId, name: `${rollbackId}-renamed` }] });
      },
    );
    expect(paused, "the pause point did not fire").toBe(true);
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(result.body.error).toBe("registration_conflict");

    const after = await rowIn("Agent", rollbackId);
    expect(after.publicKey).toBe("pending");
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.name).toBe(`${rollbackId}-renamed`);
    expect(await countRows(`SELECT id FROM flair.AgentKeyRegistration WHERE agentId = '${rollbackId}'`)).toBe(0);
    expect(await countRows(`SELECT id FROM flair.OrgEvent WHERE refId = '${rollbackId}' AND kind = 'agent_key_registered'`)).toBe(0);
  }, 60_000);
});
