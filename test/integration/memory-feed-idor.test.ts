// MemoryFeed IDOR integration test (authz slice 4, flair#1064).
//
// Guards against the defect where FeedMemories.post() trusted content.agentId
// and content.id from the request body, allowing a principal to write memories
// attributed to (or targeting) another agent.
//
// Mutation-verify: revert MemoryFeed.ts post() to the body-trusting version,
// run this file — the GUARD tests MUST fail. Restore the fix — they MUST pass.
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
const agentA = mkAgent("feed-agent-a");
const agentB = mkAgent("feed-agent-b");

describe("MemoryFeed IDOR guard (authz slice 4)", () => {
  beforeAll(async () => {
    harper = await startHarper();

    await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
    await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);

    // Register both agents so resolveAgentAuth recognizes them.
    for (const ag of [agentA, agentB]) {
      const res = await adminOp(harper, {
        operation: "insert", database: "flair", table: "Agent",
        records: [{ id: ag.id, name: ag.id, role: "agent", publicKey: ag.publicKey, createdAt: new Date().toISOString() }],
      });
      expect(res.status, `register ${ag.id} → ${res.status}`).toBe(200);
    }
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  }, 30_000);

  // ─── Guard: body agentId is overridden to the authenticated principal ───

  test("GUARD: agent A cannot feed a memory for agent B via body agentId", async () => {
    const path = "/FeedMemories";
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(agentA, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agentB.id, content: "imposter memory" }),
    });
    // stamp-default silently overwrites: the write succeeds, attributed to agentA.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agentId).toBe(agentA.id, "body-supplied agentId must be overridden to the authenticated principal");
    expect(body.agentId).not.toBe(agentB.id);
  }, 30_000);

  // ─── Guard: cannot target another agent's record via body id ────────────

  test("GUARD: agent A cannot feed into agent B's record id", async () => {
    // First, agent B creates a memory with a known id.
    const bId = `${agentB.id}-idortarget`;
    const path = "/FeedMemories";
    const createRes = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(agentB, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ id: bId, agentId: agentB.id, content: "agent b's memory" }),
    });
    expect(createRes.status, `B's creation returned ${await createRes.text()}`).toBe(200);

    // Now agent A tries to feed a memory with agentB's id.
    const spoofRes = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(agentA, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ id: bId, agentId: agentA.id, content: "trying to overwrite b" }),
    });
    const spoofText = await spoofRes.text();

    // The fix rejects this: existing record's agentId (agentB) ≠ stamped agentId (agentA).
    expect(spoofRes.status, `A's spoof returned ${spoofRes.status}: ${spoofText}`).toBe(403);
  }, 30_000);

  // ─── Positive control: agent writing its own feed memory still works ────

  test("POSITIVE CONTROL: agent can feed its own memory", async () => {
    const path = "/FeedMemories";
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(agentA, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agentA.id, content: "my own feed memory" }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.agentId).toBe(agentA.id);
    expect(body.content).toBe("my own feed memory");
  }, 30_000);

  // ─── Positive control: agent can reference its own record id ────────────

  test("POSITIVE CONTROL: agent can feed into its own record id", async () => {
    const aId = `${agentA.id}-idorsafe`;
    const path = "/FeedMemories";

    // Agent A creates a memory with a known id.
    const createRes = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(agentA, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ id: aId, agentId: agentA.id, content: "agent a's memory" }),
    });
    expect(createRes.status, `A's creation returned ${await createRes.text()}`).toBe(200);

    // Agent A feeds again with the same id (same content = dedup, returns existing).
    const updateRes = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(agentA, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ id: aId, agentId: agentA.id, content: "agent a's memory" }),
    });
    const updateBody = await updateRes.json();
    expect(updateRes.status).toBe(200);
    expect(updateBody.agentId).toBe(agentA.id);
  }, 30_000);

  // ─── Anonymous rejection ───────────────────────────────────────────────

  test("GUARD: anonymous POST /FeedMemories is rejected", async () => {
    const path = "/FeedMemories";
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agentA.id, content: "unauthenticated" }),
    });
    // allowCreate() (via allowVerified) rejects anonymous at the Harper resource
    // layer before post() is reached, so the observable response is 403 (AccessViolation).
    // The 401 check in post() is defense-in-depth for non-Harper callers.
    expect(res.status, `anonymous returned ${await res.text()}`).toBe(403);
  }, 30_000);
});
