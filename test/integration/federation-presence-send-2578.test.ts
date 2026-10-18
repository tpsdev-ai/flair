/**
 * federation-presence-send-2578.test.ts — flair#2578 slice 2, real Harper,
 * sender → receiver end to end, BOTH flags on.
 *
 * Boots TWO real, ephemeral Harpers (test/helpers/harper-lifecycle):
 *   - the RECEIVER (hub), with FLAIR_FEDERATION_PRESENCE_RECEIVE on;
 *   - the SENDER (spoke), holding a home agent and its Presence row.
 * The sender is the real push path (runFederationSyncOnce), driven in-process
 * with the send flag on, pointed at the sender's own instance for reads and at
 * the receiver for the sync. This is the seam under test: the real sender's
 * scan/sign/batch against the real receiver's verify/bind/merge.
 *
 * Fixtures are neutral (agent-, host- names) and both Harpers are loopback,
 * ephemeral, HOME-isolated.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { startHarper, stopHarper, HARPER_STOP_BUDGET_MS, type HarperInstance } from "../helpers/harper-lifecycle";
import { keystore } from "../../src/keystore";
import { PRESENCE_SEND_FLAG_ENV, presenceWireRecord } from "../../src/federation/presence-send";
import { signBody, signBodyFresh } from "../../resources/federation-crypto";

const SENDER_ID = "flair_spoke_a";
const HUB_ID = "flair_hub_a";
const AGENT_HOME = "agent-home-a";
const AGENT_ELSEWHERE = "agent-elsewhere-a";

const senderSeed = new Uint8Array(randomBytes(32));
const senderKp = nacl.sign.keyPair.fromSeed(senderSeed);
const hubKp = nacl.sign.keyPair();
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

let sender: HarperInstance;
let receiver: HarperInstance;

function assertOwnInstance(h: HarperInstance, what: string): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], `${what} ${url} must be loopback`).toContain(u.hostname);
    expect(["9925", "9926"], `${what} ${url} must avoid ports 9925/9926`).not.toContain(u.port);
  }
  expect(h.process?.pid).toBeGreaterThan(0);
}

const basic = (h: HarperInstance) => "Basic " + Buffer.from(`${h.admin.username}:${h.admin.password}`).toString("base64");

async function ops(h: HarperInstance, operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic(h) },
    body: JSON.stringify({ database: "flair", ...operation }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation} on ${h.httpURL}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

const insertRow = (h: HarperInstance, table: string, row: Record<string, unknown>) =>
  ops(h, { operation: "insert", table, records: [row] });

async function readRow(h: HarperInstance, table: string, id: string): Promise<any> {
  const rows = await ops(h, { operation: "search_by_hash", table, hash_values: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

/** The admin GET /FederationPeers response, i.e. what the sender's push path
 *  reads its presenceLastSyncAt from (not the raw Peer row). */
async function getPeers(h: HarperInstance): Promise<any> {
  const res = await fetch(`${h.httpURL}/FederationPeers`, {
    headers: { Authorization: basic(h) },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  expect(res.status, `GET /FederationPeers on ${h.httpURL}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

async function sync(): Promise<{ pushed: number; skipped: number; error?: Error }> {
  const { runFederationSyncOnce } = await import("../../src/cli");
  return runFederationSyncOnce({
    target: sender.httpURL,
    opsTarget: sender.opsURL,
    adminUser: sender.admin.username,
    adminPass: sender.admin.password,
  });
}

beforeAll(async () => {
  process.env[PRESENCE_SEND_FLAG_ENV] = "1";
  // HOME is sandboxed for the test process (bunfig preload), so this seed lands
  // in an ephemeral store, never the developer's ~/.flair.
  keystore.setPrivateKeySeed(SENDER_ID, senderSeed);

  receiver = await startHarper({ env: { FLAIR_FEDERATION_PRESENCE_RECEIVE: "1" } });
  sender = await startHarper({ env: { FLAIR_FEDERATION_PRESENCE_SEND: "1" } });
  assertOwnInstance(receiver, "receiver");
  assertOwnInstance(sender, "sender");

  const now = new Date().toISOString();
  // Receiver identity + the sender pinned as its spoke.
  await insertRow(receiver, "Instance", { id: HUB_ID, publicKey: b64url(hubKp.publicKey), role: "hub", createdAt: now });
  await insertRow(receiver, "Peer", { id: SENDER_ID, publicKey: b64url(senderKp.publicKey), role: "spoke", status: "paired", createdAt: now });

  // Sender identity + the hub pinned as its hub.
  await insertRow(sender, "Instance", { id: SENDER_ID, publicKey: b64url(senderKp.publicKey), role: "spoke", createdAt: now });
  await insertRow(sender, "Peer", { id: HUB_ID, publicKey: b64url(hubKp.publicKey), role: "hub", status: "paired", endpoint: receiver.httpURL, createdAt: now });

  // A home agent (this instance) and an agent homed elsewhere, each with a row.
  await insertRow(sender, "Agent", { id: AGENT_HOME, name: AGENT_HOME, role: "agent", publicKey: "k-home", originatorInstanceId: SENDER_ID, createdAt: now, updatedAt: now });
  await insertRow(sender, "Agent", { id: AGENT_ELSEWHERE, name: AGENT_ELSEWHERE, role: "agent", publicKey: "k-else", originatorInstanceId: "flair_other", createdAt: now, updatedAt: now });

  const heartbeat = Date.now();
  await insertRow(sender, "Presence", { agentId: AGENT_HOME, lastHeartbeatAt: heartbeat, activity: "coding", currentTask: "slice 2", flairVersion: "0.61.0", harperVersion: "5.3.1", originatorInstanceId: SENDER_ID });
  await insertRow(sender, "Presence", { agentId: AGENT_ELSEWHERE, lastHeartbeatAt: heartbeat, activity: "idle", originatorInstanceId: "flair_other" });
}, 480_000);

afterAll(async () => {
  delete process.env[PRESENCE_SEND_FLAG_ENV];
  if (sender) await stopHarper(sender);
  if (receiver) await stopHarper(receiver);
}, HARPER_STOP_BUDGET_MS * 2 + 30_000);

describe("flair#2578 slice 2 — Presence sender end to end (real Harper, both flags on)", () => {
  it("a home agent's Presence and its Agent land on the hub; a non-home row does not", async () => {
    const result = await sync();
    expect(result.error).toBeUndefined();

    // The Agent arrived (ordering) so the receiver's home binding can succeed.
    const agent = await readRow(receiver, "Agent", AGENT_HOME);
    expect(agent).not.toBeNull();
    expect(agent.originatorInstanceId).toBe(SENDER_ID);

    // The Presence row landed, stamped with the batch-verified sender.
    const presence = await readRow(receiver, "Presence", AGENT_HOME);
    expect(presence).not.toBeNull();
    expect(presence.originatorInstanceId).toBe(SENDER_ID);
    expect(presence.activity).toBe("coding");
    expect(Number(presence.receivedAt)).toBeGreaterThan(0);

    expect(await readRow(receiver, "Presence", AGENT_ELSEWHERE)).toBeNull();

    // The sender advanced its per-table watermark on the confirmed batch.
    const hubPeer = await readRow(sender, "Peer", HUB_ID);
    expect(typeof hubPeer.presenceLastSyncAt).toBe("string");
    expect(Number.isFinite(Date.parse(hubPeer.presenceLastSyncAt))).toBe(true);

    // The push path reads that value through GET /FederationPeers, so the
    // response itself must carry it.
    const listed = (await getPeers(sender)).peers.find((p: any) => p.id === HUB_ID);
    expect(listed).toBeDefined();
    expect(listed.presenceLastSyncAt).toBe(hubPeer.presenceLastSyncAt);
  });

  it("an unchanged overlap resend preserves the heartbeat and activity", async () => {
    const before = await readRow(receiver, "Presence", AGENT_HOME);
    const result = await sync();
    expect(result.error).toBeUndefined();
    const after = await readRow(receiver, "Presence", AGENT_HOME);
    expect(after.lastHeartbeatAt).toBe(before.lastHeartbeatAt);
    expect(after.activity).toBe(before.activity);
    expect(Number(after.receivedAt)).toBeGreaterThanOrEqual(Number(before.receivedAt));
    expect(result.pushed).toBeGreaterThanOrEqual(1);
  });

  for (const representation of ["string", "bigint"]) {
    it(`the hub accepts sender-normalized ${representation} timestamps`, async () => {
      const heartbeat = Date.now();
      const stamp = representation === "string" ? String(heartbeat) : BigInt(heartbeat);
      const payload = presenceWireRecord({
        agentId: AGENT_HOME, lastHeartbeatAt: stamp, activityUpdatedAt: stamp, receivedAt: stamp,
      }, SENDER_ID)!;
      expect(payload.data.lastHeartbeatAt).toBe(heartbeat);
      expect(payload.data.activityUpdatedAt).toBe(heartbeat);
      expect(payload.data.receivedAt).toBe(heartbeat);
      const record = { ...payload, signature: signBody(payload, senderKp.secretKey) };
      const response = await fetch(`${receiver.httpURL}/FederationSync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signBodyFresh({ instanceId: SENDER_ID, records: [record], lamportClock: heartbeat }, senderKp.secretKey)),
        signal: AbortSignal.timeout(20_000),
      });
      expect(response.status).toBe(200);
      const result = await response.json() as { merged: number; skipped: number };
      expect(result.merged).toBe(1);
      expect(result.skipped).toBe(0);
      const stored = await readRow(receiver, "Presence", AGENT_HOME);
      expect(Number(stored.lastHeartbeatAt)).toBe(heartbeat);
      expect(Number(stored.activityUpdatedAt)).toBe(heartbeat);
    });
  }
});
