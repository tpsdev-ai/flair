// Ed25519 → HNSW auth-path integration test (flair#457).
//
// Regression guard for #456: Harper 5.0.9+ resolves request.user from the
// Authorization header BEFORE custom middleware runs, so the old
// "swap header to Basic admin" trick was silently ignored and EVERY
// Ed25519-authenticated request 401'd with "Login failed" — including the
// HNSW (q-based) semantic search path the swap existed to grant permissions
// for. CI stayed green because no test exercised an Ed25519-authenticated
// q-search; the existing agent-journey test deliberately uses the keyword-only
// fallback to avoid the embedding engine.
//
// This test closes that gap: it authenticates via Ed25519 and runs a real
// q-based SemanticSearch, asserting the request is AUTHENTICATED (status 200,
// not 401 "Login failed"). It also pins the auth invariants: a tampered
// signature and a missing header must both 401.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function ed25519Header(agent: TestAgent, method: string, path: string, opts: { tamper?: boolean } = {}): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  let sigB64 = Buffer.from(sig).toString("base64");
  if (opts.tamper) sigB64 = sigB64.slice(0, -4) + (sigB64.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${sigB64}`;
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
const agent = mkAgent("ed25519-hnsw");
const SUBJECT = "ed25519-hnsw-test";

describe("Ed25519 → HNSW auth path (flair#457 / regression guard for #456)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    const res = await adminOp(harper, {
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
    });
    expect(res.status).toBe(200);
    // Seed a few memories so a q-search has candidates.
    for (let i = 0; i < 5; i++) {
      const id = `${agent.id}-${i}`;
      const path = `/Memory/${id}`;
      const r = await fetch(`${harper.httpURL}${path}`, {
        method: "PUT",
        headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
        body: JSON.stringify({ id, agentId: agent.id, content: `note ${i}: working on retrieval and vector search`, subject: SUBJECT, durability: "standard" }),
      });
      if (![200, 204].includes(r.status)) throw new Error(`seed PUT ${id} → ${r.status}: ${await r.text()}`);
    }
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("AUTH INVARIANT: no Authorization header → 403 (path is actually guarded, not authorizeLocal-bypassed)", async () => {
    const res = await fetch(`${harper.httpURL}/Memory/?agentId=${agent.id}`);
    // If this returns 200, the harness is authorizeLocal-bypassing and the
    // Ed25519 assertions below would be theater — fail loudly so we notice.
    // Post-fix: Memory's allowRead()=allowVerified denies anonymous reads
    // at Harper's allow-gate with 403 (was search()'s 401 before the read-gate
    // fix, which only covered the query path). The invariant — anonymous is
    // DENIED, not bypassed — is unchanged; only the denial code moved 401→403,
    // matching the /Agent convention.
    expect(res.status).toBe(403);
  }, 30_000);

  test("AUTH INVARIANT: tampered signature → 401 invalid_signature", async () => {
    // The server signs/verifies over url.pathname + url.search, so the signed
    // path must include the query string.
    const path = `/Memory/?agentId=${agent.id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: ed25519Header(agent, "GET", path, { tamper: true }) },
    });
    expect(res.status).toBe(401);
    const body: any = await res.json().catch(() => ({}));
    expect(body.error).toBe("invalid_signature");
  }, 30_000);

  test("#456 GUARD: Ed25519-authenticated q-based SemanticSearch is authenticated (200, not 'Login failed')", async () => {
    const path = "/SemanticSearch";
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, q: "vector search retrieval", limit: 5 }),
    });
    // The #456 break was 401 {"error":"Login failed"} on exactly this path.
    // A 200 proves Ed25519 verification granted the permissions HNSW needs.
    // (Result count depends on the embedding engine being available; the auth
    // outcome is what this guards.)
    const text = await res.text();
    expect(res.status, `q-search returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
    expect(text).not.toContain("Login failed");
    const body: any = JSON.parse(text);
    expect(Array.isArray(body.results)).toBe(true);
  }, 60_000);

  test("#456 GUARD: Ed25519-authenticated GET /Memory is authenticated (200)", async () => {
    // Signed path must match what the server verifies: url.pathname + url.search.
    const path = `/Memory/?agentId=${agent.id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: ed25519Header(agent, "GET", path) },
    });
    const text = await res.text();
    expect(res.status, `GET /Memory returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
    expect(text).not.toContain("Login failed");
  }, 30_000);
});
