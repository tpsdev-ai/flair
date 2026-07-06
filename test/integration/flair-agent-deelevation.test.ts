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
const adminAgent = mkAgent("deelev-admin");

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
    // Admin agent (role:"admin" → isAdmin via the Agent-table source) for the
    // admin-only resource assertions.
    const adminRes = await adminOp(harper, {
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: adminAgent.id, name: adminAgent.id, role: "admin", publicKey: adminAgent.publicKey, createdAt: new Date().toISOString() }],
    });
    expect(adminRes.status).toBe(200);

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

  test("SUFFICIENCY: agent POST /BootstrapMemories works under flair_agent (custom-resource allowCreate)", async () => {
    const path = "/BootstrapMemories";
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, maxTokens: 2000 }),
    });
    const text = await res.text();
    expect(res.status, `bootstrap returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  }, 60_000);

  test("SUFFICIENCY: agent POST /FeedMemories works under flair_agent (custom-resource write path)", async () => {
    const path = "/FeedMemories";
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, content: "fed via MemoryFeed under flair_agent" }),
    });
    const text = await res.text();
    expect([200, 201, 204], `MemoryFeed returned ${res.status}: ${text.slice(0, 300)}`).toContain(res.status);
  }, 30_000);

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

  test("SUFFICIENCY: agent GET /WorkspaceLatest authorized under flair_agent (allowRead, not 403)", async () => {
    const path = `/WorkspaceLatest/${agent.id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: ed25519Header(agent, "GET", path) },
    });
    // allowRead fixes the AccessViolation 403 the custom resource would otherwise
    // throw under flair_agent. 200/404 (data or none) both mean auth passed.
    expect([401, 403], `WorkspaceLatest returned ${res.status}`).not.toContain(res.status);
  }, 30_000);

  test("SUFFICIENCY: agent GET /OrgEventCatchup authorized under flair_agent (allowRead, not 403)", async () => {
    const path = `/OrgEventCatchup/${agent.id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: ed25519Header(agent, "GET", path) },
    });
    expect([401, 403], `OrgEventCatchup returned ${res.status}`).not.toContain(res.status);
  }, 30_000);

  test("PUBLIC: GET /AgentCard needs no auth (allowRead=true; survives gate removal)", async () => {
    const res = await fetch(`${harper.httpURL}/AgentCard/${agent.id}`);
    expect([401, 403], `AgentCard (no auth) returned ${res.status}`).not.toContain(res.status);
  }, 30_000);

  test("ADMIN-ONLY: non-admin agent POST /MemoryReindex is denied (allowCreate → isAdmin)", async () => {
    const path = "/MemoryReindex";
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status, `non-admin /MemoryReindex returned ${res.status} (expected 403)`).toBe(403);
  }, 30_000);

  test("ADMIN-ONLY: admin agent POST /MemoryReindex is authorized (allowCreate permits admins)", async () => {
    const path = "/MemoryReindex";
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(adminAgent, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    expect([401, 403], `admin /MemoryReindex returned ${res.status} (expected authorized)`).not.toContain(res.status);
  }, 30_000);

  // Admin* custom (non-@table) Resources previously had NO
  // resource-level read gate at all — reachability depended entirely on the
  // auth-middleware's /Admin* pathname check, which only 401s when there's NO
  // Authorization header. A validly-verified NON-admin agent (real TPS-Ed25519
  // signature, just not an admin) sailed straight through to full dashboard
  // data with zero admin check. allowRead()=allowAdmin closes that gap —
  // same pattern MemoryReindex already uses for allowCreate above.
  test("ADMIN-ONLY: non-admin agent GET /AdminDashboard is denied (allowRead → isAdmin)", async () => {
    const path = "/AdminDashboard";
    const res = await fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: ed25519Header(agent, "GET", path) },
    });
    expect(res.status, `non-admin /AdminDashboard returned ${res.status} (expected 403)`).toBe(403);
  }, 30_000);

  test("ADMIN-ONLY: admin agent GET /AdminDashboard is authorized (allowRead permits admins)", async () => {
    const path = "/AdminDashboard";
    const res = await fetch(`${harper.httpURL}${path}`, {
      headers: { Authorization: ed25519Header(adminAgent, "GET", path) },
    });
    expect([401, 403], `admin /AdminDashboard returned ${res.status} (expected authorized)`).not.toContain(res.status);
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

  test("ISOLATION: agent cannot write another agent's WorkspaceState (body-scoping regression guard)", async () => {
    const id = `${other.id}-ws-spoof`;
    const path = `/WorkspaceState/${id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PUT",
      headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
      body: JSON.stringify({ id, agentId: other.id, state: "spoof" }),
    });
    expect(res.status, `WS spoof returned ${res.status} (expected 403)`).toBe(403);
  }, 30_000);

  // Now enforced natively in Memory.allowCreate via context.user.username (the
  // per-agent identity the gate stamps). Proves the no-core-change approach: a
  // per-agent request.user surfaces as context.user.username inside a Table allow*.
  test("ISOLATION: agent cannot CREATE a Memory tagged as another agent (native allow* ownership)", async () => {
    const id = `${other.id}-spoof-${Date.now()}`;
    const path = `/Memory/${id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PUT",
      headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
      body: JSON.stringify({ id, agentId: other.id, content: "spoofed ownership attempt", durability: "standard" }),
    });
    expect(res.status, `spoofed create returned ${res.status} (expected 403)`).toBe(403);
  }, 30_000);

  test("ANONYMOUS: no-auth GET /Memory is denied (anonymous HTTP rejected)", async () => {
    const res = await fetch(`${harper.httpURL}/Memory/?agentId=${agent.id}`);
    expect([401, 403], `anon GET /Memory returned ${res.status} (expected 401/403)`).toContain(res.status);
  }, 30_000);

  test("ANONYMOUS: no-auth POST /SemanticSearch is denied (anonymous HTTP rejected)", async () => {
    const res = await fetch(`${harper.httpURL}/SemanticSearch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, q: "anything", limit: 1 }),
    });
    expect([401, 403], `anon POST /SemanticSearch returned ${res.status} (expected 401/403)`).toContain(res.status);
  }, 30_000);

  test("ANONYMOUS: no-auth PUT /Memory is denied (anonymous write rejected)", async () => {
    const id = `anon-write-${Date.now()}`;
    const res = await fetch(`${harper.httpURL}/Memory/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, agentId: agent.id, content: "anon write attempt", durability: "standard" }),
    });
    expect([401, 403], `anon PUT /Memory returned ${res.status} (expected 401/403)`).toContain(res.status);
  }, 30_000);

  // Belt-and-suspenders: the non-rejecting gate returns BEFORE its per-resource
  // mutation guards (those only run for verified agents), so EVERY agent-facing
  // @table write path must self-enforce anonymous denial in its own handler/allow*.
  // One anonymous PUT per agent-writable resource; any 200/204 is an auth leak.
  // EVERY @export @table must reject anonymous writes. Harper's role gate denies
  // admin/system tables for a no-user request (→ 403, passes); a 200/204 is a real
  // leak in a table that relied on the (now non-rejecting) global gate. MemoryCandidate
  // is intentionally NOT @export (not REST-routable) so it's excluded.
  const AGENT_WRITE_RESOURCES: Array<{ name: string; body: (id: string) => any }> = [
    // agent-facing (agent-owned data)
    { name: "Soul",            body: (id) => ({ id, agentId: agent.id, content: "anon soul" }) },
    { name: "WorkspaceState",  body: (id) => ({ id, agentId: agent.id, state: { x: 1 } }) },
    { name: "Relationship",    body: (id) => ({ id, agentId: agent.id, otherId: "x", kind: "knows" }) },
    { name: "Integration",     body: (id) => ({ id, agentId: agent.id, kind: "test" }) },
    { name: "Presence",        body: (id) => ({ id, agentId: agent.id, status: "online" }) },
    { name: "Credential",      body: (id) => ({ id, agentId: agent.id, name: "k", value: "v" }) },
    { name: "MemoryGrant",     body: (id) => ({ id, ownerId: agent.id, granteeId: "x", scope: "read" }) },
    { name: "OrgEvent",        body: (id) => ({ id, authorId: agent.id, kind: "note", body: "anon" }) },
    { name: "Agent",           body: (id) => ({ id, displayName: "anon", role: "agent" }) },
    // observatory read-models (public read; writes are system-driven → must deny anon)
    { name: "ObsOffice",        body: (id) => ({ id, data: "anon" }) },
    { name: "ObsAgentSnapshot", body: (id) => ({ id, agentId: agent.id, data: "anon" }) },
    { name: "ObsEventFeed",     body: (id) => ({ id, data: "anon" }) },
    // admin / system / federation tables (no agent grant → must deny anon)
    { name: "Instance",        body: (id) => ({ id, name: "anon" }) },
    { name: "Peer",            body: (id) => ({ id, url: "http://x" }) },
    { name: "PairingToken",    body: (id) => ({ id, token: "anon" }) },
    { name: "OAuthClient",     body: (id) => ({ id, clientId: "anon" }) },
    { name: "IdpConfig",       body: (id) => ({ id, issuer: "anon" }) },
  ];
  for (const r of AGENT_WRITE_RESOURCES) {
    test(`ANONYMOUS: no-auth PUT /${r.name} is denied (anonymous write rejected)`, async () => {
      const id = `anon-${r.name}-${Date.now()}`;
      const res = await fetch(`${harper.httpURL}/${r.name}/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(r.body(id)),
      });
      expect([401, 403], `anon PUT /${r.name} returned ${res.status} (expected 401/403)`).toContain(res.status);
    }, 30_000);
  }
});
