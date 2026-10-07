// flair#2274 — feed-written ephemeral memories get the tier expiry.
//
// FeedMemories.post() writes through the RAW Memory table, bypassing
// Memory.post()/put(). Before the fix it never stamped the ephemeral tier's
// expiresAt, so an ephemeral row written through the feed was never reaped by
// MemoryMaintenance — contradicting the documented 24-hour ephemeral tier.
//
// This is the REAL-Harper control: it boots the repo's ephemeral Harper
// (test/helpers/harper-lifecycle) and drives POST /FeedMemories over the real
// REST surface, then reads the STORED row back through the admin ops API and
// runs POST /MemoryMaintenance. The expiry is asserted against the SAME shared
// rule the writes use (resources/memory-durability.ts's stampEphemeralExpiry),
// not a hand-computed constant.
//
// FLAIR_EPHEMERAL_TTL_HOURS is set to a small value for this instance so a
// tier-stamped row passes its expiry within the test window — the "it has
// passed" reap below. The shared rule reads the same env, so the assertion is
// still against the rule, not the constant.
//
// Mutation: bypass the shared rule in MemoryFeed.post() (drop the
// stampEphemeralExpiry call) and the first test goes red (no expiresAt), the
// reap test goes red (the row survives maintenance). Both go green restored.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
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
    // patch() is the other Memory writer that can assign the ephemeral tier;
    // it must apply the same shared rule (asserted against it, not a constant).
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
