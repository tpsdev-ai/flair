/**
 * federation-presence-receive-2578.test.ts — flair#2578 slice 1, against a REAL
 * Harper with the receive flag ON.
 *
 * The receive path (synthetic signed frames from a paired spoke) covers the
 * home binding (P1), the Presence merge (P4), the receipt validation (P5) and
 * the receiver stamp (P3). The LOCAL writers (POST /Presence's direct table put,
 * the resource PUT and the resource PATCH) cover the home refusal (P2); the POST
 * heartbeat test also asserts the local author stamp (P3). The flag-OFF named
 * skip lives in federation-presence-receive-disabled-2578.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { SKIP_REASON_CLASS } from "../../resources/federation-classify.js";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

const LOCAL_INSTANCE = "flair_local_receiver";
const PEER = "fp-peer-spoke";
const HUB = "fp-peer-hub";
const peerKeys = nacl.sign.keyPair();
const hubKeys = nacl.sign.keyPair();

// Receive-path agents (no signature needed): one homed on the sender, one homed
// elsewhere, one with a null home, and one with no Agent row at all.
const AGENT_HERE = "fp-agent-here";
const AGENT_ELSEWHERE = "fp-agent-elsewhere";
const AGENT_NULLHOME = "fp-agent-nullhome";
const AGENT_ABSENT = "fp-agent-absent";
// Local-write agents (need a keypair for the Ed25519 heartbeat).
const LOCAL_NULL = mkAgent("fp-local-null");
const LOCAL_FOREIGN = mkAgent("fp-local-foreign");
const LOCAL_FRESH = mkAgent("fp-local-fresh");

let harper: HarperInstance;

const basicAuth = () => "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must avoid ports 9925/9926`).not.toContain(u.port);
  }
  expect(h.process?.pid).toBeGreaterThan(0);
}

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function insertRow(table: string, row: Record<string, unknown>): Promise<void> {
  await ops({ operation: "insert", database: "flair", table, records: [row] });
}

async function readRow(table: string, id: string): Promise<any> {
  const rows = await ops({ operation: "search_by_hash", database: "flair", table, hash_values: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

async function sendBatch(senderId: string, senderKeys: nacl.SignKeyPair, records: Record<string, unknown>[], originator = senderId): Promise<Response> {
  const body = signBodyFresh(
    { instanceId: senderId, records: records.map((r) => ({ originatorInstanceId: originator, ...r })), lamportClock: Date.now() },
    senderKeys.secretKey,
  );
  return fetch(`${harper.httpURL}/FederationSync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

/** A wire Presence record (this table keys on agentId; the shared batch-key
 *  check wants data.id === record.id). */
function presenceRecord(agentId: string, over: Record<string, unknown> = {}, updatedAt = new Date().toISOString()) {
  return {
    table: "Presence",
    id: agentId,
    updatedAt,
    data: {
      id: agentId,
      agentId,
      lastHeartbeatAt: Date.now(),
      activity: "coding",
      currentTask: "reviewing x",
      flairVersion: "0.61.0",
      harperVersion: "5.3.1",
      originatorInstanceId: PEER,
      ...over,
    },
  };
}

function ed25519Header(a: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomBytes(12).toString("hex");
  const payload = `${a.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = Buffer.from(nacl.sign.detached(Buffer.from(payload), a.secretKey)).toString("base64");
  return `TPS-Ed25519 ${a.id}:${ts}:${nonce}:${sig}`;
}

beforeAll(async () => {
  harper = await startHarper({ env: { FLAIR_FEDERATION_PRESENCE_RECEIVE: "1" } });
  assertOwnInstance(harper);
  const now = new Date().toISOString();
  // The receiver's own identity (so a local write stamps a real author id).
  await insertRow("Instance", { id: LOCAL_INSTANCE, publicKey: "test-instance-key", role: "spoke", createdAt: now });
  await insertRow("Peer", { id: PEER, publicKey: Buffer.from(peerKeys.publicKey).toString("base64url"), role: "spoke", status: "paired", createdAt: now });
  await insertRow("Peer", { id: HUB, publicKey: Buffer.from(hubKeys.publicKey).toString("base64url"), role: "hub", status: "paired", createdAt: now });
  // Receive-path Agent rows.
  await insertRow("Agent", { id: AGENT_HERE, name: AGENT_HERE, role: "agent", publicKey: "k-here", createdAt: now, originatorInstanceId: PEER });
  await insertRow("Agent", { id: AGENT_ELSEWHERE, name: AGENT_ELSEWHERE, role: "agent", publicKey: "k-else", createdAt: now, originatorInstanceId: "some-other-instance" });
  await insertRow("Agent", { id: AGENT_NULLHOME, name: AGENT_NULLHOME, role: "agent", publicKey: "k-null", createdAt: now });
  // Local-write Agent rows.
  await insertRow("Agent", { id: LOCAL_NULL.id, name: LOCAL_NULL.id, role: "agent", publicKey: LOCAL_NULL.publicKey, createdAt: now });
  await insertRow("Agent", { id: LOCAL_FOREIGN.id, name: LOCAL_FOREIGN.id, role: "agent", publicKey: LOCAL_FOREIGN.publicKey, createdAt: now, originatorInstanceId: "some-other-instance" });
  await insertRow("Agent", { id: LOCAL_FRESH.id, name: LOCAL_FRESH.id, role: "agent", publicKey: LOCAL_FRESH.publicKey, createdAt: now });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
}, HARPER_STOP_BUDGET_MS);

describe("flair#2578 slice 1 — Presence receipt (real Harper, receive flag ON)", () => {
  it("P1+P3: a Presence row for an Agent homed on the sender merges, stamped with receivedAt", async () => {
    const hb = Date.now() - 5_000;
    const res = await sendBatch(PEER, peerKeys, [presenceRecord(AGENT_HERE, { lastHeartbeatAt: hb })]);
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.refused, JSON.stringify(body)).toEqual([]);
    expect(body.merged).toBe(1);
    const row = await readRow("Presence", AGENT_HERE);
    expect(row).not.toBeNull();
    expect(row.agentId).toBe(AGENT_HERE);
    expect(row.lastHeartbeatAt).toBe(hb);
    expect(typeof row.receivedAt).toBe("number");
    expect(row.receivedAt).toBeGreaterThan(hb);
    // the originator's own signed stamp is preserved (not the receiver's).
    expect(row.originatorInstanceId).toBe(PEER);
  }, 60_000);

  it("P1: a row for an Agent homed ELSEWHERE is skipped, and nothing is stored", async () => {
    const res = await sendBatch(PEER, peerKeys, [presenceRecord(AGENT_ELSEWHERE)]);
    const body = await res.json() as any;
    expect(body.refused).toEqual([{ table: "Presence", id: AGENT_ELSEWHERE, reason: "presence_agent_homed_elsewhere" }]);
    expect(SKIP_REASON_CLASS.presence_agent_homed_elsewhere).toBe("non_retryable");
    expect(await readRow("Presence", AGENT_ELSEWHERE)).toBeNull();
  }, 60_000);

  it("P1: a row for an Agent with a NULL home is skipped (non-retryable)", async () => {
    const res = await sendBatch(PEER, peerKeys, [presenceRecord(AGENT_NULLHOME)]);
    const body = await res.json() as any;
    expect(body.refused).toEqual([{ table: "Presence", id: AGENT_NULLHOME, reason: "presence_agent_homed_elsewhere" }]);
    expect(await readRow("Presence", AGENT_NULLHOME)).toBeNull();
  }, 60_000);

  it("P1: a row whose Agent is not here yet gets the RETRYABLE skip", async () => {
    const res = await sendBatch(PEER, peerKeys, [presenceRecord(AGENT_ABSENT)]);
    const body = await res.json() as any;
    expect(body.refused).toEqual([{ table: "Presence", id: AGENT_ABSENT, reason: "presence_agent_not_replicated" }]);
    expect(SKIP_REASON_CLASS.presence_agent_not_replicated).toBe("retryable");
    expect(await readRow("Presence", AGENT_ABSENT)).toBeNull();
  }, 60_000);

  it("P1: the binding is the batch-verified SENDER, not the wire originatorInstanceId", async () => {
    // A hub sends the record; the wire originatorInstanceId names the spoke that
    // IS the Agent's home. Binding to the wire value would accept; binding to the
    // verified sender (the hub) refuses.
    const relayed = "fp-agent-hub-relayed";
    await insertRow("Agent", { id: relayed, name: relayed, role: "agent", publicKey: "k-relayed", createdAt: new Date().toISOString(), originatorInstanceId: PEER });
    const res = await sendBatch(HUB, hubKeys, [presenceRecord(relayed)], PEER);
    const body = await res.json() as any;
    expect(body.refused).toEqual([{ table: "Presence", id: relayed, reason: "presence_agent_homed_elsewhere" }]);
    expect(await readRow("Presence", relayed)).toBeNull();
  }, 60_000);

  it("P4: an OLDER heartbeat never replaces the stored row", async () => {
    const newer = Date.now() - 1_000;
    // Land a newer row first.
    await sendBatch(PEER, peerKeys, [presenceRecord(AGENT_HERE, { lastHeartbeatAt: newer, currentTask: "newer" })]);
    const before = await readRow("Presence", AGENT_HERE);
    expect(before.lastHeartbeatAt).toBe(newer);
    // Now an older one.
    const res = await sendBatch(PEER, peerKeys, [presenceRecord(AGENT_HERE, { lastHeartbeatAt: newer - 60_000, currentTask: "older" })]);
    const body = await res.json() as any;
    expect(body.refused).toEqual([{ table: "Presence", id: AGENT_HERE, reason: "presence_stale_heartbeat" }]);
    const after = await readRow("Presence", AGENT_HERE);
    expect(after.lastHeartbeatAt).toBe(newer);
    expect(after.currentTask).toBe("newer");
  }, 60_000);

  it("P5: an invalid-shape row is skipped and never stored", async () => {
    const bad = "fp-agent-badshape";
    await insertRow("Agent", { id: bad, name: bad, role: "agent", publicKey: "k-bad", createdAt: new Date().toISOString(), originatorInstanceId: PEER });
    const res = await sendBatch(PEER, peerKeys, [presenceRecord(bad, { activity: "hacking" })]);
    const body = await res.json() as any;
    expect(body.refused).toEqual([{ table: "Presence", id: bad, reason: "presence_invalid_shape" }]);
    expect(await readRow("Presence", bad)).toBeNull();
  }, 60_000);

  it("P5: a stamp beyond the future allowance is skipped by name", async () => {
    const fut = "fp-agent-future";
    await insertRow("Agent", { id: fut, name: fut, role: "agent", publicKey: "k-fut", createdAt: new Date().toISOString(), originatorInstanceId: PEER });
    const res = await sendBatch(PEER, peerKeys, [presenceRecord(fut, { lastHeartbeatAt: Date.now() + 60 * 60 * 1000 })]);
    const body = await res.json() as any;
    expect(body.refused).toEqual([{ table: "Presence", id: fut, reason: "presence_future_timestamp" }]);
    expect(SKIP_REASON_CLASS.presence_future_timestamp).toBe("non_retryable");
    expect(await readRow("Presence", fut)).toBeNull();
  }, 60_000);

  it("P5: an over-long version string is DROPPED from the stored row", async () => {
    const v = "fp-agent-version";
    await insertRow("Agent", { id: v, name: v, role: "agent", publicKey: "k-v", createdAt: new Date().toISOString(), originatorInstanceId: PEER });
    const res = await sendBatch(PEER, peerKeys, [presenceRecord(v, { flairVersion: "v".repeat(200), harperVersion: "5.3.1" })]);
    const body = await res.json() as any;
    expect(body.merged).toBe(1);
    const row = await readRow("Presence", v);
    expect(row.flairVersion ?? null).toBeNull();
    expect(row.harperVersion).toBe("5.3.1");
  }, 60_000);

  it("P4: a tied heartbeat with an absent incoming activity stamp keeps the stored activity/task", async () => {
    const tied = "fp-agent-tie";
    const hb = Date.now() - 2_000;
    await insertRow("Agent", { id: tied, name: tied, role: "agent", publicKey: "k-tie", createdAt: new Date().toISOString(), originatorInstanceId: PEER });
    // Land a row that asserts an activity and a task at the heartbeat time.
    const first = await sendBatch(PEER, peerKeys, [presenceRecord(tied, { lastHeartbeatAt: hb, activity: "coding", currentTask: "stored task", activityUpdatedAt: hb })]);
    expect((await first.json() as any).merged).toBe(1);
    // Now the SAME heartbeat with no activity and a null activity stamp: it must
    // not blank the stored activity/task.
    const res = await sendBatch(PEER, peerKeys, [presenceRecord(tied, { lastHeartbeatAt: hb, activity: null, currentTask: null, activityUpdatedAt: null })]);
    const body = await res.json() as any;
    expect(body.refused, JSON.stringify(body)).toEqual([]);
    expect(body.merged).toBe(1);
    const row = await readRow("Presence", tied);
    expect(row.currentTask).toBe("stored task");
    expect(row.activity).toBe("coding");
    expect(Number(row.activityUpdatedAt)).toBe(hb);
  }, 60_000);
});

describe("flair#2578 slice 1 — local-write home guard (P2) and author stamp (P3)", () => {
  it("P2: POST /Presence for a foreign-homed agent is refused by name, and nothing is written", async () => {
    const auth = ed25519Header(LOCAL_FOREIGN, "POST", "/Presence");
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ activity: "coding" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toBe("presence_agent_homed_elsewhere");
    expect(await readRow("Presence", LOCAL_FOREIGN.id)).toBeNull();
  }, 60_000);

  it("P2: the resource PUT for a foreign-homed agent is refused by name, and nothing is written", async () => {
    const path = `/Presence/${LOCAL_FOREIGN.id}`;
    const auth = ed25519Header(LOCAL_FOREIGN, "PUT", path);
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ agentId: LOCAL_FOREIGN.id, activity: "coding", lastHeartbeatAt: Date.now(), activityUpdatedAt: Date.now() }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toBe("presence_agent_homed_elsewhere");
    expect(await readRow("Presence", LOCAL_FOREIGN.id)).toBeNull();
  }, 60_000);

  it("P2: the resource PATCH for a foreign-homed agent is refused by name, and nothing is written", async () => {
    const path = `/Presence/${LOCAL_FOREIGN.id}`;
    const auth = ed25519Header(LOCAL_FOREIGN, "PATCH", path);
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ activity: "coding" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toBe("presence_agent_homed_elsewhere");
    expect(await readRow("Presence", LOCAL_FOREIGN.id)).toBeNull();
  }, 60_000);

  it("P2: a PUT with the body agentId OMITTED is decided on the URL target", async () => {
    // The URL names the foreign-homed agent; the body names no agent. A guard
    // reading the body agentId would let it through.
    const path = `/Presence/${LOCAL_FOREIGN.id}`;
    const auth = ed25519Header(LOCAL_FOREIGN, "PUT", path);
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ activity: "coding", lastHeartbeatAt: Date.now(), activityUpdatedAt: Date.now() }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toBe("presence_agent_homed_elsewhere");
    expect(await readRow("Presence", LOCAL_FOREIGN.id)).toBeNull();
  }, 60_000);

  it("P2: a PUT with a MISMATCHED body agentId is decided on the URL target", async () => {
    // The body claims a local agent, the URL names the foreign-homed one: the
    // write lands on the URL target, so the guard must refuse on it.
    const path = `/Presence/${LOCAL_FOREIGN.id}`;
    const auth = ed25519Header(LOCAL_FOREIGN, "PUT", path);
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ agentId: LOCAL_NULL.id, activity: "coding", lastHeartbeatAt: Date.now(), activityUpdatedAt: Date.now() }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toBe("presence_agent_homed_elsewhere");
    expect(await readRow("Presence", LOCAL_FOREIGN.id)).toBeNull();
    expect(await readRow("Presence", LOCAL_NULL.id)).toBeNull();
  }, 60_000);

  it("P3: a client PUT cannot set originatorInstanceId or receivedAt", async () => {
    const path = `/Presence/${LOCAL_FRESH.id}`;
    const auth = ed25519Header(LOCAL_FRESH, "PUT", path);
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        agentId: LOCAL_FRESH.id, activity: "coding", lastHeartbeatAt: Date.now(), activityUpdatedAt: Date.now(),
        originatorInstanceId: "forged-home", receivedAt: 9_999_999_999_999,
      }),
    });
    expect([200, 204]).toContain(res.status);
    const row = await readRow("Presence", LOCAL_FRESH.id);
    expect(row.originatorInstanceId).toBe(LOCAL_INSTANCE);
    expect(row.receivedAt ?? null).toBeNull();
  }, 60_000);

  it("P3: a client PATCH cannot set originatorInstanceId or receivedAt", async () => {
    const path = `/Presence/${LOCAL_FRESH.id}`;
    const auth = ed25519Header(LOCAL_FRESH, "PATCH", path);
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ originatorInstanceId: "forged-home", receivedAt: 9_999_999_999_999, activity: "idle" }),
    });
    expect([200, 204]).toContain(res.status);
    const row = await readRow("Presence", LOCAL_FRESH.id);
    expect(row.originatorInstanceId).toBe(LOCAL_INSTANCE);
    expect(row.receivedAt ?? null).toBeNull();
    expect(row.activity).toBe("idle");
  }, 60_000);

  it("P2+P3: a null-home agent's heartbeat is accepted and its Presence row is stamped with this instance's id", async () => {
    const auth = ed25519Header(LOCAL_NULL, "POST", "/Presence");
    const res = await fetch(`${harper.httpURL}/Presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({ activity: "coding", currentTask: "local beat" }),
    });
    expect(res.status).toBe(200);
    const row = await readRow("Presence", LOCAL_NULL.id);
    expect(row).not.toBeNull();
    // P3: the local write stamps the local instance id, and a local row carries
    // no receiver stamp.
    expect(row.originatorInstanceId).toBe(LOCAL_INSTANCE);
    expect(row.receivedAt ?? null).toBeNull();
  }, 60_000);
});
