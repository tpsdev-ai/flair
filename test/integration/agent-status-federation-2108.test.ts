// agent-status-federation-2108.test.ts — flair#2108, the federation half.
//
// A known peer with a pinned key pushes a signed batch to POST /FederationSync.
// The merge writes the Agent table through the RAW table
// (resources/Federation.ts), not through the Agent resource's status guard.
// flair#2108: an inbound Agent record whose `status` differs from an existing
// local principal's stored value is skipped WHOLE — the federation path carries
// no verified administrator authority for that principal — so a second field in
// the same record does not land either. A separate runtime-only record syncs.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

const sfx = Date.now().toString(36);
const HUB = `afs-hub-${sfx}`;
const TARGET = `afs-target-${sfx}`;
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
    body: JSON.stringify(operation),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function rawAgent(id: string): Promise<any> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table: "Agent", ids: [id], get_attributes: ["id", "status", "runtime"] });
  return Array.isArray(rows) ? rows[0] : null;
}

const hub = nacl.sign.keyPair();
const hubPublicKey = Buffer.from(hub.publicKey).toString("base64url");

async function sync(data: Record<string, unknown>): Promise<any> {
  const body = signBodyFresh(
    { instanceId: HUB, records: [{ table: "Agent", id: TARGET, updatedAt: now(), originatorInstanceId: HUB, ...data }], lamportClock: Date.now() },
    hub.secretKey,
  );
  const res = await fetch(`${harper.httpURL}/FederationSync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  expect(res.status, `FederationSync returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

describe("flair#2108 — an inbound federated record cannot change an existing local principal's status", () => {
  beforeAll(async () => {
    harper = await startHarper();
    assertOwnInstance(harper);
    const t = new Date(Date.now() - 60_000).toISOString();
    await ops({
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: TARGET, name: TARGET, role: "agent", admin: false, status: "active", runtime: "local", publicKey: "pending", createdAt: t, updatedAt: t }],
    });
    await ops({
      operation: "insert", database: "flair", table: "Peer",
      records: [{ id: HUB, publicKey: hubPublicKey, role: "hub", status: "active", createdAt: now() }],
    });
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("a peer record whose `status` differs from the stored value is skipped whole: status and a second field are unchanged", async () => {
    const out = await sync({ data: { id: TARGET, status: "deactivated", runtime: "remote" } });
    expect(out.skippedReasons?.agent_status_not_federated, JSON.stringify(out)).toBe(1);
    const rec = await rawAgent(TARGET);
    expect(rec?.status, "the peer changed the local principal's status").toBe("active");
    expect(rec?.runtime, "a second field in the refused record landed (partial merge)").toBe("local");
  }, 30_000);

  test("CONTROL: a separate runtime-only peer record syncs", async () => {
    const out = await sync({ data: { id: TARGET, runtime: "remote2" } });
    expect(out.merged, JSON.stringify(out)).toBe(1);
    const rec = await rawAgent(TARGET);
    expect(rec?.runtime, "an ordinary field did not sync").toBe("remote2");
    expect(rec?.status).toBe("active");
  }, 30_000);
});
