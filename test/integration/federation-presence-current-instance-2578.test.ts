/**
 * federation-presence-current-instance-2578.test.ts — flair#2578 slice 1.
 *
 * The Presence local-write home guard (P2) and the create-time author stamp (P3)
 * must use THIS instance's id read FRESH from the `Instance` table at write
 * time, not the process-cached `localInstanceId()` (which keeps its first
 * successful answer for the process lifetime). The Agent resource's guarded home
 * stamp uses the same fresh read (`currentInstanceId`, flair#2472).
 *
 * Against a REAL Harper, with ONE worker (harper-lifecycle's default, so the
 * warmed cache is the one the next request meets): warm the cache with a
 * resource create (an admin `POST /Agent/` stamps through `localInstanceId()`),
 * then change — and separately remove — the `Instance` row WITHOUT restarting
 * Harper, and check the POST, PUT and PATCH home decisions and a create's stamp
 * against the CURRENT id. The flag-on receive path lives in
 * federation-presence-receive-2578.test.ts; flag-off coverage lives in
 * federation-presence-receive-disabled-2578.test.ts; the pure rules in
 * test/unit/presence-federation-2578.test.ts.
 *
 * Build prerequisite: dist/resources/*.js (`bun run build`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { startHarper, stopHarper, HARPER_STOP_BUDGET_MS, type HarperInstance } from "../helpers/harper-lifecycle";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

const sfx = Date.now().toString(36);
const LOCAL_A = `fp-current-a-${sfx}`;
const LOCAL_B = `fp-current-b-${sfx}`;

// POST/PUT create assertions check the new stamp; the seeded PATCH update checks preservation.
const HOMED_A_POST = mkAgent(`fp-current-homed-a-post-${sfx}`);
const HOMED_B_POST = mkAgent(`fp-current-homed-b-post-${sfx}`);
const HOMED_A_PUT = mkAgent(`fp-current-homed-a-put-${sfx}`);
const HOMED_B_PUT = mkAgent(`fp-current-homed-b-put-${sfx}`);
const HOMED_A_PATCH = mkAgent(`fp-current-homed-a-patch-${sfx}`);
const HOMED_B_PATCH = mkAgent(`fp-current-homed-b-patch-${sfx}`);
// Null-home agents: a local write is allowed and the create stamps the current id.
const NULL_HOME_CHANGED = mkAgent(`fp-current-null-changed-${sfx}`);
const NULL_HOME_REMOVED = mkAgent(`fp-current-null-removed-${sfx}`);

let harper: HarperInstance;
let warmCounter = 0;

/** Refuse to talk to anything but this test's own ephemeral instance. */
function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must avoid ports 9925/9926`).not.toContain(u.port);
  }
  expect(h.process?.pid).toBeGreaterThan(0);
}

const basic = () => "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify({ database: "flair", ...operation }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBeLessThan(300);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function insertRow(table: string, row: Record<string, unknown>): Promise<void> {
  await ops({ operation: "insert", table, records: [row] });
}

async function readRow(table: string, id: string): Promise<any> {
  const rows = await ops({ operation: "search_by_id", table, ids: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

/** Make the `Instance` table hold exactly `ids` (one row each). */
async function setInstanceRows(ids: string[]): Promise<void> {
  const existing = await ops({ operation: "sql", sql: "SELECT id FROM flair.Instance" });
  for (const r of Array.isArray(existing) ? existing : []) {
    if (r?.id) await ops({ operation: "delete", table: "Instance", ids: [r.id] });
  }
  if (ids.length === 0) return;
  await ops({ operation: "insert", table: "Instance", records: ids.map((id) => ({ id, role: "hub", publicKey: `pub-${id}`, createdAt: new Date().toISOString() })) });
}

/** `Authorization: TPS-Ed25519 <id>:<ts>:<nonce>:<sig>` over `<id>:<ts>:<nonce>:<METHOD>:<path>`. */
function ed25519Header(a: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${a.id}:${ts}:${nonce}:${method}:${path}`), a.secretKey);
  return `TPS-Ed25519 ${a.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

/** POST /Presence (the heartbeat local writer). */
function heartbeat(a: TestAgent): Promise<Response> {
  return fetch(`${harper.httpURL}/Presence`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(a, "POST", "/Presence") },
    body: JSON.stringify({ activity: "coding" }),
    signal: AbortSignal.timeout(30_000),
  });
}

/** PUT /Presence/:id (the resource local writer). */
function putPresence(a: TestAgent): Promise<Response> {
  const path = `/Presence/${a.id}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(a, "PUT", path) },
    body: JSON.stringify({ agentId: a.id, activity: "coding", lastHeartbeatAt: Date.now(), activityUpdatedAt: Date.now() }),
    signal: AbortSignal.timeout(30_000),
  });
}

/** PATCH /Presence/:id (the third local writer). */
function patchPresence(a: TestAgent): Promise<Response> {
  const path = `/Presence/${a.id}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(a, "PATCH", path) },
    body: JSON.stringify({ agentId: a.id, activity: "idle" }),
    signal: AbortSignal.timeout(30_000),
  });
}

/**
 * Warm the resource's process-cached instance id (an admin `POST /Agent/` create
 * stamps through `localInstanceId`), then set the `Instance` table to `ids` and
 * run `body`. The table is restored to exactly the `LOCAL_A` row afterwards.
 */
async function warmedThenInstances(ids: string[], body: () => Promise<void>): Promise<void> {
  const warmId = `fp-current-warm-${sfx}-${warmCounter++}`;
  const res = await fetch(`${harper.httpURL}/Agent/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify({ id: warmId, name: warmId, role: "agent", status: "active", publicKey: "pk-warm", createdAt: new Date().toISOString() }),
    signal: AbortSignal.timeout(30_000),
  });
  expect(res.status, `warm create ${res.status}`).toBeLessThan(300);
  expect((await readRow("Agent", warmId)).originatorInstanceId, "the warm create did not cache this instance's id").toBe(LOCAL_A);
  try {
    await setInstanceRows(ids);
    await body();
  } finally {
    await setInstanceRows([LOCAL_A]);
  }
}

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
  const now = new Date().toISOString();
  await setInstanceRows([LOCAL_A]);
  // Home-A agents (the OLD cached id), home-B agents (the CURRENT id after the
  // change), and null-home agents (local on any instance).
  const rows: Array<[TestAgent, string | null]> = [
    [HOMED_A_POST, LOCAL_A], [HOMED_A_PUT, LOCAL_A], [HOMED_A_PATCH, LOCAL_A],
    [HOMED_B_POST, LOCAL_B], [HOMED_B_PUT, LOCAL_B], [HOMED_B_PATCH, LOCAL_B],
    [NULL_HOME_CHANGED, null], [NULL_HOME_REMOVED, null],
  ];
  for (const [a, home] of rows) {
    await insertRow("Agent", {
      id: a.id, name: a.id, role: "agent", status: "active", publicKey: a.publicKey, createdAt: now,
      ...(home !== null ? { originatorInstanceId: home } : {}),
    });
  }
  // A stored Presence row for the B-homed PATCH agent, so PATCH (update-only)
  // has a row to merge into.
  await insertRow("Presence", { agentId: HOMED_B_PATCH.id, lastHeartbeatAt: Date.now(), activity: "idle", originatorInstanceId: LOCAL_B });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
}, HARPER_STOP_BUDGET_MS);

describe("flair#2578 — the Presence home guard and create stamp follow the CURRENT instance id", () => {
  test("a CHANGED Instance row: POST, PUT and PATCH home decisions and the create stamp follow the new id", async () => {
    await warmedThenInstances([LOCAL_B], async () => {
      // POST: an agent homed on the OLD (cached) id is now foreign — refused.
      const postA = await heartbeat(HOMED_A_POST);
      expect(postA.status, await postA.text()).toBe(403);
      expect(await readRow("Presence", HOMED_A_POST.id), "a foreign-homed POST wrote a row").toBeNull();

      // POST: an agent homed on the CURRENT id is local — accepted, stamped B.
      const postB = await heartbeat(HOMED_B_POST);
      expect(postB.status, await postB.text()).toBe(200);
      expect((await readRow("Presence", HOMED_B_POST.id)).originatorInstanceId).toBe(LOCAL_B);

      // PUT: same decisions, decided on the URL-bound target.
      const putA = await putPresence(HOMED_A_PUT);
      expect(putA.status, await putA.text()).toBe(403);
      expect(await readRow("Presence", HOMED_A_PUT.id), "a foreign-homed PUT wrote a row").toBeNull();
      const putB = await putPresence(HOMED_B_PUT);
      expect(putB.status, await putB.text()).toBeLessThan(300);
      expect((await readRow("Presence", HOMED_B_PUT.id)).originatorInstanceId, "the PUT create stamp did not follow the current id").toBe(LOCAL_B);

      // PATCH: same decisions. The B-homed agent's row already exists (seeded),
      // so PATCH must be allowed and keep its stored stamp; the A-homed one has
      // no row and is refused by the home guard before Harper's not-found).
      const patchA = await patchPresence(HOMED_A_PATCH);
      expect(patchA.status, await patchA.text()).toBe(403);
      expect(await readRow("Presence", HOMED_A_PATCH.id), "a foreign-homed PATCH wrote a row").toBeNull();
      const patchB = await patchPresence(HOMED_B_PATCH);
      expect(patchB.status, await patchB.text()).toBeLessThan(300);
      expect((await readRow("Presence", HOMED_B_PATCH.id)).originatorInstanceId, "PATCH changed the stored author stamp").toBe(LOCAL_B);

      // A null-home agent is local: accepted, and its create stamps the CURRENT id.
      const nullRes = await heartbeat(NULL_HOME_CHANGED);
      expect(nullRes.status, await nullRes.text()).toBe(200);
      expect((await readRow("Presence", NULL_HOME_CHANGED.id)).originatorInstanceId, "the null-home create stamp did not follow the current id").toBe(LOCAL_B);
    });
  }, 60_000);

  test("a REMOVED Instance row: a non-null home is refused and a create stamps nothing (no current identity)", async () => {
    await warmedThenInstances([], async () => {
      // No current identity: an agent with a non-null home is the home of no
      // instance here, so every local writer refuses it.
      const postA = await heartbeat(HOMED_A_POST);
      expect(postA.status, await postA.text()).toBe(403);
      expect(await readRow("Presence", HOMED_A_POST.id), "a non-null-homed POST wrote a row with no Instance row").toBeNull();
      const putA = await putPresence(HOMED_A_PUT);
      expect(putA.status, await putA.text()).toBe(403);
      const patchA = await patchPresence(HOMED_A_PATCH);
      expect(patchA.status, await patchA.text()).toBe(403);
      const patchB = await patchPresence(HOMED_B_PATCH);
      expect(patchB.status, await patchB.text()).toBe(403);
      expect((await readRow("Presence", HOMED_B_PATCH.id)).originatorInstanceId, "a non-null-homed PATCH changed the row with no Instance row").toBe(LOCAL_B);

      // A null-home agent is still local: accepted, and a create stamps no id.
      const nullRes = await heartbeat(NULL_HOME_REMOVED);
      expect(nullRes.status, await nullRes.text()).toBe(200);
      const row = await readRow("Presence", NULL_HOME_REMOVED.id);
      expect(row, "the null-home POST wrote no row").not.toBeNull();
      expect(row.originatorInstanceId ?? null, "a create stamped an id with no canonical Instance row").toBeNull();
    });
  }, 60_000);
});
