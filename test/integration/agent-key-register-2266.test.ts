// agent-key-register-2266.test.ts — flair#2266, against a REAL Harper.
//
// POST /AgentKeyRegister (resources/AgentKeyRegister.ts) registers an agent key,
// admin only. The route checks a fresh row is `pending` and
// confirms it before commit. Every case below drives this instance's own ephemeral
// Harper booted from the built component. The concurrency and rollback cases arm
// the operation's in-transaction pause point; the read-back case arms the one
// between the commit and the read-back (resources/txn-pause-point.ts, enabled
// for THIS file's Harper by FLAIR_ENABLE_TEST_FAULT_INJECTION +
// FLAIR_TEST_PAUSE_DIR). The audit cases drive the AgentKeyRegistration REST
// route itself. The last block boots a second Harper with
// AUTHENTICATION_AUTHORIZELOCAL=true, proves that mode is in effect, and sends a
// credential-less POST.
//
// Build prerequisite: dist/resources/*.js (`bun run build`).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { AGENT_KEY_REGISTER_PAUSE_POINT, AGENT_KEY_REGISTER_READ_BACK_PAUSE_POINT, keyFingerprint } from "../../src/lib/agent-key-register.js";

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

/** A Harper operation that takes no `database` (add_role, add_user, tokens). */
async function harperOp(op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify(op),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  expect(res.status, `${op.operation} returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
  return text.length ? JSON.parse(text) : null;
}

/** POST /AgentKeyRegister with `Authorization: Bearer <token>`. */
async function registerWithBearer(token: string, agentId: string, publicKey: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${harper.httpURL}/AgentKeyRegister`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ agentId, publicKey }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, text: await res.text() };
}

async function rowIn(table: string, id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", table, ids: [id], get_attributes: ["*"] });
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function countRows(sql: string): Promise<number> {
  const rows = await ops({ operation: "sql", sql });
  return Array.isArray(rows) ? rows.length : 0;
}

async function registrationEventCount(agentId: string): Promise<number> {
  return countRows(`SELECT id FROM flair.OrgEvent WHERE kind = 'agent_key_registered' AND refId = '${agentId}'`);
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
  const bearerTargetId = `akr-bearer-${sfx}`;
  const badBearerId = `akr-badbearer-${sfx}`;
  const refreshBearerId = `akr-refreshbearer-${sfx}`;
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
  const readBackId = `akr-readback-${sfx}`;
  const syncedFromId = `akr-syncedfrom-${sfx}`;
  const syncedOriginId = `akr-syncedorigin-${sfx}`;
  const auditTargetId = `akr-audit-${sfx}`;
  // An agent id is any string matching the agent-id rule, so a canonical key
  // can also be an agent's id.
  const keyAsIdKey = mkKey();
  const keyAsId = keyAsIdKey.pub;

  const edAdminKey = mkKey();
  const successKey = mkKey();
  const nonAdminKey = mkKey();

  beforeAll(async () => {
    pauseDir = mkdtempSync(join(tmpdir(), "flair-2266-pause-"));
    harper = await startHarper({ serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir } });
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
    await seedAgent({ id: bearerTargetId, status: "active", publicKey: "pending" });
    await seedAgent({ id: badBearerId, status: "active", publicKey: "pending" });
    await seedAgent({ id: refreshBearerId, status: "active", publicKey: "pending" });
    await seedAgent({ id: repeatId, status: "active", publicKey: "pending" });
    await seedAgent({ id: nonPendingId, status: "active", publicKey: mkKey().pub });
    await seedAgent({ id: foreignId, status: "active", publicKey: "pending", originatorInstanceId: FOREIGN_HOME });
    await seedAgent({ id: inactiveId, status: "deactivated", publicKey: "pending" });
    await seedAgent({ id: loopbackId, status: "active", publicKey: "pending" });
    await seedAgent({ id: enrollId, status: "active", publicKey: "pending" });
    await seedAgent({ id: concId, status: "active", publicKey: "pending" });
    await seedAgent({ id: rollbackId, status: "active", publicKey: "pending", updatedAt: "2026-01-01T00:00:00.000Z" });
    await seedAgent({ id: readBackId, status: "active", publicKey: "pending" });
    // Receiver-side sync provenance with NO foreign home: an absent home, and the
    // local home. Only the sync-provenance check can refuse these.
    await seedAgent({ id: syncedFromId, status: "active", publicKey: "pending", _syncedFrom: FOREIGN_HOME });
    await seedAgent({ id: syncedOriginId, status: "active", publicKey: "pending", originatorInstanceId: LOCAL_ID, _originatorInstanceId: FOREIGN_HOME });
    await seedAgent({ id: auditTargetId, status: "active", publicKey: "pending" });
    await seedAgent({ id: keyAsId, status: "active", publicKey: "pending" });
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  }, 30_000);

  test("an admin registers a caller-held key on a legacy pending row; read-back equals; the audit keyFingerprint and event detail carry the fingerprint, the audit agentId and event refId the target id", async () => {
    const before = await rowIn("Agent", successId);
    expect(before?.publicKey).toBe("pending");

    const { status, body } = await registerAsAdmin(successId, successKey.pub);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.agentId).toBe(successId);
    expect(body.publicKey).toBe(successKey.pub);
    expect(typeof body.updatedAt).toBe("string");
    expect(typeof body.registrationId).toBe("string");

    expect(await registrationEventCount(successId)).toBe(1);

    // Read-back equals the response.
    const after = await rowIn("Agent", successId);
    expect(after?.publicKey).toBe(body.publicKey);
    expect(after?.updatedAt).toBe(body.updatedAt);

    // Audit row: keyFingerprint is the fingerprint; agentId is the target id.
    // This agent's id is not the key, so no field holds the key string.
    const audit = await rowIn("AgentKeyRegistration", body.registrationId);
    expect(audit).not.toBeNull();
    expect(audit.agentId).toBe(successId);
    expect(audit.actorId).toBe("admin");
    expect(audit.instanceId).toBe(LOCAL_ID);
    expect(audit.keyFingerprint).toBe(await keyFingerprint(successKey.pub));
    expect(JSON.stringify(audit)).not.toContain(successKey.pub);

    // OrgEvent: the detail carries the fingerprint; refId is the agent id.
    const event = await rowIn("OrgEvent", `admin-${body.updatedAt}-${body.registrationId}`);
    expect(event).not.toBeNull();
    expect(event.kind).toBe("agent_key_registered");
    expect(event.refId).toBe(successId);
    expect(String(event.detail)).toContain(await keyFingerprint(successKey.pub));
    expect(JSON.stringify(event)).not.toContain(successKey.pub);
  }, 30_000);

  test("an agent whose id equals its key: keyFingerprint and detail carry the fingerprint; agentId, refId and the summary text carry the id (the key string)", async () => {
    const { status, body } = await registerAsAdmin(keyAsId, keyAsIdKey.pub);
    expect(status, JSON.stringify(body)).toBe(200);
    const fp = await keyFingerprint(keyAsIdKey.pub);

    const audit = await rowIn("AgentKeyRegistration", body.registrationId);
    expect(audit.keyFingerprint).toBe(fp);
    expect(audit.agentId).toBe(keyAsId);

    const event = await rowIn("OrgEvent", `admin-${body.updatedAt}-${body.registrationId}`);
    expect(event.detail).toBe(`key fingerprint ${fp}`);
    expect(event.refId).toBe(keyAsId);
    expect(event.summary).toBe(`registered a public key for ${keyAsId}`);
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

  test("a credential-less loopback request on the harness's default Harper config is refused 401 with no change", async () => {
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
    // Harper defers the unknown scheme; Flair's middleware passes the header on.
    // This path exercises the route's own scheme check, which returns 401.
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

  test("a Harper-issued Bearer operation token, even the admin user's, is refused 401 and changes nothing", async () => {
    const tokens = await harperOp({ operation: "create_authentication_tokens", username: harper.admin.username, password: harper.admin.password });
    expect(typeof tokens?.operation_token, JSON.stringify(tokens).slice(0, 200)).toBe("string");
    const before = await rowIn("Agent", bearerTargetId);
    const auditsBefore = await ops({ operation: "sql", sql: "SELECT * FROM flair.AgentKeyRegistration ORDER BY id" });
    const eventsBefore = await registrationEventCount(bearerTargetId);
    const { status, text } = await registerWithBearer(tokens.operation_token, bearerTargetId, mkKey().pub);
    expect(status, text.slice(0, 200)).toBe(401);
    expect(JSON.parse(text).error).toBe("authentication required");
    expect(await rowIn("Agent", bearerTargetId)).toEqual(before);
    expect(await ops({ operation: "sql", sql: "SELECT * FROM flair.AgentKeyRegistration ORDER BY id" })).toEqual(auditsBefore);
    expect(await registrationEventCount(bearerTargetId)).toBe(eventsBefore);
  }, 30_000);

  test("an unverifiable Bearer token is refused 401; the Agent row is unchanged", async () => {
    const before = await rowIn("Agent", badBearerId);
    const res = await fetch(`${harper.httpURL}/AgentKeyRegister`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-harper-token" },
      body: JSON.stringify({ agentId: badBearerId, publicKey: mkKey().pub }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(res.status, (await res.text()).slice(0, 200)).toBe(401);
    expect(await rowIn("Agent", badBearerId)).toEqual(before);
  }, 30_000);

  test("a refresh token Harper issued to the admin user, presented as Bearer, registers nothing; the Agent row is unchanged", async () => {
    const tokens = await harperOp({ operation: "create_authentication_tokens", username: harper.admin.username, password: harper.admin.password });
    expect(typeof tokens?.refresh_token, JSON.stringify(tokens).slice(0, 200)).toBe("string");
    const before = await rowIn("Agent", refreshBearerId);
    const { status, text } = await registerWithBearer(tokens.refresh_token, refreshBearerId, mkKey().pub);
    expect(status, text.slice(0, 200)).toBe(404);
    expect(await rowIn("Agent", refreshBearerId)).toEqual(before);
    expect(await countRows(`SELECT id FROM flair.AgentKeyRegistration WHERE agentId = '${refreshBearerId}'`)).toBe(0);
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

  test("a row difference visible at confirmation aborts registration: no audit or OrgEvent", async () => {
    const keyA = mkKey();
    const before = await rowIn("Agent", rollbackId);
    const { result, paused } = await withPausedPoint(
      AGENT_KEY_REGISTER_PAUSE_POINT,
      () => registerAsAdmin(rollbackId, keyA.pub),
      async () => {
        // A competing writer commits an unrelated field change while the
        // registration is paused inside its transaction, after the fresh read
        // and before the staging.
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
  test("a key change committed between the commit and the read-back is refused 503 registration_unavailable, never a success", async () => {
    const keyA = mkKey();
    const keyB = mkKey();
    const { result, paused } = await withPausedPoint(
      AGENT_KEY_REGISTER_READ_BACK_PAUSE_POINT,
      () => registerAsAdmin(readBackId, keyA.pub),
      async () => {
        // The registration has committed keyA. A competing raw write changes
        // ONLY the key (updatedAt stays the registration's), so the key clause
        // of the read-back check is the one that must refuse.
        const committed = await rowIn("Agent", readBackId);
        expect(committed?.publicKey, "the registration had not committed at the pause").toBe(keyA.pub);
        await ops({ operation: "update", table: "Agent", records: [{ id: readBackId, publicKey: keyB.pub }] });
      },
    );
    expect(paused, "the read-back pause point did not fire").toBe(true);
    expect(result.status, JSON.stringify(result.body)).toBe(503);
    expect(result.body.error).toBe("registration_unavailable");
    expect(result.body.publicKey, "a refused read-back must not report a key").toBeUndefined();
    expect(result.body.registrationId, "a refused read-back must not report a registration").toBeUndefined();
    expect((await rowIn("Agent", readBackId))?.publicKey).toBe(keyB.pub);
  }, 60_000);

  test("a newer key write committed in the confirmation-to-commit gap refuses registration 503, never a success", async () => {
    const id = `akr-commitgap-${sfx}`;
    const keyA = mkKey();
    const keyB = mkKey();
    await seedAgent({ id, status: "active", publicKey: "pending" });
    const { result, paused } = await withPausedPoint(
      "agent-key-register-commit",
      () => registerAsAdmin(id, keyA.pub),
      async () => {
        // The registration has staged its key but not committed. A newer full
        // write of the same row commits in the gap and can discard the staged
        // registration's effect.
        const committed = await rowIn("Agent", id);
        expect(committed?.publicKey, "the registration had already committed at the gap").toBe("pending");
        await ops({ operation: "put", table: "Agent", records: [{ ...committed, publicKey: keyB.pub }] });
      },
    );
    expect(paused, "the commit-gap pause point did not fire").toBe(true);
    expect(result.status, JSON.stringify(result.body)).toBe(503);
    expect(result.body.error).toBe("registration_unavailable");
    expect(result.body.publicKey, "a refused read-back must not report a key").toBeUndefined();
    expect(result.body.registrationId, "a refused read-back must not report a registration").toBeUndefined();
    expect((await rowIn("Agent", id))?.publicKey, "the newer key write is the committed one").toBe(keyB.pub);
  }, 60_000);

  for (const [label, id] of [["_syncedFrom with no home", () => syncedFromId], ["_originatorInstanceId with the local home", () => syncedOriginId]] as const) {
    test(`a sync-provenance row (${label}) is refused agent_not_local with no Agent, audit or OrgEvent change`, async () => {
      const agentId = id();
      const before = await rowIn("Agent", agentId);
      expect(before?.publicKey).toBe("pending");
      const { status, body } = await registerAsAdmin(agentId, mkKey().pub);
      expect(status, JSON.stringify(body)).toBe(403);
      expect(body.error).toBe("agent_not_local");
      expect(await rowIn("Agent", agentId)).toEqual(before);
      expect(await countRows(`SELECT id FROM flair.AgentKeyRegistration WHERE agentId = '${agentId}'`)).toBe(0);
      expect(await countRows(`SELECT id FROM flair.OrgEvent WHERE refId = '${agentId}'`)).toBe(0);
    }, 30_000);
  }

  describe("the AgentKeyRegistration REST route: admin read, every write refused", () => {
    let auditId = "";
    let auditRow: any = null;

    /** A request to the audit route as `who`: an admin agent, a non-admin agent, or the Basic admin. */
    async function asCaller(who: "edAdmin" | "nonAdmin" | "basicAdmin", method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
      const authorization = who === "basicAdmin"
        ? basic()
        : who === "edAdmin"
          ? edHeader(edAdminId, edAdminKey.priv, method, path)
          : edHeader(nonAdminId, nonAdminKey.priv, method, path);
      const res = await fetch(`${harper.httpURL}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: authorization },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      return { status: res.status, text: await res.text() };
    }

    beforeAll(async () => {
      const reg = await registerAsAdmin(auditTargetId, mkKey().pub);
      expect(reg.status, JSON.stringify(reg.body)).toBe(200);
      auditId = reg.body.registrationId;
      auditRow = await rowIn("AgentKeyRegistration", auditId);
      expect(auditRow).not.toBeNull();
    }, 30_000);

    test("an admin agent reads the row; a non-admin agent is refused 403", async () => {
      const path = `/AgentKeyRegistration/${auditId}`;
      const admin = await asCaller("edAdmin", "GET", path);
      expect(admin.status, admin.text.slice(0, 200)).toBe(200);
      const got = JSON.parse(admin.text);
      expect(got.id).toBe(auditId);
      expect(got.keyFingerprint).toBe(auditRow.keyFingerprint);
      const nonAdmin = await asCaller("nonAdmin", "GET", path);
      expect(nonAdmin.status, nonAdmin.text.slice(0, 200)).toBe(403);
    }, 30_000);

    for (const who of ["nonAdmin", "edAdmin", "basicAdmin"] as const) {
      test(`${who}: POST, PUT, PATCH and DELETE are refused 403 and the audit table is unchanged`, async () => {
        const forgedId = `akr-forged-${who}-${sfx}`;
        const forged = { id: forgedId, actorId: who, agentId: auditTargetId, keyFingerprint: "0".repeat(64), createdAt: new Date().toISOString() };

        const post = await asCaller(who, "POST", "/AgentKeyRegistration/", forged);
        expect(post.status, `POST: ${post.text.slice(0, 200)}`).toBe(403);
        const put = await asCaller(who, "PUT", `/AgentKeyRegistration/${auditId}`, { ...auditRow, keyFingerprint: "f".repeat(64) });
        expect(put.status, `PUT: ${put.text.slice(0, 200)}`).toBe(403);
        const patch = await asCaller(who, "PATCH", `/AgentKeyRegistration/${auditId}`, { keyFingerprint: "e".repeat(64) });
        expect(patch.status, `PATCH: ${patch.text.slice(0, 200)}`).toBe(403);
        const del = await asCaller(who, "DELETE", `/AgentKeyRegistration/${auditId}`);
        expect(del.status, `DELETE: ${del.text.slice(0, 200)}`).toBe(403);

        expect(await rowIn("AgentKeyRegistration", auditId), "the audit row changed").toEqual(auditRow);
        expect(await rowIn("AgentKeyRegistration", forgedId), "a forged audit row landed").toBeNull();
        expect(await countRows(`SELECT id FROM flair.AgentKeyRegistration WHERE agentId = '${auditTargetId}'`)).toBe(1);
      }, 30_000);
    }
  });
});

describe("flair#2266 — a credential-less POST with Harper's authorizeLocal explicitly on", () => {
  let lh: HarperInstance;
  const targetId = `akr-authlocal-${sfx}`;
  const lbasic = () => "Basic " + btoa(`${lh.admin.username}:${lh.admin.password}`);

  async function lops(op: Record<string, unknown>): Promise<any> {
    const res = await fetch(lh.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: lbasic() },
      body: JSON.stringify({ database: "flair", ...op }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    expect(res.status, `${op.operation} returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
    return text.length ? JSON.parse(text) : null;
  }
  const lcount = async (sql: string): Promise<number> => {
    const rows = await lops({ operation: "sql", sql });
    return Array.isArray(rows) ? rows.length : 0;
  };

  beforeAll(async () => {
    lh = await startHarper({ env: { AUTHENTICATION_AUTHORIZELOCAL: "true" } });
    assertOwnInstance(lh);
    await lops({ operation: "insert", table: "Agent", records: [{ id: targetId, name: targetId, role: "agent", status: "active", publicKey: "pending", createdAt: new Date().toISOString() }] });
  }, 240_000);

  afterAll(async () => {
    if (lh) await stopHarper(lh);
  }, 30_000);

  test("the mode is in effect, and a credential-less loopback POST /AgentKeyRegister is still refused 401 with no Agent, audit or OrgEvent change", async () => {
    // Proof the mode is in effect: a credential-less loopback operations-API
    // `user_info` is answered as a super_user.
    const probe = await fetch(lh.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "user_info" }),
      signal: AbortSignal.timeout(15_000),
    });
    const probeText = await probe.text();
    expect(probe.status, `authorizeLocal is not in effect: ${probeText.slice(0, 200)}`).toBe(200);
    expect(JSON.parse(probeText)?.role?.permission?.super_user, "the loopback request was not authorized as super_user").toBe(true);

    const before = await lops({ operation: "search_by_id", table: "Agent", ids: [targetId], get_attributes: ["*"] });
    const res = await fetch(`${lh.httpURL}/AgentKeyRegister`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: targetId, publicKey: mkKey().pub }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    expect(res.status, text.slice(0, 200)).toBe(401);
    expect(await lops({ operation: "search_by_id", table: "Agent", ids: [targetId], get_attributes: ["*"] })).toEqual(before);
    expect(before?.[0]?.publicKey).toBe("pending");
    expect(await lcount(`SELECT id FROM flair.AgentKeyRegistration WHERE agentId = '${targetId}'`)).toBe(0);
    expect(await lcount(`SELECT id FROM flair.OrgEvent WHERE refId = '${targetId}'`)).toBe(0);
  }, 30_000);
});
