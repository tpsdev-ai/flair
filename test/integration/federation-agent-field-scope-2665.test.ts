/**
 * federation-agent-field-scope-2665.test.ts — flair#2665, real Harper.
 *
 * Boots TWO ephemeral Harpers (test/helpers/harper-lifecycle):
 *   - the RECEIVER, which holds local agents, pins three peers and names two
 *     agent ids in FLAIR_ADMIN_AGENTS (one with a local row, one without);
 *   - the SENDER, a paired spoke whose agents are homed on it. Its pushes go
 *     through the real push path (runFederationSyncOnce).
 * Two more pinned peers, a spoke and a hub, sign their batches in-process;
 * neither is the home of the existing rows they send.
 *
 * Checks, against the stored rows and the receiver's real Ed25519 and admin
 * gates:
 *   - the home's push creates its agents, and a key rotation on the home reaches
 *     the receiver;
 *   - a record from a peer that is not the row's home is refused as
 *     agent_identity_not_from_home and leaves the key, home and admin state as
 *     stored;
 *   - a record whose verified sender is not the row's home is refused even when
 *     its originatorInstanceId field names that home;
 *   - a federation merge stores a new Agent row without `role: "admin"` or
 *     `admin: true` and keeps an existing row's stored admin state;
 *   - a new row whose id the receiver's FLAIR_ADMIN_AGENTS names is refused as
 *     agent_admin_id_not_federated, and that configuration's existing local row
 *     keeps its owner's key.
 *
 * Fixtures are neutral; both Harpers are loopback, ephemeral and HOME-isolated.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { keystore } from "../../src/keystore";
import { signBodyFresh } from "../../resources/federation-crypto";

const sfx = Date.now().toString(36);
const RECEIVER_ID = `flair_hub_a_${sfx}`;
const SENDER_ID = `flair_spoke_a_${sfx}`;
const OTHER_SPOKE_ID = `flair_spoke_b_${sfx}`;
const OTHER_HUB_ID = `flair_hub_b_${sfx}`;

const LOCAL_AGENT = `agent-local-${sfx}`;
const LOCAL_ADMIN = `agent-local-admin-${sfx}`;
const HOMED_AGENT = `agent-homed-${sfx}`;
const SPOKE_ADMIN = `agent-spoke-admin-${sfx}`;
const PEER_NEW = `agent-peer-new-${sfx}`;
const CONFIGURED_ABSENT = `agent-configured-absent-${sfx}`; // in FLAIR_ADMIN_AGENTS, no local row
const CONFIGURED_LOCAL = `agent-configured-local-${sfx}`; // in FLAIR_ADMIN_AGENTS, local row
const CONTROL_NEW = `agent-control-new-${sfx}`; // not in FLAIR_ADMIN_AGENTS

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

const senderSeed = new Uint8Array(randomBytes(32));
const senderKp = nacl.sign.keyPair.fromSeed(senderSeed);
const receiverKp = nacl.sign.keyPair();
const otherSpokeKp = nacl.sign.keyPair();
const otherHubKp = nacl.sign.keyPair();

const ownerKp = nacl.sign.keyPair(); // LOCAL_AGENT's key on the receiver
const localAdminKp = nacl.sign.keyPair();
const homedKp1 = nacl.sign.keyPair(); // HOMED_AGENT before rotation
const homedKp2 = nacl.sign.keyPair(); // HOMED_AGENT after rotation
const spokeAdminKp = nacl.sign.keyPair();
const peerNewKp = nacl.sign.keyPair();
const foreignKp = nacl.sign.keyPair(); // the key the non-home peers push
const configuredOwnerKp = nacl.sign.keyPair(); // CONFIGURED_LOCAL's key on the receiver
const controlKp = nacl.sign.keyPair();

let receiver: HarperInstance;
let sender: HarperInstance;

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

async function readAgent(h: HarperInstance, id: string): Promise<any> {
  const rows = await ops(h, { operation: "search_by_hash", table: "Agent", hash_values: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

/** HTTP status of a TPS-Ed25519 signed GET on the receiver. */
async function signedGet(agentId: string, secretKey: Uint8Array, path: string): Promise<number> {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${agentId}:${ts}:${nonce}:GET:${path}`), secretKey);
  const res = await fetch(`${receiver.httpURL}${path}`, {
    headers: { Authorization: `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}` },
    signal: AbortSignal.timeout(20_000),
  });
  await res.text();
  return res.status;
}

const authAs = (agentId: string, secretKey: Uint8Array) => signedGet(agentId, secretKey, `/Agent/${agentId}`);
// AgentKeyRegistration's allowRead is allowAdmin: a 200 here is the admin gate.
const adminReadAs = (agentId: string, secretKey: Uint8Array) => signedGet(agentId, secretKey, "/AgentKeyRegistration/");

/** The real push path: the sender's stored rows, signed by the sender, to the receiver. */
async function pushFromSender(): Promise<{ pushed: number; skipped: number; error?: Error }> {
  const { runFederationSyncOnce } = await import("../../src/cli");
  return runFederationSyncOnce({
    target: sender.httpURL,
    opsTarget: sender.opsURL,
    adminUser: sender.admin.username,
    adminPass: sender.admin.password,
  });
}

/** A signed FederationSync batch of Agent records from a pinned peer. */
async function peerBatch(
  peerId: string,
  secretKey: Uint8Array,
  records: Array<{ id: string; data: Record<string, unknown>; originator?: string }>,
): Promise<any> {
  const body = signBodyFresh(
    {
      instanceId: peerId,
      records: records.map((r) => ({
        table: "Agent",
        id: r.id,
        updatedAt: iso(),
        originatorInstanceId: r.originator ?? peerId,
        data: { id: r.id, ...r.data },
      })),
      lamportClock: Date.now(),
    },
    secretKey,
  );
  const res = await fetch(`${receiver.httpURL}/FederationSync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  expect(res.status, `FederationSync from ${peerId}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

beforeAll(async () => {
  // HOME is sandboxed for the test process (bunfig preload), so this seed lands
  // in an ephemeral store.
  keystore.setPrivateKeySeed(SENDER_ID, senderSeed);

  receiver = await startHarper({ serverEnv: { FLAIR_ADMIN_AGENTS: `${CONFIGURED_ABSENT},${CONFIGURED_LOCAL}` } });
  sender = await startHarper();
  assertOwnInstance(receiver, "receiver");
  assertOwnInstance(sender, "sender");

  const now = iso();
  const earlier = iso(-60_000);

  await insertRow(receiver, "Instance", { id: RECEIVER_ID, publicKey: b64url(receiverKp.publicKey), role: "hub", createdAt: now });
  await ops(receiver, {
    operation: "insert", table: "Peer",
    records: [
      { id: SENDER_ID, publicKey: b64url(senderKp.publicKey), role: "spoke", status: "paired", createdAt: now },
      { id: OTHER_SPOKE_ID, publicKey: b64url(otherSpokeKp.publicKey), role: "spoke", status: "paired", createdAt: now },
      { id: OTHER_HUB_ID, publicKey: b64url(otherHubKp.publicKey), role: "hub", status: "active", createdAt: now },
    ],
  });
  await ops(receiver, {
    operation: "insert", table: "Agent",
    records: [
      { id: LOCAL_AGENT, name: LOCAL_AGENT, role: "agent", admin: false, status: "active", publicKey: b64url(ownerKp.publicKey), originatorInstanceId: RECEIVER_ID, createdAt: earlier, updatedAt: earlier },
      { id: LOCAL_ADMIN, name: LOCAL_ADMIN, role: "admin", admin: true, status: "active", publicKey: b64url(localAdminKp.publicKey), originatorInstanceId: RECEIVER_ID, createdAt: earlier, updatedAt: earlier },
      { id: CONFIGURED_LOCAL, name: CONFIGURED_LOCAL, role: "agent", admin: false, status: "active", publicKey: b64url(configuredOwnerKp.publicKey), originatorInstanceId: RECEIVER_ID, createdAt: earlier, updatedAt: earlier },
    ],
  });

  await insertRow(sender, "Instance", { id: SENDER_ID, publicKey: b64url(senderKp.publicKey), role: "spoke", createdAt: now });
  await insertRow(sender, "Peer", { id: RECEIVER_ID, publicKey: b64url(receiverKp.publicKey), role: "hub", status: "paired", endpoint: receiver.httpURL, createdAt: now });
  await ops(sender, {
    operation: "insert", table: "Agent",
    records: [
      { id: HOMED_AGENT, name: HOMED_AGENT, role: "agent", admin: false, status: "active", publicKey: b64url(homedKp1.publicKey), originatorInstanceId: SENDER_ID, createdAt: earlier, updatedAt: earlier },
      { id: SPOKE_ADMIN, name: SPOKE_ADMIN, role: "admin", admin: true, status: "active", publicKey: b64url(spokeAdminKp.publicKey), originatorInstanceId: SENDER_ID, createdAt: earlier, updatedAt: earlier },
    ],
  });
}, 480_000);

afterAll(async () => {
  if (sender) await stopHarper(sender);
  if (receiver) await stopHarper(receiver);
}, HARPER_STOP_BUDGET_MS * 2 + 30_000);

describe("flair#2665 — which Agent fields an inbound federation record may change", () => {
  it("the home instance's push creates its agents; a row that arrives with admin state is stored without it", async () => {
    expect(await authAs(LOCAL_AGENT, ownerKp.secretKey), "harness: the local owner key authenticates").toBe(200);

    const result = await pushFromSender();
    expect(result.error).toBeUndefined();

    const homed = await readAgent(receiver, HOMED_AGENT);
    expect(homed?.publicKey).toBe(b64url(homedKp1.publicKey));
    expect(homed?.originatorInstanceId).toBe(SENDER_ID);
    expect(await authAs(HOMED_AGENT, homedKp1.secretKey)).toBe(200);

    const spokeAdmin = await readAgent(receiver, SPOKE_ADMIN);
    expect(spokeAdmin, "the agent reached the receiver").not.toBeNull();
    expect(spokeAdmin.publicKey).toBe(b64url(spokeAdminKp.publicKey));
    expect(spokeAdmin.role).not.toBe("admin");
    expect(spokeAdmin.admin).toBe(false);
    expect(await authAs(SPOKE_ADMIN, spokeAdminKp.secretKey)).toBe(200);
  }, 120_000);

  it("a key rotation on the home instance is applied on the receiver", async () => {
    // The write `flair agent rotate-key` makes on the home instance.
    await ops(sender, { operation: "update", table: "Agent", records: [{ id: HOMED_AGENT, publicKey: b64url(homedKp2.publicKey), updatedAt: iso() }] });

    const result = await pushFromSender();
    expect(result.error).toBeUndefined();

    expect((await readAgent(receiver, HOMED_AGENT))?.publicKey).toBe(b64url(homedKp2.publicKey));
    expect(await authAs(HOMED_AGENT, homedKp2.secretKey)).toBe(200);
    expect(await authAs(HOMED_AGENT, homedKp1.secretKey)).toBeGreaterThanOrEqual(400);
  }, 120_000);

  for (const [label, peerId, peerSecret] of [
    ["a spoke", OTHER_SPOKE_ID, otherSpokeKp.secretKey],
    ["a hub", OTHER_HUB_ID, otherHubKp.secretKey],
  ] as const) {
    it(`a key change from ${label} that is not the row's home is refused and the stored key, home and admin state are unchanged`, async () => {
      const out = await peerBatch(peerId, peerSecret, [
        { id: LOCAL_AGENT, data: { publicKey: b64url(foreignKp.publicKey), role: "admin", admin: true } },
        { id: HOMED_AGENT, data: { publicKey: b64url(foreignKp.publicKey), role: "admin", admin: true } },
      ]);
      expect(out.merged, JSON.stringify(out)).toBe(0);
      expect(out.skipped).toBe(2);
      expect(out.skippedReasons?.agent_identity_not_from_home).toBe(2);
      expect(out.refused).toEqual(expect.arrayContaining([
        { table: "Agent", id: LOCAL_AGENT, reason: "agent_identity_not_from_home" },
        { table: "Agent", id: HOMED_AGENT, reason: "agent_identity_not_from_home" },
      ]));

      const local = await readAgent(receiver, LOCAL_AGENT);
      expect(local.publicKey).toBe(b64url(ownerKp.publicKey));
      expect(local.originatorInstanceId).toBe(RECEIVER_ID);
      expect(local.role).toBe("agent");
      expect(local.admin).toBe(false);
      const homed = await readAgent(receiver, HOMED_AGENT);
      expect(homed.publicKey).toBe(b64url(homedKp2.publicKey));
      expect(homed.originatorInstanceId).toBe(SENDER_ID);

      expect(await authAs(LOCAL_AGENT, ownerKp.secretKey), "the owner's key authenticates").toBe(200);
      expect(await authAs(LOCAL_AGENT, foreignKp.secretKey), "the pushed key does not").toBeGreaterThanOrEqual(400);
      expect(await authAs(HOMED_AGENT, homedKp2.secretKey)).toBe(200);
      expect(await authAs(HOMED_AGENT, foreignKp.secretKey)).toBeGreaterThanOrEqual(400);
    }, 60_000);
  }

  it("a home change from a peer that is not the row's home is refused, so that peer's next key change is refused too", async () => {
    const moved = await peerBatch(OTHER_SPOKE_ID, otherSpokeKp.secretKey, [
      { id: LOCAL_AGENT, data: { originatorInstanceId: OTHER_SPOKE_ID } },
    ]);
    expect(moved.refused, JSON.stringify(moved)).toEqual([
      { table: "Agent", id: LOCAL_AGENT, reason: "agent_identity_not_from_home" },
    ]);
    expect((await readAgent(receiver, LOCAL_AGENT)).originatorInstanceId).toBe(RECEIVER_ID);

    const rekey = await peerBatch(OTHER_SPOKE_ID, otherSpokeKp.secretKey, [
      { id: LOCAL_AGENT, data: { publicKey: b64url(foreignKp.publicKey) } },
    ]);
    expect(rekey.refused, JSON.stringify(rekey)).toEqual([
      { table: "Agent", id: LOCAL_AGENT, reason: "agent_identity_not_from_home" },
    ]);
    expect((await readAgent(receiver, LOCAL_AGENT)).publicKey).toBe(b64url(ownerKp.publicKey));
  }, 60_000);

  it("a record from a hub peer whose originatorInstanceId names the row's home is refused: the decision uses the verified sender", async () => {
    const out = await peerBatch(OTHER_HUB_ID, otherHubKp.secretKey, [
      { id: HOMED_AGENT, originator: SENDER_ID, data: { publicKey: b64url(foreignKp.publicKey), originatorInstanceId: SENDER_ID } },
    ]);
    expect(out.refused, JSON.stringify(out)).toEqual([
      { table: "Agent", id: HOMED_AGENT, reason: "agent_identity_not_from_home" },
    ]);
    expect((await readAgent(receiver, HOMED_AGENT)).publicKey).toBe(b64url(homedKp2.publicKey));
    expect(await authAs(HOMED_AGENT, foreignKp.secretKey)).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it("a new row whose id the receiver's FLAIR_ADMIN_AGENTS names is refused; a control id is created without admin state", async () => {
    expect(await adminReadAs(CONFIGURED_LOCAL, configuredOwnerKp.secretKey), "harness: the configured local agent passes the admin gate").toBe(200);

    const out = await peerBatch(OTHER_SPOKE_ID, otherSpokeKp.secretKey, [
      { id: CONFIGURED_ABSENT, data: { name: CONFIGURED_ABSENT, role: "agent", status: "active", publicKey: b64url(foreignKp.publicKey), originatorInstanceId: OTHER_SPOKE_ID, createdAt: iso() } },
      { id: CONTROL_NEW, data: { name: CONTROL_NEW, role: "agent", status: "active", publicKey: b64url(controlKp.publicKey), originatorInstanceId: OTHER_SPOKE_ID, createdAt: iso() } },
      { id: CONFIGURED_LOCAL, data: { publicKey: b64url(foreignKp.publicKey) } },
    ]);
    expect(out.merged, JSON.stringify(out)).toBe(1);
    expect(out.skipped).toBe(2);
    expect(out.skippedReasons?.agent_admin_id_not_federated).toBe(1);
    expect(out.refused).toEqual(expect.arrayContaining([
      { table: "Agent", id: CONFIGURED_ABSENT, reason: "agent_admin_id_not_federated" },
      { table: "Agent", id: CONFIGURED_LOCAL, reason: "agent_identity_not_from_home" },
    ]));

    expect(await readAgent(receiver, CONFIGURED_ABSENT), "no row exists for the configured id").toBeNull();
    expect(await adminReadAs(CONFIGURED_ABSENT, foreignKp.secretKey)).toBeGreaterThanOrEqual(400);

    expect((await readAgent(receiver, CONFIGURED_LOCAL)).publicKey).toBe(b64url(configuredOwnerKp.publicKey));
    expect(await adminReadAs(CONFIGURED_LOCAL, configuredOwnerKp.secretKey), "the owner's admin-only read is unaffected").toBe(200);
    expect(await adminReadAs(CONFIGURED_LOCAL, foreignKp.secretKey)).toBeGreaterThanOrEqual(400);

    const control = await readAgent(receiver, CONTROL_NEW);
    expect(control?.publicKey).toBe(b64url(controlKp.publicKey));
    expect(control.role).not.toBe("admin");
    expect(control.admin).not.toBe(true);
    expect(await adminReadAs(CONTROL_NEW, controlKp.secretKey)).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it("a federation merge does not set admin state from a non-home peer, from the home, or on a new row", async () => {
    // An existing local row, from a peer that is not its home (no key change).
    const fromPeer = await peerBatch(OTHER_SPOKE_ID, otherSpokeKp.secretKey, [
      { id: LOCAL_AGENT, data: { role: "admin", admin: true } },
    ]);
    expect(fromPeer.refused, JSON.stringify(fromPeer)).toEqual([]);
    // An existing synced row, from its home through the real push.
    await ops(sender, { operation: "update", table: "Agent", records: [{ id: HOMED_AGENT, role: "admin", admin: true, updatedAt: iso() }] });
    const pushed = await pushFromSender();
    expect(pushed.error).toBeUndefined();
    // A new row from a peer.
    const created = await peerBatch(OTHER_SPOKE_ID, otherSpokeKp.secretKey, [
      { id: PEER_NEW, data: { name: PEER_NEW, role: "admin", admin: true, status: "active", publicKey: b64url(peerNewKp.publicKey), originatorInstanceId: OTHER_SPOKE_ID, createdAt: iso() } },
    ]);
    expect(created.merged, JSON.stringify(created)).toBe(1);

    for (const id of [LOCAL_AGENT, HOMED_AGENT, SPOKE_ADMIN, PEER_NEW]) {
      const row = await readAgent(receiver, id);
      expect(row, id).not.toBeNull();
      expect(row.role, `${id} role`).not.toBe("admin");
      expect(row.admin, `${id} admin mirror`).not.toBe(true);
    }

    // The admin set is cached for 60 s per worker (resources/agent-auth.ts), so
    // probe the gate after that window has passed.
    await new Promise((r) => setTimeout(r, 61_000));
    expect(await adminReadAs(LOCAL_ADMIN, localAdminKp.secretKey), "control: a local admin passes the admin gate").toBe(200);
    expect(await adminReadAs(LOCAL_AGENT, ownerKp.secretKey)).toBeGreaterThanOrEqual(400);
    expect(await adminReadAs(HOMED_AGENT, homedKp2.secretKey)).toBeGreaterThanOrEqual(400);
    expect(await adminReadAs(SPOKE_ADMIN, spokeAdminKp.secretKey)).toBeGreaterThanOrEqual(400);
    expect(await adminReadAs(PEER_NEW, peerNewKp.secretKey)).toBeGreaterThanOrEqual(400);
  }, 180_000);
});
