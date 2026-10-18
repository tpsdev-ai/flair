/**
 * federation-presence-reoffer-2666.test.ts — flair#2666, real Harper.
 *
 * A home Presence row the hub refused because its receive flag was off must be
 * offered again after the hub enables receipt, without a new heartbeat.
 *
 * Boots TWO real, ephemeral Harpers: the SENDER (spoke), with a home agent and
 * its Presence row, and the RECEIVER (hub), first WITHOUT
 * FLAIR_FEDERATION_PRESENCE_RECEIVE. After the first sync refuses both home
 * rows, the hub is stopped (its data directory kept) and booted again with the
 * flag on; the sender is pointed at the new endpoint and syncs again. No
 * heartbeat is written between the syncs.
 *
 * Fixtures are neutral (agent-, host- names) and both Harpers are loopback,
 * ephemeral, HOME-isolated.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import nacl from "tweetnacl";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { keystore } from "../../src/keystore";
import { PRESENCE_SEND_FLAG_ENV } from "../../src/federation/presence-send";

const SENDER_ID = "flair_spoke_a";
const HUB_ID = "flair_hub_a";
const AGENT_HOME_A = "agent-home-a";
const AGENT_HOME_B = "agent-home-b";

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

async function sync(): Promise<{ pushed: number; skipped: number; error?: Error }> {
  const { runFederationSyncOnce } = await import("../../src/cli");
  return runFederationSyncOnce({
    target: sender.httpURL,
    opsTarget: sender.opsURL,
    adminUser: sender.admin.username,
    adminPass: sender.admin.password,
  });
}

const heartbeats = { [AGENT_HOME_A]: 0, [AGENT_HOME_B]: 0 };

beforeAll(async () => {
  process.env[PRESENCE_SEND_FLAG_ENV] = "1";
  // HOME is sandboxed for the test process (bunfig preload), so this seed lands
  // in an ephemeral store, never the developer's ~/.flair.
  keystore.setPrivateKeySeed(SENDER_ID, senderSeed);

  // The hub starts with Presence receipt OFF (the default).
  receiver = await startHarper();
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

  // Two home agents, each with a Presence row. Their heartbeats are written
  // once here and never again. The older row sits more than the 30 s re-scan
  // overlap behind the newer one, so an advanced watermark that is not capped
  // at the refusal leaves the older row out of the next scan.
  const base = Date.now() - 120_000;
  heartbeats[AGENT_HOME_A] = base;
  heartbeats[AGENT_HOME_B] = base + 60_000;
  await insertRow(sender, "Agent", { id: AGENT_HOME_A, name: AGENT_HOME_A, role: "agent", publicKey: "k-home-a", originatorInstanceId: SENDER_ID, createdAt: now, updatedAt: now });
  await insertRow(sender, "Agent", { id: AGENT_HOME_B, name: AGENT_HOME_B, role: "agent", publicKey: "k-home-b", originatorInstanceId: SENDER_ID, createdAt: now, updatedAt: now });
  await insertRow(sender, "Presence", { agentId: AGENT_HOME_A, lastHeartbeatAt: heartbeats[AGENT_HOME_A], activity: "coding", originatorInstanceId: SENDER_ID });
  await insertRow(sender, "Presence", { agentId: AGENT_HOME_B, lastHeartbeatAt: heartbeats[AGENT_HOME_B], activity: "idle", originatorInstanceId: SENDER_ID });
}, 480_000);

afterAll(async () => {
  delete process.env[PRESENCE_SEND_FLAG_ENV];
  if (sender) await stopHarper(sender);
  if (receiver) {
    const dir = receiver.installDir;
    await stopHarper(receiver, { keepInstallDir: true });
    // The restarted hub is caller-owned (installDir was passed in), so the
    // caller removes that exact directory.
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 4 });
  }
}, HARPER_STOP_BUDGET_MS * 2 + 60_000);

describe("flair#2666 — a receive-disabled refusal does not pass the Presence watermark", () => {
  it("re-offers a row refused with receipt off once the hub enables receipt, without a new heartbeat", async () => {
    const first = await sync();
    expect(first.error).toBeUndefined();
    // Both home Presence rows were offered and refused by the receive-disabled
    // hub; the Agents themselves merged in the same run.
    expect(first.skipped).toBe(2);
    expect(await readRow(receiver, "Presence", AGENT_HOME_A)).toBeNull();
    expect(await readRow(receiver, "Presence", AGENT_HOME_B)).toBeNull();
    expect(await readRow(receiver, "Agent", AGENT_HOME_A)).not.toBeNull();
    expect(await readRow(receiver, "Agent", AGENT_HOME_B)).not.toBeNull();

    // Restart the hub against the same data directory, this time with receipt on.
    const dir = receiver.installDir;
    await stopHarper(receiver, { keepInstallDir: true });
    receiver = await startHarper({
      installDir: dir,
      env: { FLAIR_FEDERATION_PRESENCE_RECEIVE: "1" },
    });
    assertOwnInstance(receiver, "restarted receiver");
    // Point the sender's Peer endpoint at the restarted hub's URL (the port may
    // or may not be reused across the restart).
    await ops(sender, { operation: "update", table: "Peer", records: [{ id: HUB_ID, endpoint: receiver.httpURL }] });

    // No heartbeat is written between the syncs: only the sender's watermark
    // carries the re-offer.
    const second = await sync();
    expect(second.error).toBeUndefined();

    const a = await readRow(receiver, "Presence", AGENT_HOME_A);
    expect(a, "the older home row is re-offered after receipt is enabled").not.toBeNull();
    expect(a.originatorInstanceId).toBe(SENDER_ID);
    expect(Number(a.lastHeartbeatAt)).toBe(heartbeats[AGENT_HOME_A]);
    const b = await readRow(receiver, "Presence", AGENT_HOME_B);
    expect(b).not.toBeNull();
    expect(Number(b.lastHeartbeatAt)).toBe(heartbeats[AGENT_HOME_B]);

    // The sender's watermark advanced on the confirmed batch.
    const hubPeer = await readRow(sender, "Peer", HUB_ID);
    expect(Date.parse(hubPeer.presenceLastSyncAt)).toBeGreaterThanOrEqual(heartbeats[AGENT_HOME_B]);
  }, 420_000);
});
