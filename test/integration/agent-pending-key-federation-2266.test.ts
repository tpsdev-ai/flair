// agent-pending-key-federation-2266.test.ts — flair#2266, the federation half.
//
// A known hub with a pinned key pushes a signed batch to POST /FederationSync.
// A record reaching the merge plan with publicKey different from stored pending is
// skipped as `agent_pending_key_not_federated` unless the status guard refused
// it first. Earlier validation keeps its own reason.
//
// The last two cases are the peer non-convergence consequence and its remedy. A
// pending copy that arrived from another instance (A) carries A's
// `originatorInstanceId`, so this instance (B) refuses to register it
// (`agent_not_local`), and syncing A's registered-key row cannot complete B's
// pending key; that key needs direct action on B. B's administrator writes
// the key onto B's copy through B's operations API; the key then authenticates.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const sfx = Date.now().toString(36);
const HUB = `apk-hub-${sfx}`;
const PENDING = `apk-pending-${sfx}`;
const STATUS_TARGET = `apk-status-${sfx}`;
const MIXED = `apk-mixed-${sfx}`;
const CONTROL = `apk-control-${sfx}`;
const PEER_COPY = `apk-peercopy-${sfx}`;
const now = () => new Date().toISOString();

let harper: HarperInstance;

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
}

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify({ database: "flair", ...operation }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBeLessThan(300);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function rawAgent(id: string): Promise<any> {
  const rows = await ops({ operation: "search_by_id", table: "Agent", ids: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? rows[0] : null;
}

const hub = nacl.sign.keyPair();
const hubPublicKey = Buffer.from(hub.publicKey).toString("base64url");
const aPair = nacl.sign.keyPair();
const aKey = Buffer.from(aPair.publicKey).toString("base64url");

function edHeader(agentId: string, key: Uint8Array, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${agentId}:${ts}:${nonce}:${method}:${path}`), key);
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

/** A signed GET of the agent's own row with A's key. */
async function getOwnRowWithAKey(id: string): Promise<{ status: number; text: string }> {
  const path = `/Agent/${id}`;
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "GET",
    headers: { Authorization: edHeader(id, aPair.secretKey, "GET", path) },
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, text: await res.text() };
}

async function sync(id: string, data: Record<string, unknown>): Promise<any> {
  const body = signBodyFresh(
    { instanceId: HUB, records: [{ table: "Agent", id, updatedAt: now(), originatorInstanceId: HUB, ...data }], lamportClock: Date.now() },
    hub.secretKey,
  );
  const res = await fetch(`${harper.httpURL}/FederationSync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  expect(res.status, `FederationSync returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
  return JSON.parse(text);
}

describe("flair#2266 — an inbound federated Agent record cannot complete a pending row's key", () => {
  beforeAll(async () => {
    harper = await startHarper();
    assertOwnInstance(harper);
    const t = new Date(Date.now() - 60_000).toISOString();
    for (const id of [PENDING, STATUS_TARGET, CONTROL, MIXED]) {
      await ops({
        operation: "insert", table: "Agent",
        records: [{ id, name: id, role: "agent", admin: false, status: "active", runtime: "local", publicKey: "pending", createdAt: t, updatedAt: t }],
      });
    }
    // A pending copy that arrived from another instance: it carries that
    // instance's home.
    await ops({
      operation: "insert", table: "Agent",
      records: [{ id: PEER_COPY, name: PEER_COPY, role: "agent", admin: false, status: "active", runtime: "local", publicKey: "pending", originatorInstanceId: HUB, createdAt: t, updatedAt: t }],
    });
    await ops({
      operation: "insert", table: "Peer",
      records: [{ id: HUB, publicKey: hubPublicKey, role: "hub", status: "active", createdAt: now() }],
    });
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("merge-plan pending-key refusal", async () => {
    const out = await sync(PENDING, { data: { id: PENDING, publicKey: aKey, runtime: "remote" } });
    expect(out.skippedReasons?.agent_pending_key_not_federated, JSON.stringify(out)).toBe(1);
    const rec = await rawAgent(PENDING);
    expect(rec?.publicKey, "the peer completed a pending row's key").toBe("pending");
    expect(rec?.runtime, "a second field in the refused record landed (partial merge)").toBe("local");
  }, 30_000);

  test("merge-plan precedence for a mixed status-and-key record", async () => {
    const out = await sync(MIXED, { data: { id: MIXED, status: "deactivated", publicKey: aKey } });
    expect(out.skippedReasons?.agent_status_not_federated, JSON.stringify(out)).toBe(1);
    expect(out.skippedReasons?.agent_pending_key_not_federated, JSON.stringify(out)).toBeUndefined();
    const rec = await rawAgent(MIXED);
    expect(rec?.status).toBe("active");
    expect(rec?.publicKey).toBe("pending");
  }, 30_000);

  test("merge-plan status refusal", async () => {
    const out = await sync(STATUS_TARGET, { data: { id: STATUS_TARGET, status: "deactivated" } });
    expect(out.skippedReasons?.agent_status_not_federated, JSON.stringify(out)).toBe(1);
    expect(out.skippedReasons?.agent_pending_key_not_federated, JSON.stringify(out)).toBeUndefined();
    const rec = await rawAgent(STATUS_TARGET);
    expect(rec?.status).toBe("active");
  }, 30_000);

  test("merge-plan control without a key change", async () => {
    const out = await sync(CONTROL, { data: { id: CONTROL, runtime: "remote2" } });
    expect(out.merged, JSON.stringify(out)).toBe(1);
    const rec = await rawAgent(CONTROL);
    expect(rec?.runtime).toBe("remote2");
    expect(rec?.publicKey).toBe("pending");
  }, 30_000);

  test("peer non-convergence: the peer's key change is refused and this instance refuses to register the foreign copy", async () => {
    const out = await sync(PEER_COPY, { data: { id: PEER_COPY, publicKey: aKey } });
    expect(out.skippedReasons?.agent_pending_key_not_federated, JSON.stringify(out)).toBe(1);
    const rec = await rawAgent(PEER_COPY);
    expect(rec?.publicKey, "the peer's key landed on the pending copy").toBe("pending");
    expect(rec?.originatorInstanceId).toBe(HUB);

    // The local instance is not this row's authority, so it refuses to register
    // it; the remedy is the operations-API write in the next case.
    const res = await fetch(`${harper.httpURL}/AgentKeyRegister`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basicAuth() },
      body: JSON.stringify({ agentId: PEER_COPY, publicKey: aKey }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    expect(res.status, text.slice(0, 200)).toBe(403);
    expect(JSON.parse(text).error).toBe("agent_not_local");
    expect((await rawAgent(PEER_COPY))?.publicKey).toBe("pending");
  }, 30_000);
  test("peer remedy: B's administrator writes the key onto B's copy through the operations API; read-back equals; the key authenticates", async () => {
    // Before: B's copy is pending, so A's key does not authenticate here.
    expect((await rawAgent(PEER_COPY))?.publicKey).toBe("pending");
    const refused = await getOwnRowWithAKey(PEER_COPY);
    expect(refused.status, `A's key authenticated against a pending copy: ${refused.text.slice(0, 200)}`).toBeGreaterThanOrEqual(400);

    // The documented remedy: the same raw `update` `flair agent rotate-key`
    // sends, carrying the key A registered.
    await ops({ operation: "update", table: "Agent", records: [{ id: PEER_COPY, publicKey: aKey, updatedAt: now() }] });

    const rec = await rawAgent(PEER_COPY);
    expect(rec?.publicKey).toBe(aKey);
    expect(rec?.originatorInstanceId, "the remedy must not move the row's home").toBe(HUB);

    const ok = await getOwnRowWithAKey(PEER_COPY);
    expect(ok.status, `the written key did not authenticate: ${ok.text.slice(0, 200)}`).toBe(200);
    expect(JSON.parse(ok.text).id).toBe(PEER_COPY);
  }, 30_000);
});
