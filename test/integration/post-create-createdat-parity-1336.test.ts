// flair#1336 — POST /Memory createdAt parity with PUT, behavioural positive control.
//
// #1336 moved client creates (adk-flair) from `PUT /Memory/{id}` onto
// `POST /Memory/` — the create verb — because PUT-shaped creates 404 on some
// hosted Harper deployments. That exposed an undocumented POST/PUT asymmetry:
// put() has always honored a caller-supplied createdAt (`?? now`), while
// post() unconditionally re-stamped it with server-now, silently discarding
// historical timestamps (adk-flair forwards MemoryEntry.timestamp as
// createdAt; the #1334 list-pagination live test caught the discard).
//
// This file is the fails-on-main control for the parity fix:
//   - pre-fix: the backdated-createdAt POST round-trips as "now"  → test 1 RED
//   - post-fix: caller createdAt is preserved; validFrom follows it; the
//     ephemeral expiresAt stamp stays anchored to the WRITE moment, so a
//     backdated (or forward-dated) createdAt cannot move the #1257
//     exposure window.
//
// Pattern: test/integration/durability-write-validation-e2e.test.ts
// (Ed25519 signing helpers, admin-op seeding, startHarper lifecycle).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

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

async function getRecord(harper: HarperInstance, agent: TestAgent, id: string): Promise<any> {
  const res = await authFetch(harper, agent, "GET", `/Memory/${id}`);
  expect(res.status).toBe(200);
  return res.json();
}

let harper: HarperInstance;
const agent = mkAgent("parity-owner-1336");

// A timestamp unambiguously in the past — a re-stamp to "now" can never
// collide with it, so the assertion cannot pass by accident.
const BACKDATED = "2020-01-05T00:00:00.000Z";

beforeAll(async () => {
  harper = await startHarper();
  await seedAgent(harper, agent);
}, 120_000);

afterAll(async () => {
  await stopHarper(harper);
});

describe("flair#1336 — POST /Memory createdAt parity with PUT", () => {
  test("POST preserves a caller-supplied createdAt; validFrom follows it; updatedAt is the write moment", async () => {
    const id = `parity-post-backdated-${randomUUID().slice(0, 8)}`;
    const before = Date.now();
    const res = await authFetch(harper, agent, "POST", "/Memory/", {
      id, agentId: agent.id, content: `historical import ${id}`,
      type: "session", durability: "standard", createdAt: BACKDATED,
    });
    expect(res.status).toBe(201);

    const row = await getRecord(harper, agent, id);
    expect(row.createdAt).toBe(BACKDATED);          // RED on pre-#1336 main: re-stamped to now
    expect(row.validFrom).toBe(BACKDATED);          // temporal validity keys off createdAt
    expect(Date.parse(row.updatedAt)).toBeGreaterThanOrEqual(before); // write moment, never backdated
  });

  test("POST without createdAt still stamps server-now (default unchanged)", async () => {
    const id = `parity-post-default-${randomUUID().slice(0, 8)}`;
    const before = Date.now();
    const res = await authFetch(harper, agent, "POST", "/Memory/", {
      id, agentId: agent.id, content: `fresh write ${id}`,
      type: "session", durability: "standard",
    });
    expect(res.status).toBe(201);

    const row = await getRecord(harper, agent, id);
    expect(Date.parse(row.createdAt)).toBeGreaterThanOrEqual(before);
    expect(row.createdAt).toBe(row.updatedAt);
  });

  test("ephemeral expiresAt stays anchored to the write moment, not a caller createdAt", async () => {
    // The #1257 containment bound: expiresAt = write-time + TTL. If it keyed
    // off createdAt, a FORWARD-dated createdAt would stretch the exposure
    // window; a backdated one would pre-expire the row. Neither may happen.
    const id = `parity-post-ephemeral-${randomUUID().slice(0, 8)}`;
    const before = Date.now();
    const res = await authFetch(harper, agent, "POST", "/Memory/", {
      id, agentId: agent.id, content: `ephemeral historical ${id}`,
      type: "session", durability: "ephemeral", createdAt: BACKDATED,
    });
    expect(res.status).toBe(201);

    const row = await getRecord(harper, agent, id);
    expect(row.createdAt).toBe(BACKDATED);
    const ttlHours = Number(process.env.FLAIR_EPHEMERAL_TTL_HOURS || 24);
    const expires = Date.parse(row.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + ttlHours * 3600_000 - 60_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + ttlHours * 3600_000 + 60_000);
  });

  test("PUT create with the same backdated createdAt behaves identically (the parity frame)", async () => {
    const id = `parity-put-backdated-${randomUUID().slice(0, 8)}`;
    const res = await authFetch(harper, agent, "PUT", `/Memory/${id}`, {
      id, agentId: agent.id, content: `historical import via put ${id}`,
      type: "session", durability: "standard", createdAt: BACKDATED,
    });
    expect(res.status).toBe(200);

    const row = await getRecord(harper, agent, id);
    expect(row.createdAt).toBe(BACKDATED);
  });
});
