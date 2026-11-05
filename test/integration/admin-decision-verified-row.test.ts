/**
 * admin-decision-verified-row.test.ts — real Harper.
 *
 * The admin decision for an Ed25519-verified agent uses the Agent row the
 * verifier reads for the key check, plus the ids FLAIR_ADMIN_AGENTS names. Each
 * case changes the Agent table and then, with no wait, sends signed requests to
 * an admin-only route (AgentKeyRegistration, whose allowRead is allowAdmin).
 * The four removal cases and the two role-change cases first read the caller's
 * own Agent row with the same key (a route any verified agent may read), so
 * their admin-only refusal is shown to come from the admin decision and not from
 * a failed signature check. The control case reads the non-admin agent's own
 * row; the creation case and the configured-id case probe only the admin-only
 * route.
 *
 * Cases:
 *   - an admin agent's row is removed (through the operations API, as `flair
 *     agent remove` does, or by a REST DELETE from another administrator) and a
 *     new row with the same id and a different key is created (by a REST POST
 *     from an administrator, or by a federation merge from a paired peer): the
 *     new key's next admin-only request is refused;
 *   - an agent created with role "admin" by an administrator is admitted on its
 *     first request, and its next admin-only request after an administrator
 *     changes its role (through the Agent resource, or through the operations
 *     API) is refused;
 *   - an id FLAIR_ADMIN_AGENTS names is admitted with a non-admin row.
 *
 * One ephemeral, loopback, HOME-isolated Harper (test/helpers/harper-lifecycle).
 * The paired peer signs its FederationSync batches in-process, as
 * test/integration/federation-agent-field-scope-2665.test.ts does.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { signBodyFresh } from "../../resources/federation-crypto";

const sfx = Date.now().toString(36);
const RECEIVER_ID = `flair_hub_adm_${sfx}`;
const PEER_ID = `flair_spoke_adm_${sfx}`;

const OPERATOR = `adm-operator-${sfx}`; // a standing admin agent
const CONFIGURED = `adm-configured-${sfx}`; // named in FLAIR_ADMIN_AGENTS; row role "agent"
const PLAIN = `adm-plain-${sfx}`; // row role "agent"; not configured
const CREATED = `adm-created-${sfx}`; // created as an admin during a case

type Removal = "an operations-API delete" | "a REST DELETE";
type Recreate = "REST POST by an administrator" | "federation merge from a paired peer";
const REMOVALS: Removal[] = ["an operations-API delete", "a REST DELETE"];
const RECREATES: Recreate[] = ["REST POST by an administrator", "federation merge from a paired peer"];

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

const receiverKp = nacl.sign.keyPair();
const peerKp = nacl.sign.keyPair();
const operatorKp = nacl.sign.keyPair();
const configuredKp = nacl.sign.keyPair();
const plainKp = nacl.sign.keyPair();
const createdKp = nacl.sign.keyPair();

/** One admin agent per removal × re-create case: its first key and the key of the new row. */
const subjects = new Map<string, { id: string; firstKp: nacl.SignKeyPair; nextKp: nacl.SignKeyPair }>();
REMOVALS.forEach((removal, i) => RECREATES.forEach((recreate, j) => {
  subjects.set(`${removal}|${recreate}`, { id: `adm-subject-${i}${j}-${sfx}`, firstKp: nacl.sign.keyPair(), nextKp: nacl.sign.keyPair() });
}));

let harper: HarperInstance;

const basic = (h: HarperInstance) => "Basic " + Buffer.from(`${h.admin.username}:${h.admin.password}`).toString("base64");

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic(harper) },
    body: JSON.stringify({ database: "flair", ...operation }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function readAgent(id: string): Promise<any> {
  const rows = await ops({ operation: "search_by_hash", table: "Agent", hash_values: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

/** A TPS-Ed25519 signed request; returns the status and the body text. */
async function signed(
  method: string,
  agentId: string,
  secretKey: Uint8Array,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${agentId}:${ts}:${nonce}:${method}:${path}`), secretKey);
  const res = await fetch(`${harper.httpURL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, text: (await res.text()).slice(0, 400) };
}

/** Status of a signed GET to an admin-only route. */
const adminOnly = async (id: string, kp: nacl.SignKeyPair) => (await signed("GET", id, kp.secretKey, "/AgentKeyRegistration/")).status;
/** Status of a signed GET any verified agent may make: its own Agent row. */
const ownRow = async (id: string, kp: nacl.SignKeyPair) => (await signed("GET", id, kp.secretKey, `/Agent/${id}`)).status;
const asOperator = (method: string, path: string, body?: unknown) => signed(method, OPERATOR, operatorKp.secretKey, path, body);

/** A signed FederationSync batch of Agent records from the paired peer. */
async function peerBatch(records: Array<{ id: string; data: Record<string, unknown> }>): Promise<any> {
  const body = signBodyFresh({
    instanceId: PEER_ID,
    records: records.map((r) => ({
      table: "Agent", id: r.id, updatedAt: iso(), originatorInstanceId: PEER_ID, data: { id: r.id, ...r.data },
    })),
    lamportClock: Date.now(),
  }, peerKp.secretKey);
  const res = await fetch(`${harper.httpURL}/FederationSync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  expect(res.status, `FederationSync: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

async function remove(removal: Removal, id: string): Promise<void> {
  if (removal === "an operations-API delete") {
    // The write `flair agent remove` sends (src/commands/agent.ts).
    await ops({ operation: "delete", table: "Agent", ids: [id] });
  } else {
    const del = await asOperator("DELETE", `/Agent/${id}`);
    expect(del.status, `REST DELETE: ${del.text}`).toBeLessThan(300);
  }
  expect(await readAgent(id), "the row is removed").toBeNull();
}

async function recreate(how: Recreate, id: string, kp: nacl.SignKeyPair): Promise<void> {
  if (how === "REST POST by an administrator") {
    const res = await asOperator("POST", "/Agent/", { id, name: id, role: "agent", status: "active", publicKey: b64url(kp.publicKey) });
    expect(res.status, `REST POST: ${res.text}`).toBeLessThan(300);
  } else {
    // The record carries admin fields; a merge stores a new row without them.
    const out = await peerBatch([{
      id,
      data: { name: id, role: "admin", admin: true, status: "active", publicKey: b64url(kp.publicKey), originatorInstanceId: PEER_ID, createdAt: iso() },
    }]);
    expect(out.merged, JSON.stringify(out)).toBe(1);
  }
}

beforeAll(async () => {
  harper = await startHarper({ serverEnv: { FLAIR_ADMIN_AGENTS: CONFIGURED } });
  for (const url of [harper.httpURL, harper.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], `${url} must be loopback`).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must avoid ports 9925/9926`).not.toContain(u.port);
  }
  expect(harper.process?.pid).toBeGreaterThan(0);

  const now = iso();
  const earlier = iso(-60_000);
  await ops({ operation: "insert", table: "Instance", records: [{ id: RECEIVER_ID, publicKey: b64url(receiverKp.publicKey), role: "hub", createdAt: now }] });
  await ops({ operation: "insert", table: "Peer", records: [{ id: PEER_ID, publicKey: b64url(peerKp.publicKey), role: "spoke", status: "paired", createdAt: now }] });
  const agent = (id: string, role: string, kp: nacl.SignKeyPair) => ({
    id, name: id, role, admin: role === "admin", status: "active", publicKey: b64url(kp.publicKey),
    originatorInstanceId: RECEIVER_ID, createdAt: earlier, updatedAt: earlier,
  });
  await ops({
    operation: "insert", table: "Agent", records: [
      agent(OPERATOR, "admin", operatorKp),
      agent(CONFIGURED, "agent", configuredKp),
      agent(PLAIN, "agent", plainKp),
      ...[...subjects.values()].map((s) => agent(s.id, "admin", s.firstKp)),
    ],
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
}, HARPER_STOP_BUDGET_MS + 10_000);

describe("the admin decision for a verified agent uses the Agent row the verifier reads", () => {
  it("control: the admin agents' first keys pass the admin-only route and a non-admin agent's key does not", async () => {
    expect(await adminOnly(OPERATOR, operatorKp)).toBe(200);
    for (const s of subjects.values()) expect(await adminOnly(s.id, s.firstKp), s.id).toBe(200);
    expect(await ownRow(PLAIN, plainKp)).toBe(200);
    expect(await adminOnly(PLAIN, plainKp)).toBe(403);
  }, 60_000);

  for (const removal of REMOVALS) {
    for (const how of RECREATES) {
      it(`an admin row removed by ${removal}, then a new row under the same id from a ${how}: the new key's next admin-only request is refused`, async () => {
        const s = subjects.get(`${removal}|${how}`)!;
        expect(await adminOnly(s.id, s.firstKp), "an admin before the removal").toBe(200);

        await remove(removal, s.id);
        await recreate(how, s.id, s.nextKp);

        const stored = await readAgent(s.id);
        expect(stored?.publicKey, "the new row carries the new key").toBe(b64url(s.nextKp.publicKey));
        expect(stored.role).not.toBe("admin");
        expect(stored.admin).not.toBe(true);

        // No wait between the table change and these requests.
        expect(await ownRow(s.id, s.nextKp), "the new key verifies").toBe(200);
        expect(await adminOnly(s.id, s.nextKp), "the stored row is not an admin row").toBe(403);
        expect(await adminOnly(s.id, s.firstKp), "the first key no longer matches the row").toBeGreaterThanOrEqual(400);
      }, 60_000);
    }
  }

  it("an agent created with role admin by an administrator passes the admin-only route on its first request", async () => {
    const res = await asOperator("POST", "/Agent/", { id: CREATED, name: CREATED, role: "admin", status: "active", publicKey: b64url(createdKp.publicKey) });
    expect(res.status, `REST POST: ${res.text}`).toBeLessThan(300);
    expect((await readAgent(CREATED))?.role).toBe("admin");
    expect(await adminOnly(CREATED, createdKp)).toBe(200);
  }, 60_000);

  it("the next admin-only request after an administrator changes that agent's role through the Agent resource is refused", async () => {
    expect(await adminOnly(CREATED, createdKp), "an admin before the change").toBe(200);
    // Both fields: a PATCH reconciles the two admin fields against the merged row.
    const res = await asOperator("PATCH", `/Agent/${CREATED}`, { role: "agent", admin: false });
    expect(res.status, `PATCH: ${res.text}`).toBeLessThan(300);
    const stored = await readAgent(CREATED);
    expect(stored.role).toBe("agent");
    expect(stored.admin).toBe(false);
    expect(await ownRow(CREATED, createdKp)).toBe(200);
    expect(await adminOnly(CREATED, createdKp)).toBe(403);
  }, 60_000);

  it("the next admin-only request after an administrator changes an agent's role through the operations API is refused", async () => {
    const res = await asOperator("PATCH", `/Agent/${CREATED}`, { role: "admin" });
    expect(res.status, `PATCH: ${res.text}`).toBeLessThan(300);
    expect(await adminOnly(CREATED, createdKp), "an admin before the change").toBe(200);

    await ops({ operation: "update", table: "Agent", records: [{ id: CREATED, role: "agent", admin: false, updatedAt: iso() }] });
    expect((await readAgent(CREATED)).role).toBe("agent");
    expect(await ownRow(CREATED, createdKp)).toBe(200);
    expect(await adminOnly(CREATED, createdKp)).toBe(403);
  }, 60_000);

  it("an id FLAIR_ADMIN_AGENTS names passes the admin-only route with a non-admin row", async () => {
    const stored = await readAgent(CONFIGURED);
    expect(stored.role).toBe("agent");
    expect(await adminOnly(CONFIGURED, configuredKp)).toBe(200);
    expect(await adminOnly(PLAIN, plainKp), "control: an id the configuration does not name").toBe(403);
  }, 60_000);
});
