// Citation-on-write (flair#744 slice A) e2e — real-Harper integration tests.
//
// WHY THIS FILE EXISTS: mirrors test/integration/record-usage-e2e.test.ts
// (same real-Harper spawn / signed TPS-Ed25519 request pattern) for the NEW
// `usedMemoryIds` write-time surface. citation-on-write is a thin, post-commit
// wrapper around the SAME shared ledger core RecordUsage.ts uses
// (resources/usage-recording.ts), so this file focuses on the properties that
// are SPECIFIC to the write-surface integration — the ledger-sharing/dedup
// parity itself, cross-agent isolation, out-of-scope/nonexistent-id silent
// drop, post-commit write-success isolation, and that `usedMemoryIds` is
// never persisted on the row — rather than re-proving every RecordUsage
// property (auth/no-enumeration/attribution-sanitization) already covered
// there against the identical underlying ledger.
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

/** Signed PUT to /Memory/<id> — the only HTTP-reachable Memory create/update
 *  path, and one of the two write surfaces citation-on-write hooks (put()). */
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

/** Signed POST /RecordUsage — used to prove dedup PARITY with citation-on-write
 *  (same shared ledger, so a citation and a RecordUsage call on the same
 *  (agent, memory) pair must contribute at most 1, not 2). */
async function recordUsage(harper: HarperInstance, agent: TestAgent, body: Record<string, any>): Promise<{ status: number; body: any }> {
  const path = "/RecordUsage";
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

let harper: HarperInstance;

describe("citation-on-write e2e (real Harper) — flair#744 slice A", () => {
  beforeAll(async () => {
    harper = await startHarper();
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test("citing a memory on write bumps its usageCount through the SAME shared ledger as POST /RecordUsage", async () => {
    const owner = mkAgent(`cow-owner-${randomUUID()}`);
    const citer = mkAgent(`cow-citer-${randomUUID()}`);
    await registerAgent(harper, owner);
    await registerAgent(harper, citer);

    const citedId = `${owner.id}-cited`;
    const putCited = await putMemory(harper, owner, citedId, { agentId: owner.id, content: "The cited memory, long enough for the dedup gate to consider.", durability: "standard" });
    expect(putCited.status).toBe(200);

    const newId = `${citer.id}-citing-write`;
    const putCiting = await putMemory(harper, citer, newId, {
      agentId: citer.id,
      content: "A new memory that cites the earlier one above.",
      durability: "standard",
      usedMemoryIds: [citedId],
    });
    expect(putCiting.status, `citing write returned ${putCiting.status}: ${JSON.stringify(await putCiting.clone().json().catch(() => null))}`).toBe(200);

    const check = await getMemory(harper, owner, citedId);
    const rec: any = await check.json();
    expect(rec.usageCount).toBe(1);
  }, 60_000);

  test("usedMemoryIds is stripped — NEVER persisted on the writing memory's own row", async () => {
    const owner = mkAgent(`cow-strip-owner-${randomUUID()}`);
    const citer = mkAgent(`cow-strip-citer-${randomUUID()}`);
    await registerAgent(harper, owner);
    await registerAgent(harper, citer);

    const citedId = `${owner.id}-cited`;
    await putMemory(harper, owner, citedId, { agentId: owner.id, content: "Cited memory for the strip test, long enough for the gate.", durability: "standard" });

    const newId = `${citer.id}-citing`;
    const putRes = await putMemory(harper, citer, newId, {
      agentId: citer.id,
      content: "This write carries usedMemoryIds, which must never land on its own row.",
      durability: "standard",
      usedMemoryIds: [citedId],
    });
    expect(putRes.status).toBe(200);

    const check = await getMemory(harper, citer, newId);
    const rec: any = await check.json();
    expect(rec.usedMemoryIds).toBeUndefined();
  }, 60_000);

  test("dedup PARITY: citing the same memory via citation-on-write AND POST /RecordUsage contributes AT MOST 1 (same ledger key)", async () => {
    const owner = mkAgent(`cow-parity-owner-${randomUUID()}`);
    const citer = mkAgent(`cow-parity-citer-${randomUUID()}`);
    await registerAgent(harper, owner);
    await registerAgent(harper, citer);

    const citedId = `${owner.id}-cited`;
    await putMemory(harper, owner, citedId, { agentId: owner.id, content: "Dedup-parity cited memory, long enough for the gate.", durability: "standard" });

    // First contribution via citation-on-write.
    const citingId = `${citer.id}-citing`;
    const putRes = await putMemory(harper, citer, citingId, {
      agentId: citer.id, content: "First contribution via citation-on-write.", durability: "standard",
      usedMemoryIds: [citedId],
    });
    expect(putRes.status).toBe(200);

    const afterCitation = await getMemory(harper, owner, citedId);
    expect((await afterCitation.json()).usageCount).toBe(1);

    // SAME (citer, citedId) pair reported again via the standalone endpoint —
    // shares the identical ledger key `${agentId}:${memoryId}`, so this must
    // be a no-op, not a second increment.
    const ru = await recordUsage(harper, citer, { memoryIds: [citedId] });
    expect(ru.status).toBe(200);

    const afterRecordUsage = await getMemory(harper, owner, citedId);
    expect((await afterRecordUsage.json()).usageCount).toBe(1); // still 1 — NOT 2
  }, 60_000);

  test("cross-agent isolation: agent B citing agent A's memory credits it under B's ledger key; A's own later citation is an INDEPENDENT contribution", async () => {
    const owner = mkAgent(`cow-cross-owner-${randomUUID()}`);
    const agentB = mkAgent(`cow-cross-b-${randomUUID()}`);
    await registerAgent(harper, owner);
    await registerAgent(harper, agentB);

    const citedId = `${owner.id}-cited`;
    await putMemory(harper, owner, citedId, { agentId: owner.id, content: "Cross-agent-isolation cited memory, long enough for the gate.", durability: "standard" });

    // Agent B cites owner's memory on a write of B's own.
    const bWriteId = `${agentB.id}-citing`;
    const bPut = await putMemory(harper, agentB, bWriteId, {
      agentId: agentB.id, content: "B's write citing owner's memory.", durability: "standard",
      usedMemoryIds: [citedId],
    });
    expect(bPut.status).toBe(200);

    const afterB = await getMemory(harper, owner, citedId);
    expect((await afterB.json()).usageCount).toBe(1);

    // Owner (A) later cites their OWN memory on a separate write — a
    // DIFFERENT ledger key (`${owner.id}:${citedId}` vs `${agentB.id}:${citedId}`),
    // so it must independently add a second contribution, not collide with B's.
    const aWriteId = `${owner.id}-self-citing`;
    const aPut = await putMemory(harper, owner, aWriteId, {
      agentId: owner.id, content: "Owner's own later write, self-citing the earlier memory.", durability: "standard",
      usedMemoryIds: [citedId],
    });
    expect(aPut.status).toBe(200);

    const afterA = await getMemory(harper, owner, citedId);
    expect((await afterA.json()).usageCount).toBe(2); // two DISTINCT ledger keys = 2
  }, 60_000);

  test("out-of-scope / nonexistent cited id is silently dropped — the write still succeeds (200) with no error surfaced", async () => {
    const citer = mkAgent(`cow-oos-citer-${randomUUID()}`);
    await registerAgent(harper, citer);

    const nonexistentId = `does-not-exist-${randomUUID()}`;
    const newId = `${citer.id}-citing-nonexistent`;
    const putRes = await putMemory(harper, citer, newId, {
      agentId: citer.id,
      content: "This write cites an id that does not exist.",
      durability: "standard",
      usedMemoryIds: [nonexistentId],
    });
    expect(putRes.status, `write returned ${putRes.status}: ${JSON.stringify(await putRes.clone().json().catch(() => null))}`).toBe(200);
    const body: any = await putRes.json();
    expect(body.written).toBe(true);
    expect(body.error).toBeUndefined();
  }, 60_000);

  test("post-commit isolation: the write's response shape is IDENTICAL whether or not usedMemoryIds is present (citation recording never leaks into the write response)", async () => {
    const owner = mkAgent(`cow-shape-owner-${randomUUID()}`);
    const citer = mkAgent(`cow-shape-citer-${randomUUID()}`);
    await registerAgent(harper, owner);
    await registerAgent(harper, citer);

    const citedId = `${owner.id}-cited`;
    await putMemory(harper, owner, citedId, { agentId: owner.id, content: "Shape-parity cited memory, long enough for the gate.", durability: "standard" });

    const plainId = `${citer.id}-plain`;
    const plainRes = await putMemory(harper, citer, plainId, { agentId: citer.id, content: "A plain write with no citations.", durability: "standard" });
    expect(plainRes.status).toBe(200);
    const plainBody: any = await plainRes.json();

    const citingId = `${citer.id}-citing`;
    const citingRes = await putMemory(harper, citer, citingId, {
      agentId: citer.id, content: "A write that cites a memory, mixed with one nonexistent id too.", durability: "standard",
      usedMemoryIds: [citedId, `nonexistent-${randomUUID()}`],
    });
    expect(citingRes.status).toBe(200);
    const citingBody: any = await citingRes.json();

    // Same top-level response shape — citation recording (success, partial
    // no-op, or an internal failure) never adds/removes/changes fields on
    // the write response itself.
    expect(Object.keys(citingBody).sort()).toEqual(Object.keys(plainBody).sort());
    expect(citingBody.written).toBe(true);
    expect(citingBody.deduplicated).toBe(false);
  }, 60_000);

  test("omitted usedMemoryIds ⇒ no ledger side effect at all (byte-identical to a pre-slice-A write)", async () => {
    const owner = mkAgent(`cow-omit-owner-${randomUUID()}`);
    await registerAgent(harper, owner);
    const id = `${owner.id}-plain`;
    const putRes = await putMemory(harper, owner, id, { agentId: owner.id, content: "A completely ordinary write with no usedMemoryIds field at all.", durability: "standard" });
    expect(putRes.status).toBe(200);

    const check = await getMemory(harper, owner, id);
    const rec: any = await check.json();
    expect(rec.usageCount ?? 0).toBe(0);
    expect(rec.usedMemoryIds).toBeUndefined();
  }, 30_000);
});
