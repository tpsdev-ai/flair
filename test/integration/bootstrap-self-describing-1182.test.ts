// flair#1182 (part 1) — the bootstrap empty-state must be SELF-DESCRIBING.
//
// A first connector session against a flair instance had to reverse-engineer
// the usage model across ~eight probing calls, because an empty instance's
// bootstrap looked like a near-bare success (no way to tell "empty" from
// "this server doesn't do this"). Part 1 fixes that on resources/
// MemoryBootstrap.ts's response:
//
//   1. The structured container keys `soul` ({}), `memories` ([]) and
//      `predicted` ([]) are ALWAYS present — even when empty — so a caller can
//      distinguish an empty instance from one that doesn't support them.
//   2. The resolved `agentId` and a `scope` descriptor are always present, so a
//      caller can tell who the server thinks they are (would have made the
//      #1181 read-gate bug a one-call diagnosis). These reflect the CALLER'S
//      OWN resolved identity/scope ONLY — never another agent's.
//   3. When `currentTask` (which is what turns on task-relevant retrieval) is
//      absent/blank, a `currentTaskHint` says so.
//
// Pattern: the ed25519-signed HTTP path used by every other bootstrap
// integration test (test/integration/bootstrap-supersede-resurface.test.ts).
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

async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}

async function registerAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `Agent insert for ${agent.id} returned ${res.status}`).toBe(200);
}

/** Signed PUT to /Memory/<id> — the only HTTP-reachable create/update path. */
async function putMemory(harper: HarperInstance, agent: TestAgent, id: string, body: Record<string, any>): Promise<Response> {
  const path = `/Memory/${id}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...body }),
  });
}

async function seedSoul(harper: HarperInstance, agent: TestAgent, key: string, value: string): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Soul",
    records: [{ id: `${agent.id}:${key}`, agentId: agent.id, key, value, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `Soul insert ${agent.id}:${key} → ${res.status}`).toBe(200);
}

/** Raw bootstrap POST — returns { status, body } so a test can assert on either. */
async function bootstrapRaw(harper: HarperInstance, signer: TestAgent, body: Record<string, any>): Promise<{ status: number; body: any }> {
  const path = "/BootstrapMemories";
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(signer, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = undefined;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function bootstrap(harper: HarperInstance, agent: TestAgent, body: Record<string, any>): Promise<any> {
  const { status, body: parsed } = await bootstrapRaw(harper, agent, body);
  expect(status, `BootstrapMemories → ${status}: ${JSON.stringify(parsed).slice(0, 300)}`).toBe(200);
  return parsed;
}

let harper: HarperInstance;

describe("flair#1182 part 1 — self-describing bootstrap empty-state (+ resolved identity/scope)", () => {
  beforeAll(async () => {
    harper = await startHarper();
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("empty-state: an authenticated caller with NO data still gets the container keys + resolved identity + task hint", async () => {
    const agent = mkAgent(`bootstrap-1182-empty-${randomUUID()}`);
    await registerAgent(harper, agent);

    const body = await bootstrap(harper, agent, { agentId: agent.id, maxTokens: 4000 });

    // --- container keys present even when empty (empty ≠ unsupported) ---
    expect(Object.prototype.hasOwnProperty.call(body, "soul"), "response must always carry `soul`").toBe(true);
    expect(Object.prototype.hasOwnProperty.call(body, "memories"), "response must always carry `memories`").toBe(true);
    expect(Object.prototype.hasOwnProperty.call(body, "predicted"), "response must always carry `predicted`").toBe(true);
    // and they are the right EMPTY shapes
    expect(body.soul).toEqual({});
    expect(Array.isArray(body.memories)).toBe(true);
    expect(body.memories).toEqual([]);
    expect(Array.isArray(body.predicted)).toBe(true);
    expect(body.predicted).toEqual([]);

    // --- resolved identity + scope reflect the CALLER ---
    expect(body.agentId, "resolved agentId must be the caller's").toBe(agent.id);
    expect(body.scope?.agentId, "scope.agentId must be the caller's").toBe(agent.id);
    expect(body.scope?.isAdmin, "a non-admin caller must resolve as non-admin").toBe(false);
    expect(typeof body.scope?.reads, "scope must describe the read model").toBe("string");

    // --- currentTask hint present when currentTask is absent ---
    expect(typeof body.currentTaskHint, "currentTaskHint present when no currentTask").toBe("string");
    expect(body.currentTaskHint.toLowerCase()).toContain("currenttask");

    // --- no regression: the pre-existing keys are still there ---
    expect(Object.prototype.hasOwnProperty.call(body, "context")).toBe(true);
    expect(body.sections, "sections counts still present").toBeDefined();
    expect(body.memoriesAvailable).toBe(0);
  }, 60_000);

  test("populated: WITH data, the containers carry the caller's OWN records and the pre-existing shape is unchanged", async () => {
    const agent = mkAgent(`bootstrap-1182-full-${randomUUID()}`);
    await registerAgent(harper, agent);
    await seedSoul(harper, agent, "role", "Self-describing bootstrap test subject");

    const PERM = "self-describe marker: never delete the production backup before an explicit go.";
    const RECENT = "self-describe marker: the CP-7 spec landed and Anvil opened the PR this morning.";
    const putPerm = await putMemory(harper, agent, `${agent.id}-perm`, { agentId: agent.id, content: PERM, durability: "permanent" });
    expect(putPerm.status, `seed permanent → ${putPerm.status}: ${await putPerm.text()}`).toBe(200);
    const putRecent = await putMemory(harper, agent, `${agent.id}-recent`, { agentId: agent.id, content: RECENT, durability: "standard" });
    expect(putRecent.status, `seed recent → ${putRecent.status}: ${await putRecent.text()}`).toBe(200);

    // No currentTask on purpose — the permanent/recent/soul containers do not
    // depend on the embedding path, so this test is deterministic without a model.
    const body = await bootstrap(harper, agent, { agentId: agent.id, maxTokens: 8000 });

    // --- no regression: the human-readable context still carries the memories ---
    const context: string = body.context ?? "";
    expect(context, "permanent memory missing from context").toContain(PERM);
    expect(context, "recent memory missing from context").toContain(RECENT);
    expect(body.sections.permanent, "sections.permanent count unchanged").toBeGreaterThanOrEqual(1);
    expect(body.sections.recent, "sections.recent count unchanged").toBeGreaterThanOrEqual(1);

    // --- the `soul` container carries the seeded identity as structured data ---
    expect(body.soul).toBeDefined();
    expect(body.soul.role).toBe("Self-describing bootstrap test subject");

    // --- the `memories` container carries the caller's OWN included records ---
    expect(Array.isArray(body.memories)).toBe(true);
    expect(body.memories.length, "memories container should be populated").toBeGreaterThanOrEqual(2);
    const contents = body.memories.map((m: any) => m.content);
    expect(contents).toContain(PERM);
    expect(contents).toContain(RECENT);
    for (const m of body.memories) {
      expect(m.id, "each memory carries an id").toBeTruthy();
      expect(m.agentId, "every returned memory is the caller's OWN").toBe(agent.id);
      expect(typeof m.section, "each memory is tagged with its section").toBe("string");
    }

    // --- predicted container is still the right type (present, array) ---
    expect(Array.isArray(body.predicted)).toBe(true);

    // --- identity/scope fields present on the populated response too ---
    expect(body.agentId).toBe(agent.id);
    expect(body.scope?.agentId).toBe(agent.id);
    expect(body.scope?.isAdmin).toBe(false);

    // --- currentTask was omitted, so the hint is present here too ---
    expect(typeof body.currentTaskHint).toBe("string");
  }, 60_000);

  test("caller-only identity: the resolved agentId/scope + memories are the CALLER's, never another agent's", async () => {
    const alice = mkAgent(`bootstrap-1182-alice-${randomUUID()}`);
    const bob = mkAgent(`bootstrap-1182-bob-${randomUUID()}`);
    await registerAgent(harper, alice);
    await registerAgent(harper, bob);

    // Bob has a PRIVATE memory Alice must never see.
    const BOB_SECRET = "self-describe marker: bob's private note that alice must never read.";
    const putBob = await putMemory(harper, bob, `${bob.id}-secret`, { agentId: bob.id, content: BOB_SECRET, durability: "standard", visibility: "private" });
    expect(putBob.status, `bob seed → ${putBob.status}: ${await putBob.text()}`).toBe(200);

    // Alice has her own memory.
    const ALICE_OWN = "self-describe marker: alice's own working note.";
    const putAlice = await putMemory(harper, alice, `${alice.id}-own`, { agentId: alice.id, content: ALICE_OWN, durability: "standard" });
    expect(putAlice.status, `alice seed → ${putAlice.status}: ${await putAlice.text()}`).toBe(200);

    // Alice bootstraps as herself.
    const body = await bootstrap(harper, alice, { agentId: alice.id, maxTokens: 8000 });
    expect(body.agentId, "resolved agentId must be Alice, the caller").toBe(alice.id);
    expect(body.scope?.agentId, "scope.agentId must be Alice, the caller").toBe(alice.id);
    // No leak of Bob's identity or data through the containers Alice gets back.
    for (const m of body.memories) {
      expect(m.agentId, "Alice's `memories` must contain only Alice's own records").toBe(alice.id);
    }
    expect(JSON.stringify(body.memories), "Bob's private content must not appear in Alice's memories").not.toContain(BOB_SECRET);
    expect(body.context ?? "", "Bob's private content must not appear in Alice's context").not.toContain(BOB_SECRET);

    // Alice CANNOT obtain Bob's resolved identity/scope by asking for it: a
    // non-admin signing as Alice but passing Bob's agentId is rejected (403),
    // so the resolved identity/scope can never be another agent's.
    const impersonation = await bootstrapRaw(harper, alice, { agentId: bob.id, maxTokens: 8000 });
    expect(impersonation.status, "a non-admin must not bootstrap another agent's id").toBe(403);
  }, 60_000);
});
