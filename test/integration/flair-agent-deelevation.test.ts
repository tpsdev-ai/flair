// flair_agent de-elevation integration test (auth-rbac reshape).
//
// Proves the security-critical claim of the reshape: a verified Ed25519 agent
// resolved to the least-privilege `flair-agent` user (instead of admin
// super_user) can STILL do everything a real agent needs — HNSW semantic
// search, Memory read/write — i.e. the flair_agent role grants are sufficient.
// If any of these regress to 401/403, the grant spec needs widening, and THIS
// test is where we find out against a real Harper, not in production.
//
// Unlike ed25519-auth-hnsw.test.ts (which leaves flair-agent unprovisioned, so
// the gate falls back to admin), this test provisions the role + user via the
// real ensureFlairAgentRole/ensureFlairAgentUser, so the gate resolves agents to
// flair-agent and these assertions exercise the de-elevated path.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";

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

async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(op),
  });
}

let harper: HarperInstance;
const agent = mkAgent("deelev-agent");
const other = mkAgent("deelev-other");

describe("flair_agent de-elevation (verified agents act as flair-agent, not admin)", () => {
  beforeAll(async () => {
    harper = await startHarper();

    // Provision the least-privilege role + shared user via the REAL functions,
    // so the gate resolves verified agents to flair-agent.
    await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
    await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);

    for (const a of [agent, other]) {
      const res = await adminOp(harper, {
        operation: "insert", database: "flair", table: "Agent",
        records: [{ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: new Date().toISOString() }],
      });
      expect(res.status).toBe(200);
    }

    // Seed memories for `agent` so HNSW has candidates.
    for (let i = 0; i < 5; i++) {
      const id = `${agent.id}-${i}`;
      const path = `/Memory/${id}`;
      const r = await fetch(`${harper.httpURL}${path}`, {
        method: "PUT",
        headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
        body: JSON.stringify({ id, agentId: agent.id, content: `note ${i}: retrieval and vector search`, durability: "standard" }),
      });
      if (![200, 204].includes(r.status)) throw new Error(`seed PUT ${id} → ${r.status}: ${await r.text()}`);
    }
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  // SemanticSearch now self-authorizes via allowCreate→verifyAgentRequest, so a
  // de-elevated flair_agent can run HNSW search (the role's Memory.read grant
  // covers the internal vector reads). Regression guard for the custom-resource
  // coupling the de-elevation surfaced.
  test("SUFFICIENCY: agent HNSW q-search works under flair_agent (SemanticSearch.allowCreate)", async () => {
    const path = "/SemanticSearch";
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, q: "vector search retrieval", limit: 5 }),
    });
    const text = await res.text();
    expect(res.status, `q-search returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
    const body: any = JSON.parse(text);
    expect(Array.isArray(body.results)).toBe(true);
  }, 60_000);

  test("SUFFICIENCY: agent GET /Memory works under flair_agent (200)", async () => {
    const path = `/Memory/?agentId=${agent.id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: ed25519Header(agent, "GET", path) },
    });
    const text = await res.text();
    expect(res.status, `GET /Memory returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  }, 30_000);

  test("SUFFICIENCY: agent PUT own Memory works under flair_agent (insert/update grant)", async () => {
    const id = `${agent.id}-put-check`;
    const path = `/Memory/${id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PUT",
      headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
      body: JSON.stringify({ id, agentId: agent.id, content: "own write under flair_agent", durability: "standard" }),
    });
    expect([200, 204], `PUT own Memory returned ${res.status}: ${(await res.text()).slice(0, 200)}`).toContain(res.status);
  }, 30_000);

  test("DE-ELEVATION: agent POST /sql is forbidden (flair_agent has no operations grant)", async () => {
    const path = "/sql";
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "sql", sql: "SELECT * FROM flair.Memory LIMIT 1" }),
    });
    // Agents are no longer admin → raw query endpoints denied (gate 403 + native).
    expect([401, 403], `/sql returned ${res.status} (expected denied)`).toContain(res.status);
  }, 30_000);

  test("ISOLATION: agent cannot modify another agent's EXISTING Memory (ownership enforced)", async () => {
    // `other` creates a memory it owns...
    const id = `${other.id}-owned`;
    const path = `/Memory/${id}`;
    const create = await fetch(`${harper.httpURL}${path}`, {
      method: "PUT",
      headers: { Authorization: ed25519Header(other, "PUT", path), "Content-Type": "application/json" },
      body: JSON.stringify({ id, agentId: other.id, content: "owned by other", durability: "standard" }),
    });
    expect([200, 204], `other's own create returned ${create.status}`).toContain(create.status);

    // ...and `agent` must not be able to overwrite it (existing-record ownership).
    const attack = await fetch(`${harper.httpURL}${path}`, {
      method: "PUT",
      headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
      body: JSON.stringify({ id, agentId: other.id, content: "hijacked by agent", durability: "standard" }),
    });
    expect(attack.status, `cross-agent overwrite returned ${attack.status} (expected 403)`).toBe(403);
  }, 30_000);

  // PENDING per-resource migration: creating a NEW Memory tagged with another
  // agent's agentId is NOT blocked today (the gate only guards existing-record
  // ownership). Memory.allowCreate must enforce body.agentId === verified agent.
  test.todo("ISOLATION: agent cannot CREATE a Memory tagged as another agent (needs Memory.allowCreate)");
});
