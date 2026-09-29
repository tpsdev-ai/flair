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
//      — and no OTHER field on A's memory changes. The cross-agent fixtures
//      are `visibility: "shared"`: B can only report a memory it can read
//      (property 5), and a `standard` memory defaults to private.
//   3. dedup — each (agentId, memoryId) pair contributes AT MOST 1 to
//      usageCount, even across repeated calls.
//   4. no ID enumeration — the response is IDENTICAL for a not-found id, an
//      already-counted id, and a fresh valid id (a caller can't distinguish
//      "doesn't exist" from "you already used it" from "recorded").
//   5. read scope — usage is recorded only for a memory the caller can read
//      (its own at any visibility, another agent's non-private); a memory the
//      caller cannot read is handled exactly like a missing id, and the
//      caller's own MemoryUsage ledger never shows a row about a memory it
//      cannot read.
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

/** Signed GET of the caller's own ledger row `${agent.id}:${memoryId}`. */
async function getOwnLedgerRow(harper: HarperInstance, agent: TestAgent, memoryId: string): Promise<{ status: number; text: string }> {
  const path = `/MemoryUsage/${encodeURIComponent(`${agent.id}:${memoryId}`)}`;
  const res = await fetch(`${harper.httpURL}${path}`, { headers: { Authorization: ed25519Header(agent, "GET", path) } });
  return { status: res.status, text: await res.text() };
}

/** Signed collection GET of the caller's own ledger — the memoryIds it is shown. */
async function listOwnLedgerMemoryIds(harper: HarperInstance, agent: TestAgent): Promise<string[]> {
  const path = "/MemoryUsage/";
  const res = await fetch(`${harper.httpURL}${path}`, { headers: { Authorization: ed25519Header(agent, "GET", path) } });
  const text = await res.text();
  expect(res.status, `GET /MemoryUsage/ returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  const rows = JSON.parse(text);
  expect(Array.isArray(rows), `collection read should be an array, got: ${text.slice(0, 200)}`).toBe(true);
  for (const r of rows) expect(r.agentId, "the ledger read returned another agent's row").toBe(agent.id);
  return rows.map((r: any) => r.memoryId).sort();
}

/** Admin ground truth: the stored Memory row, every attribute. */
async function adminMemory(harper: HarperInstance, id: string): Promise<any | null> {
  const res = await adminOp(harper, { operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] });
  expect(res.status).toBe(200);
  const rows: any[] = await res.json();
  return rows[0] ?? null;
}

/** Admin ground truth: every MemoryUsage row naming `memoryId`. */
async function adminLedgerRowsFor(harper: HarperInstance, memoryId: string): Promise<any[]> {
  const res = await adminOp(harper, {
    operation: "search_by_value", database: "flair", table: "MemoryUsage",
    search_attribute: "memoryId", search_value: memoryId, get_attributes: ["id", "agentId", "memoryId"],
  });
  expect(res.status).toBe(200);
  return res.json();
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
    const putRes = await putMemory(harper, owner, memId, { agentId: owner.id, content: originalContent, durability: "standard", visibility: "shared", tags: ["original-tag"] });
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
    const putRes = await putMemory(harper, owner, memId, { agentId: owner.id, content: "Dedup test memory, long enough for the dedup gate to consider.", durability: "standard", visibility: "shared" });
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
    await putMemory(harper, owner, memId, { agentId: owner.id, content: "Batch-dedup test memory, long enough for the gate.", durability: "standard", visibility: "shared" });

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

    await putMemory(harper, owner, freshMemId, { agentId: owner.id, content: "Fresh memory for the enumeration test, long enough.", durability: "standard", visibility: "shared" });
    await putMemory(harper, owner, alreadyCountedMemId, { agentId: owner.id, content: "Already-counted memory for the enumeration test, long enough.", durability: "standard", visibility: "shared" });

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

  test("flair#1410: POST /RecordUsage MERGES memoryId + memoryIds — singular id not in the array is credited", async () => {
    // The endpoint previously preferred memoryIds (`data?.memoryIds ?? …`)
    // and silently dropped memoryId. A client that POSTs both fields
    // without flattening first must still credit the singular id.
    const owner = mkAgent(`ru-1410-owner-${randomUUID()}`);
    const reporter = mkAgent(`ru-1410-reporter-${randomUUID()}`);
    await registerAgent(harper, owner);
    await registerAgent(harper, reporter);

    const memA = `${owner.id}-a`;
    const memB = `${owner.id}-b`;
    const memSolo = `${owner.id}-solo`;
    for (const id of [memA, memB, memSolo]) {
      const put = await putMemory(harper, owner, id, {
        agentId: owner.id,
        content: `flair#1410 merge test memory ${id}, long enough for the dedup gate.`,
        durability: "standard",
        visibility: "shared",
      });
      expect(put.status).toBe(200);
    }

    const res = await recordUsage(harper, reporter, { memoryId: memSolo, memoryIds: [memA, memB] });
    expect(res.status, `RecordUsage returned ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    expect(res.body).toEqual({ recorded: true });

    const counts: Record<string, number> = {};
    for (const id of [memA, memB, memSolo]) {
      const rec: any = await (await getMemory(harper, owner, id)).json();
      counts[id] = rec.usageCount ?? 0;
    }
    expect(counts[memA], "plural id A credited").toBe(1);
    expect(counts[memB], "plural id B credited").toBe(1);
    // Powered: stays red if the endpoint still prefers memoryIds and drops memoryId.
    expect(counts[memSolo], "singular memoryId not in memoryIds must be credited").toBe(1);
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
    await putMemory(harper, owner, memId, { agentId: owner.id, content: "Attribution sanitize test memory, long enough for the gate.", durability: "standard", visibility: "shared" });

    const dirty = "line1\x00\x07\x1Bline2" + "x".repeat(600);
    const res = await recordUsage(harper, reporter, { memoryIds: [memId], attribution: dirty });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recorded: true }); // response never echoes attribution back either
  }, 30_000);
  test("read scope: the caller's own memory is counted at any visibility, and its ledger row is readable", async () => {
    const owner = mkAgent(`ru-scope-own-${randomUUID()}`);
    await registerAgent(harper, owner);
    const memId = `${owner.id}-private`;
    const put = await putMemory(harper, owner, memId, {
      agentId: owner.id, content: "The owner's own private memory, long enough for the dedup gate.", durability: "standard", visibility: "private",
    });
    expect(put.status).toBe(200);

    const res = await recordUsage(harper, owner, { memoryIds: [memId] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recorded: true });

    expect((await adminMemory(harper, memId))?.usageCount).toBe(1);
    expect((await adminLedgerRowsFor(harper, memId)).map((r) => r.agentId)).toEqual([owner.id]);
    const row = await getOwnLedgerRow(harper, owner, memId);
    expect(row.status, row.text.slice(0, 300)).toBe(200);
    expect(JSON.parse(row.text).memoryId).toBe(memId);
    expect(await listOwnLedgerMemoryIds(harper, owner)).toEqual([memId]);
  }, 60_000);

  test("read scope: another agent's shared memory is counted, and the reporter's ledger row is readable", async () => {
    const owner = mkAgent(`ru-scope-shared-owner-${randomUUID()}`);
    const reporter = mkAgent(`ru-scope-shared-reporter-${randomUUID()}`);
    await registerAgent(harper, owner);
    await registerAgent(harper, reporter);
    const memId = `${owner.id}-shared`;
    const put = await putMemory(harper, owner, memId, {
      agentId: owner.id, content: "The owner's shared memory, readable by every agent on the instance.", durability: "standard", visibility: "shared",
    });
    expect(put.status).toBe(200);

    const res = await recordUsage(harper, reporter, { memoryIds: [memId] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recorded: true });

    expect((await adminMemory(harper, memId))?.usageCount).toBe(1);
    expect((await adminLedgerRowsFor(harper, memId)).map((r) => r.agentId)).toEqual([reporter.id]);
    const row = await getOwnLedgerRow(harper, reporter, memId);
    expect(row.status, row.text.slice(0, 300)).toBe(200);
    expect(await listOwnLedgerMemoryIds(harper, reporter)).toEqual([memId]);
  }, 60_000);

  test("read scope: another agent's private memory is handled exactly like a missing id — same response, no ledger row, counters unchanged (admin-verified)", async () => {
    const owner = mkAgent(`ru-scope-private-owner-${randomUUID()}`);
    const reporter = mkAgent(`ru-scope-private-reporter-${randomUUID()}`);
    await registerAgent(harper, owner);
    await registerAgent(harper, reporter);
    const privateId = `${owner.id}-private`;
    const missingId = `${owner.id}-missing-${randomUUID()}`;
    const put = await putMemory(harper, owner, privateId, {
      agentId: owner.id, content: "The owner's private memory, outside every other agent's read scope.", durability: "standard", visibility: "private",
    });
    expect(put.status).toBe(200);
    const before = await adminMemory(harper, privateId);
    expect(before?.visibility).toBe("private");

    const resPrivate = await recordUsage(harper, reporter, { memoryIds: [privateId] });
    const resMissing = await recordUsage(harper, reporter, { memoryIds: [missingId] });
    expect(resPrivate.status).toBe(resMissing.status);
    expect(resPrivate.text).toBe(resMissing.text);
    expect(resPrivate.body).toEqual({ recorded: true });

    // The reporter's own ledger: both ids read as "no such row", byte for byte.
    const ledgerPrivate = await getOwnLedgerRow(harper, reporter, privateId);
    const ledgerMissing = await getOwnLedgerRow(harper, reporter, missingId);
    expect(ledgerPrivate.status).toBe(404);
    expect(ledgerPrivate.status).toBe(ledgerMissing.status);
    expect(ledgerPrivate.text).toBe(ledgerMissing.text);
    expect(await listOwnLedgerMemoryIds(harper, reporter)).toEqual([]);

    // Admin ground truth: no ledger row for either id, and the private memory
    // is unchanged in every attribute (usageCount included).
    expect(await adminLedgerRowsFor(harper, privateId)).toEqual([]);
    expect(await adminLedgerRowsFor(harper, missingId)).toEqual([]);
    expect(await adminMemory(harper, privateId)).toEqual(before);
    expect(await adminMemory(harper, missingId)).toBeNull();
  }, 60_000);

  test("read scope: after the owner makes a memory private, the reporter's ledger row about it is not shown, and a new report changes nothing", async () => {
    const owner = mkAgent(`ru-scope-flip-owner-${randomUUID()}`);
    const reporter = mkAgent(`ru-scope-flip-reporter-${randomUUID()}`);
    await registerAgent(harper, owner);
    await registerAgent(harper, reporter);
    const flipId = `${owner.id}-flip`;
    const keptId = `${owner.id}-kept`;
    for (const id of [flipId, keptId]) {
      const put = await putMemory(harper, owner, id, {
        agentId: owner.id, content: `Shared memory ${id}, long enough for the dedup gate.`, durability: "standard", visibility: "shared",
      });
      expect(put.status).toBe(200);
    }
    const res = await recordUsage(harper, reporter, { memoryIds: [flipId, keptId] });
    expect(res.status).toBe(200);
    expect(await listOwnLedgerMemoryIds(harper, reporter)).toEqual([flipId, keptId].sort());

    // The owner makes one of them private.
    const current = await adminMemory(harper, flipId);
    const flip = await putMemory(harper, owner, flipId, {
      agentId: owner.id, content: current.content, durability: "standard", visibility: "private",
    });
    expect(flip.status).toBe(200);
    expect((await adminMemory(harper, flipId))?.visibility).toBe("private");

    // The reporter's row about it now reads as missing; the other is unaffected.
    const hidden = await getOwnLedgerRow(harper, reporter, flipId);
    const absent = await getOwnLedgerRow(harper, reporter, `${owner.id}-never-${randomUUID()}`);
    expect(hidden.status).toBe(404);
    expect(hidden.text).toBe(absent.text);
    expect((await getOwnLedgerRow(harper, reporter, keptId)).status).toBe(200);
    expect(await listOwnLedgerMemoryIds(harper, reporter)).toEqual([keptId]);

    // The row is still stored (the ledger is append-only), but it is not shown,
    // and a later report on the now-private memory changes nothing.
    expect((await adminLedgerRowsFor(harper, flipId)).map((r) => r.agentId)).toEqual([reporter.id]);
    const countBefore = (await adminMemory(harper, flipId))?.usageCount;
    const again = await recordUsage(harper, reporter, { memoryIds: [flipId] });
    expect(again.body).toEqual({ recorded: true });
    expect((await adminMemory(harper, flipId))?.usageCount).toBe(countBefore);
  }, 60_000);
});
