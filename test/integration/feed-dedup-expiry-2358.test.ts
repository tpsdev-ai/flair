import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { computeContentHash } from "../../resources/memory-feed-lib.js";

// A small, non-default TTL so the repaired row can be reaped inside the test.
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
async function readStored(harper: HarperInstance, id: string): Promise<{ durability?: string; expiresAt?: string | null; content?: string } | null> {
  const read = await adminOp(harper, {
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "id", search_value: id, get_attributes: ["id", "durability", "expiresAt", "content"],
  });
  expect(read.status).toBe(200);
  const rows = await read.json();
  const record = Array.isArray(rows) ? rows[0] : rows;
  return record ?? null;
}

/** Insert a stored Memory row directly, with the content hash the feed dedups on. */
async function seedMemory(harper: HarperInstance, agent: TestAgent, row: Record<string, any>): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Memory",
    records: [{ contentHash: computeContentHash(agent.id, String(row.content)), createdAt: new Date().toISOString(), ...row }],
  });
  expect(res.status).toBe(200);
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
const agent = mkAgent("dedup-eph-owner");

beforeAll(async () => {
  harper = await startHarper();
  await seedAgent(harper, agent);
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (PRIOR_TTL === undefined) delete process.env.FLAIR_EPHEMERAL_TTL_HOURS;
  else process.env.FLAIR_EPHEMERAL_TTL_HOURS = PRIOR_TTL;
});

describe("deduplicated ephemeral feed expiry (flair#2358)", () => {
  test("a deduplicated ephemeral row with no expiry is repaired and then reaped", async () => {
    const content = `deduplicated ephemeral state ${randomUUID()}`;
    const id = `dedup-eph-${randomUUID()}`;
    await seedMemory(harper, agent, { id, agentId: agent.id, content, durability: "ephemeral" });
    expect((await readStored(harper, id))?.expiresAt ?? null).toBeNull();

    // Same agent + content: the feed's content-hash dedup returns the stored
    // row instead of writing a new one.
    const before = Date.now();
    const res = await authFetch(harper, agent, "POST", "/FeedMemories", { agentId: agent.id, content });
    expect(res.status).toBe(200);

    const stored = await readStored(harper, id);
    expect(stored?.durability).toBe("ephemeral");
    expect(typeof stored?.expiresAt).toBe("string");
    expect(Date.parse(stored!.expiresAt!)).toBeGreaterThanOrEqual(before + Number(TTL_HOURS) * 3600000);
    expect(Date.parse(stored!.expiresAt!)).toBeLessThanOrEqual(Date.now() + Number(TTL_HOURS) * 3600000);

    // The repaired expiry is the reap signal: once it passes, maintenance reaps.
    await new Promise((r) => setTimeout(r, 6000));
    const result = await runMaintenance(harper, agent.id);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await readStored(harper, id)).toBeNull();
  }, 30_000);

  test("a deduplicated ephemeral row that already has an expiry keeps it", async () => {
    const content = `deduplicated dated state ${randomUUID()}`;
    const id = `dedup-keep-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await seedMemory(harper, agent, { id, agentId: agent.id, content, durability: "ephemeral", expiresAt });

    const res = await authFetch(harper, agent, "POST", "/FeedMemories", { agentId: agent.id, content });
    expect(res.status).toBe(200);

    const stored = await readStored(harper, id);
    expect(stored?.durability).toBe("ephemeral");
    expect(stored?.expiresAt).toBe(expiresAt);
  }, 30_000);

  test("a deduplicated persistent row gets no expiry", async () => {
    const content = `deduplicated durable fact ${randomUUID()}`;
    const id = `dedup-persist-${randomUUID()}`;
    await seedMemory(harper, agent, { id, agentId: agent.id, content, durability: "persistent" });

    const res = await authFetch(harper, agent, "POST", "/FeedMemories", { agentId: agent.id, content });
    expect(res.status).toBe(200);

    const stored = await readStored(harper, id);
    expect(stored?.durability).toBe("persistent");
    expect(stored?.expiresAt ?? null).toBeNull();
  }, 30_000);
});
