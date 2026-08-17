// flair#1238 — server-side durability enum validation, behavioural positive control.
//
// The unit lane (test/unit/durability-write-validation.test.ts) validates
// assertValidDurability in isolation and trips if the guard is unwired. This file
// is the behavioural proof: a PRESENT-but-unknown durability via the real REST
// surface must be REFUSED with 400, while all four valid values and an absent
// durability keep working exactly as before.
//
// This is the "prove it fires" control — pre-fix, an unknown durability was
// silently accepted (200) and landed on the narrower private branch by accident.
// Post-fix it is refused at the schema boundary.
//
// Pattern: test/integration/memory-visibility-scoping-e2e.test.ts (Ed25519
// signing helpers, admin-op seeding).
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

let harper: HarperInstance;
const agent = mkAgent("dur-owner");

beforeAll(async () => {
  harper = await startHarper();
  await seedAgent(harper, agent);
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
});

describe("durability enum validation — write-side rejection (flair#1238)", () => {
  test("positive control: a present-but-unknown durability is refused with 400", async () => {
    const res = await authFetch(harper, agent, "POST", "/Memory", {
      id: `dur-unknown-${randomUUID()}`,
      agentId: agent.id,
      content: "unknown durability",
      durability: "forever",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_durability");
    expect(body.message).toContain("forever");
    expect(body.message).toContain("permanent");
    expect(body.message).toContain("persistent");
    expect(body.message).toContain("standard");
    expect(body.message).toContain("ephemeral");
  }, 30_000);

  test("all four valid values are accepted unchanged", async () => {
    for (const durability of ["permanent", "persistent", "standard", "ephemeral"]) {
      const res = await authFetch(harper, agent, "POST", "/Memory", {
        id: `dur-valid-${durability}-${randomUUID()}`,
        agentId: agent.id,
        content: `a ${durability} decision, long enough for the safety scan`,
        durability,
      });
      expect(res.status, `durability=${durability} → ${res.status}`).toBe(201);
    }
  }, 60_000);

  test("absent durability is accepted and defaulted to \"standard\"", async () => {
    const id = `dur-absent-${randomUUID()}`;
    const res = await authFetch(harper, agent, "POST", "/Memory", {
      id,
      agentId: agent.id,
      content: "no durability field, long enough for the safety scan",
    });
    expect(res.status).toBe(201);

    // Confirm the default was stamped server-side.
    const read = await adminOp(harper, {
      operation: "search_by_value", database: "flair", table: "Memory",
      search_attribute: "id", search_value: id, get_attributes: ["id", "durability"],
    });
    expect(read.status).toBe(200);
    const rows = await read.json();
    const record = Array.isArray(rows) ? rows[0] : rows;
    expect(record?.durability).toBe("standard");
  }, 30_000);

  test("PUT is also guarded — unknown durability via the update path is refused", async () => {
    const id = `dur-put-${randomUUID()}`;
    const res = await authFetch(harper, agent, "PUT", `/Memory/${id}`, {
      id,
      agentId: agent.id,
      content: "put with unknown durability",
      durability: "forever",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_durability");
  }, 30_000);
});
