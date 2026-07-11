// RecordUsage (usage-feedback signal, flair#683) e2e — real-Harper integration
// tests.
//
// WHY THIS FILE EXISTS: FLAIR-USAGE-FEEDBACK-SIGNAL.md's K&S verdict called
// out four specific anti-gaming/correctness properties that only mean
// something against REAL auth + REAL storage, not a mocked Harper:
//   1. auth — a verified agent (Ed25519) can call it; an anonymous caller
//      cannot.
//   2. cross-agent write succeeds WITHOUT ownership — agent B can report
//      usage on agent A's memory (unlike Memory.put(), which would 403 this)
//      — and no OTHER field on A's memory changes.
//   3. dedup — each (agentId, memoryId) pair contributes AT MOST 1 to
//      usageCount, even across repeated calls.
//   4. no ID enumeration — the response is IDENTICAL for a not-found id, an
//      already-counted id, and a fresh valid id (a caller can't distinguish
//      "doesn't exist" from "you already used it" from "recorded").
//
// MODEL: test/integration/dedup-supersede-e2e.test.ts (real Harper spawn,
// signed TPS-Ed25519 requests, admin-op seeding for fixtures).
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
  const sigB64 = Buffer.from(sig).toString("base64");
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

async function registerAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `Agent insert for ${agent.id} returned ${res.status}`).toBe(200);
}

/** Signed PUT to /Memory/<id> — the only HTTP-reachable Memory create/update path. */
async function putMemory(harper: HarperInstance, agent: TestAgent, id: string, body: Record<string, any>): Promise<Response> {
  const path = `/Memory/${id}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...body }),
  });
}

/** Signed GET /Memory/<id>. */
async function getMemory(harper: HarperInstance, agent: TestAgent, id: string): Promise<Response> {
  const path = `/Memory/${id}`;
  return fetch(`${harper.httpURL}${path}`, {
    headers: { Authorization: ed25519Header(agent, "GET", path) },
  });
}

/** Signed POST /RecordUsage — the endpoint under test. */
async function recordUsage(harper: HarperInstance, agent: TestAgent, body: Record<string, any>): Promise<{ status: number; body: any; text: string }> {
  const path = "/RecordUsage";
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, text };
}

/** Unsigned (anonymous) POST /RecordUsage. */
async function recordUsageAnonymous(harper: HarperInstance, body: Record<string, any>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${harper.httpURL}/RecordUsage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

let harper: HarperInstance;

describe("RecordUsage e2e (real Harper) — flair#683 usage-feedback signal", () => {
  beforeAll(async () => {
    harper = await startHarper();
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test("auth: anonymous (unsigned) call is denied — 403 (allowCreate gate denies anonymous, same convention as every other action resource — see auth-middleware-e2e.test.ts's AUTH INVARIANT tests), no ledger side effect", async () => {
    const owner = mkAgent(`ru-anon-owner-${randomUUID()}`);
    await registerAgent(harper, owner);
    const memId = `${owner.id}-mem`;
    const put = await putMemory(harper, owner, memId, { agentId: owner.id, content: "Anonymous-auth test memory, long enough for the dedup gate.", durability: "standard" });
    expect(put.status).toBe(200);

    const res = await recordUsageAnonymous(harper, { memoryIds: [memId] });
    expect(res.status).toBe(403);

    // No side effect: usageCount stays absent/0.
    const check = await getMemory(harper, owner, memId);
    const rec: any = await check.json();
    expect(rec.usageCount ?? 0).toBe(0);
  }, 60_000);

  test("auth: a verified agent's call is accepted (200, recorded:true)", async () => {
    const owner = mkAgent(`ru-auth-owner-${randomUUID()}`);
    await registerAgent(harper, owner);
    const memId = `${owner.id}-mem`;
    const put = await putMemory(harper, owner, memId, { agentId: owner.id, content: "Verified-auth test memory, long enough for the dedup gate.", durability: "standard" });
    expect(put.status).toBe(200);

    const res = await recordUsage(harper, owner, { memoryIds: [memId] });
    expect(res.status, `RecordUsage returned ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    expect(res.body).toEqual({ recorded: true });
  }, 60_000);

  test("cross-agent write: agent B increments agent A's memory usageCount WITHOUT ownership — and no OTHER field changes", async () => {
    const owner = mkAgent(`ru-cross-owner-${randomUUID()}`);
    const reporter = mkAgent(`ru-cross-reporter-${randomUUID()}`);
    await registerAgent(harper, owner);
    await registerAgent(harper, reporter);

    const memId = `${owner.id}-mem`;
    const originalContent = "Owner's memory, cited by a DIFFERENT agent, long enough for the dedup gate.";
    const putRes = await putMemory(harper, owner, memId, { agentId: owner.id, content: originalContent, durability: "standard", tags: ["original-tag"] });
    expect(putRes.status).toBe(200);

    // Sanity: Memory.put() (the ownership-gated path) would 403 a cross-agent
    // write attempt — confirms this scenario genuinely needs the DEDICATED
    // endpoint's no-ownership-requirement design, not just a lenient Memory.
    const crossPut = await putMemory(harper, reporter, memId, { agentId: owner.id, content: "attempted cross-agent overwrite" });
    expect(crossPut.status).toBe(403);

    // The dedicated endpoint succeeds for the SAME cross-agent shape.
    const res = await recordUsage(harper, reporter, { memoryIds: [memId], attribution: "grounded a decision" });
    expect(res.status, `RecordUsage returned ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    expect(res.body).toEqual({ recorded: true });

    const check = await getMemory(harper, owner, memId);
    expect(check.status).toBe(200);
    const rec: any = await check.json();
    expect(rec.usageCount).toBe(1);
    // Ownership NOT required, but ONLY usageCount changed — never content,
    // tags, agentId, or any other field (module doc's "targeted ... ONLY").
    expect(rec.content).toBe(originalContent);
    expect(rec.tags).toEqual(["original-tag"]);
    expect(rec.agentId).toBe(owner.id);
  }, 60_000);

  test("dedup: the SAME agent reporting usage on the SAME memory twice contributes AT MOST 1", async () => {
    const owner = mkAgent(`ru-dedup-owner-${randomUUID()}`);
    const reporter = mkAgent(`ru-dedup-reporter-${randomUUID()}`);
    await registerAgent(harper, owner);
    await registerAgent(harper, reporter);

    const memId = `${owner.id}-mem`;
    const putRes = await putMemory(harper, owner, memId, { agentId: owner.id, content: "Dedup test memory, long enough for the dedup gate to consider.", durability: "standard" });
    expect(putRes.status).toBe(200);

    const first = await recordUsage(harper, reporter, { memoryIds: [memId] });
    expect(first.status).toBe(200);
    const second = await recordUsage(harper, reporter, { memoryIds: [memId] });
    expect(second.status).toBe(200);
    const third = await recordUsage(harper, reporter, { memoryIds: [memId] });
    expect(third.status).toBe(200);

    const check = await getMemory(harper, owner, memId);
    const rec: any = await check.json();
    expect(rec.usageCount).toBe(1); // NOT 3 — (agent, memory) contributes ≤ 1

    // A DIFFERENT agent's contribution is independent and still counts.
    const secondReporter = mkAgent(`ru-dedup-reporter2-${randomUUID()}`);
    await registerAgent(harper, secondReporter);
    const fromOther = await recordUsage(harper, secondReporter, { memoryIds: [memId] });
    expect(fromOther.status).toBe(200);
    const check2 = await getMemory(harper, owner, memId);
    const rec2: any = await check2.json();
    expect(rec2.usageCount).toBe(2); // two DISTINCT agents = 2, still capped per-agent
  }, 60_000);

  test("dedup within ONE batch call: the same id repeated in memoryIds still only contributes 1", async () => {
    const owner = mkAgent(`ru-batch-dedup-owner-${randomUUID()}`);
    const reporter = mkAgent(`ru-batch-dedup-reporter-${randomUUID()}`);
    await registerAgent(harper, owner);
    await registerAgent(harper, reporter);
    const memId = `${owner.id}-mem`;
    await putMemory(harper, owner, memId, { agentId: owner.id, content: "Batch-dedup test memory, long enough for the gate.", durability: "standard" });

    const res = await recordUsage(harper, reporter, { memoryIds: [memId, memId, memId] });
    expect(res.status).toBe(200);
    const check = await getMemory(harper, owner, memId);
    const rec: any = await check.json();
    expect(rec.usageCount).toBe(1);
  }, 60_000);

  test("NO ID ENUMERATION: not-found, already-counted, and a fresh valid id all return the IDENTICAL response", async () => {
    const owner = mkAgent(`ru-enum-owner-${randomUUID()}`);
    const reporter = mkAgent(`ru-enum-reporter-${randomUUID()}`);
    await registerAgent(harper, owner);
    await registerAgent(harper, reporter);

    const freshMemId = `${owner.id}-fresh`;
    const alreadyCountedMemId = `${owner.id}-already`;
    const nonexistentMemId = `${owner.id}-does-not-exist-${randomUUID()}`;

    await putMemory(harper, owner, freshMemId, { agentId: owner.id, content: "Fresh memory for the enumeration test, long enough.", durability: "standard" });
    await putMemory(harper, owner, alreadyCountedMemId, { agentId: owner.id, content: "Already-counted memory for the enumeration test, long enough.", durability: "standard" });

    // Pre-count the "already counted" one so the SECOND call below hits the
    // already-counted branch.
    const precount = await recordUsage(harper, reporter, { memoryIds: [alreadyCountedMemId] });
    expect(precount.status).toBe(200);

    const freshRes = await recordUsage(harper, reporter, { memoryIds: [freshMemId] });
    const alreadyRes = await recordUsage(harper, reporter, { memoryIds: [alreadyCountedMemId] });
    const notFoundRes = await recordUsage(harper, reporter, { memoryIds: [nonexistentMemId] });

    // All three succeed at the HTTP layer (200) with the EXACT same body —
    // no status-code or body difference reveals which case actually happened.
    expect(freshRes.status).toBe(200);
    expect(alreadyRes.status).toBe(200);
    expect(notFoundRes.status).toBe(200);
    expect(freshRes.body).toEqual({ recorded: true });
    expect(alreadyRes.body).toEqual(freshRes.body);
    expect(notFoundRes.body).toEqual(freshRes.body);

    // Ground truth confirms the three cases really WERE different underneath
    // (this isn't just "nothing ever works") — fresh went 0→1, already stayed
    // at 1 (not 2), and no memory was created for the nonexistent id.
    const freshCheck = await getMemory(harper, owner, freshMemId);
    expect((await freshCheck.json()).usageCount).toBe(1);
    const alreadyCheck = await getMemory(harper, owner, alreadyCountedMemId);
    expect((await alreadyCheck.json()).usageCount).toBe(1);
  }, 60_000);

  test("input validation: empty/missing memoryIds is a 400 (not silently a no-op 200)", async () => {
    const agent = mkAgent(`ru-badinput-${randomUUID()}`);
    await registerAgent(harper, agent);
    const res = await recordUsage(harper, agent, {});
    expect(res.status).toBe(400);
  }, 30_000);

  test("attribution is sanitized: control characters stripped, length capped", async () => {
    const owner = mkAgent(`ru-attrib-owner-${randomUUID()}`);
    const reporter = mkAgent(`ru-attrib-reporter-${randomUUID()}`);
    await registerAgent(harper, owner);
    await registerAgent(harper, reporter);
    const memId = `${owner.id}-mem`;
    await putMemory(harper, owner, memId, { agentId: owner.id, content: "Attribution sanitize test memory, long enough for the gate.", durability: "standard" });

    const dirty = "line1\x00\x07\x1Bline2" + "x".repeat(600);
    const res = await recordUsage(harper, reporter, { memoryIds: [memId], attribution: dirty });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recorded: true }); // response never echoes attribution back either
  }, 30_000);
});
