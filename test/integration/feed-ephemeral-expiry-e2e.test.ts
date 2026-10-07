import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { stampEphemeralExpiry } from "../../resources/memory-durability.ts";

// A small, non-default TTL so a tier-stamped row can be reaped inside the test.
const TTL_HOURS = "0.001"; // 3.6s
const PRIOR_TTL = process.env.FLAIR_EPHEMERAL_TTL_HOURS;
process.env.FLAIR_EPHEMERAL_TTL_HOURS = TTL_HOURS;

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function authFetch(harper: HarperInstance, agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Authorization: ed25519Header(agent, method, path) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${harper.httpURL}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}

async function seedAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status).toBe(200);
}

/** The stored row's durability + expiresAt, read back through the admin surface. */
async function readStored(harper: HarperInstance, id: string): Promise<{ durability?: string; expiresAt?: string | null } | null> {
  const read = await adminOp(harper, {
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "id", search_value: id, get_attributes: ["id", "durability", "expiresAt"],
  });
  expect(read.status).toBe(200);
  const rows = await read.json();
  const record = Array.isArray(rows) ? rows[0] : rows;
  return record ?? null;
}

async function runMaintenance(harper: HarperInstance, agentId: string): Promise<any> {
  const res = await fetch(`${harper.httpURL}/MemoryMaintenance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify({ agentId }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

let harper: HarperInstance;
const agent = mkAgent("eph-feed-owner");

beforeAll(async () => {
  harper = await startHarper();
  await seedAgent(harper, agent);
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (PRIOR_TTL === undefined) delete process.env.FLAIR_EPHEMERAL_TTL_HOURS;
  else process.env.FLAIR_EPHEMERAL_TTL_HOURS = PRIOR_TTL;
});

describe("feed-written ephemeral memories get the tier expiry (flair#2274)", () => {
  test("a fresh ephemeral feed write carries the tier expiry (asserted against the shared rule)", async () => {
    const id = `feed-eph-expiry-${randomUUID()}`;
    const res = await authFetch(harper, agent, "POST", "/FeedMemories", {
      id, agentId: agent.id,
      content: `feed-captured ephemeral state ${id}`,
      durability: "ephemeral",
    });
    expect(res.status).toBe(200);

    const stored = await readStored(harper, id);
    expect(stored?.durability).toBe("ephemeral");
    expect(typeof stored?.expiresAt).toBe("string");

    // Asserted against the shared rule, not a hand-computed constant.
    const expected: Record<string, any> = { durability: "ephemeral" };
    stampEphemeralExpiry(expected);
    expect(Math.abs(Date.parse(stored!.expiresAt!) - Date.parse(expected.expiresAt))).toBeLessThan(2000);
  }, 30_000);

  test("maintenance reaps a feed-written ephemeral row once its tier expiry has passed", async () => {
    const id = `feed-eph-reap-${randomUUID()}`;
    const res = await authFetch(harper, agent, "POST", "/FeedMemories", {
      id, agentId: agent.id,
      content: `feed-captured ephemeral state to reap ${id}`,
      durability: "ephemeral",
    });
    expect(res.status).toBe(200);
    // The row carries a tier expiry from the shared rule; wait for it to pass.
    expect(typeof (await readStored(harper, id))?.expiresAt).toBe("string");
    await new Promise((r) => setTimeout(r, 6000));

    const result = await runMaintenance(harper, agent.id);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await readStored(harper, id)).toBeNull();
  }, 30_000);

  test("no over-fire: a persistent feed write gets NO expiry", async () => {
    const id = `feed-persistent-${randomUUID()}`;
    const res = await authFetch(harper, agent, "POST", "/FeedMemories", {
      id, agentId: agent.id,
      content: `a durable feed fact ${id}`,
      durability: "persistent",
    });
    expect(res.status).toBe(200);
    const stored = await readStored(harper, id);
    expect(stored?.durability).toBe("persistent");
    expect(stored?.expiresAt ?? null).toBeNull();
  }, 30_000);

  test("a caller-supplied expiresAt is preserved", async () => {
    const id = `feed-eph-explicit-${randomUUID()}`;
    const supplied = new Date(Date.now() + 3_600_000).toISOString();
    const res = await authFetch(harper, agent, "POST", "/FeedMemories", {
      id, agentId: agent.id,
      content: `an explicitly dated feed row ${id}`,
      durability: "ephemeral",
      expiresAt: supplied,
    });
    expect(res.status).toBe(200);
    expect((await readStored(harper, id))?.expiresAt).toBe(supplied);
  }, 30_000);

  test("a PATCH that flips a row to the ephemeral tier carries the tier expiry", async () => {
    const id = `memory-patch-eph-${randomUUID()}`;
    const put = await authFetch(harper, agent, "PUT", `/Memory/${id}`, {
      id, agentId: agent.id,
      content: `a standard note later flipped to ephemeral ${id}`,
      durability: "standard",
    });
    expect(put.ok).toBe(true);
    const patch = await authFetch(harper, agent, "PATCH", `/Memory/${id}`, {
      id, agentId: agent.id,
      durability: "ephemeral",
    });
    expect(patch.ok).toBe(true);

    const stored = await readStored(harper, id);
    expect(stored?.durability).toBe("ephemeral");
    expect(typeof stored?.expiresAt).toBe("string");
    const expected: Record<string, any> = { durability: "ephemeral" };
    stampEphemeralExpiry(expected);
    expect(Math.abs(Date.parse(stored!.expiresAt!) - Date.parse(expected.expiresAt))).toBeLessThan(2000);
  }, 30_000);
});

describe("stored expiry updates", () => {
  test("partial PUT keeps the ephemeral tier and expiry until maintenance reaps it", async () => {
    const id = `partial-put-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 1500).toISOString();
    expect((await authFetch(harper, agent, "PUT", `/Memory/${id}`, {
      id, agentId: agent.id, content: `original ${id}`, durability: "ephemeral", expiresAt,
    })).ok).toBe(true);
    expect((await authFetch(harper, agent, "PUT", `/Memory/${id}`, {
      id, agentId: agent.id, content: `updated ${id}`,
    })).ok).toBe(true);
    const stored = await readStored(harper, id);
    expect(stored?.durability).toBe("ephemeral");
    expect(stored?.expiresAt).toBe(expiresAt);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await runMaintenance(harper, agent.id);
    expect(await readStored(harper, id)).toBeNull();
  }, 30000);

  for (const method of ["PUT", "PATCH"]) {
    test(`${method} clears the inherited tier expiry and stamps a fresh expiry on re-entry`, async () => {
      const id = `transition-${method}-${randomUUID()}`;
      const expired = "2020-01-01T00:00:00.000Z";
      expect((await authFetch(harper, agent, "PUT", `/Memory/${id}`, {
        id, agentId: agent.id, content: `transition ${id}`, durability: "ephemeral", expiresAt: expired,
      })).ok).toBe(true);
      const update = (durability: string, expiresAt?: string) => authFetch(harper, agent, method, `/Memory/${id}`, {
        id, agentId: agent.id, content: `transition ${id}`, durability,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      expect((await update("persistent")).ok).toBe(true);
      expect((await readStored(harper, id))?.expiresAt ?? null).toBeNull();
      await runMaintenance(harper, agent.id);
      expect((await readStored(harper, id))?.durability).toBe("persistent");
      const before = Date.now();
      expect((await update("ephemeral")).ok).toBe(true);
      const fresh = (await readStored(harper, id))?.expiresAt;
      expect(Date.parse(fresh!)).toBeGreaterThanOrEqual(before + Number(TTL_HOURS) * 3600000);
      expect((await update("ephemeral")).ok).toBe(true);
      expect((await readStored(harper, id))?.expiresAt).toBe(fresh);
      const explicit = new Date(Date.now() + 3600000).toISOString();
      expect((await update("ephemeral", explicit)).ok).toBe(true);
      expect((await readStored(harper, id))?.expiresAt).toBe(explicit);
    }, 30000);
  }

  test("AgentSeed stores a default expiry for an ephemeral starter memory", async () => {
    const agentId = `seed-expiry-${randomUUID()}`;
    const before = Date.now();
    const res = await fetch(`${harper.httpURL}/AgentSeed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
      body: JSON.stringify({ agentId, starterMemories: [{ content: "starter note", durability: "ephemeral" }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memories).toHaveLength(1);
    const stored = await readStored(harper, body.memories[0].id);
    expect(stored?.durability).toBe("ephemeral");
    expect(Date.parse(stored!.expiresAt!)).toBeGreaterThanOrEqual(before + Number(TTL_HOURS) * 3600000);
    expect(Date.parse(stored!.expiresAt!)).toBeLessThanOrEqual(Date.now() + Number(TTL_HOURS) * 3600000);
  }, 30000);
});

describe("signed federation expiry", () => {
  const kp = nacl.sign.keyPair();
  const instanceId = "expiry-spoke";
  beforeAll(async () => {
    const res = await adminOp(harper, {
      operation: "insert", database: "flair", table: "Peer",
      records: [{ id: instanceId, publicKey: Buffer.from(kp.publicKey).toString("base64url"), role: "spoke", status: "paired", createdAt: new Date().toISOString() }],
    });
    expect(res.status).toBe(200);
  });
  async function receive(id: string, fields: Record<string, unknown>) {
    const now = new Date().toISOString();
    const signed = signBodyFresh({ instanceId, records: [{
      table: "Memory", id,
      data: { id, agentId: agent.id, content: `received ${id}`, durability: "ephemeral", visibility: "private", createdAt: now, updatedAt: now, ...fields },
      updatedAt: now,
    }], lamportClock: Date.now() }, kp.secretKey);
    const res = await fetch(`${harper.httpURL}/FederationSync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signed) });
    expect(res.status).toBe(200);
    return res.json();
  }

  test("signed receive stores receiver-clock expiry when the incoming expiry is missing", async () => {
    const id = `federated-missing-${randomUUID()}`;
    const insert = await adminOp(harper, {
      operation: "insert", database: "flair", table: "Memory",
      records: [{ id, agentId: agent.id, content: "earlier received note", durability: "ephemeral", expiresAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" }],
    });
    expect(insert.status).toBe(200);
    const before = Date.now();
    expect((await receive(id, {})).merged).toBe(1);
    const stored = await readStored(harper, id);
    expect(stored?.durability).toBe("ephemeral");
    expect(Date.parse(stored!.expiresAt!)).toBeGreaterThanOrEqual(before + Number(TTL_HOURS) * 3600000);
    expect(Date.parse(stored!.expiresAt!)).toBeLessThanOrEqual(Date.now() + Number(TTL_HOURS) * 3600000);
  }, 30000);

  test("signed receive keeps a valid peer expiry within the accepted bound", async () => {
    const id = `federated-valid-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    expect((await receive(id, { expiresAt })).merged).toBe(1);
    expect((await readStored(harper, id))?.expiresAt).toBe(expiresAt);
  }, 30000);

  test("signed receive refuses malformed and out-of-bound ephemeral expiry", async () => {
    for (const expiresAt of ["invalid", null, new Date(Date.now() + 366 * 86400000).toISOString()]) {
      const id = `federated-refused-${randomUUID()}`;
      const result = await receive(id, { expiresAt });
      expect(result.merged).toBe(0);
      expect(result.skippedReasons?.invalid_expiry).toBe(1);
      expect(await readStored(harper, id)).toBeNull();
    }
  }, 30000);
});
