// Citation-on-write (flair#744 slice A; flair#775 slice 1 read-scope gate)
// e2e — real-Harper integration tests.
//
// WHY THIS FILE EXISTS: mirrors test/integration/record-usage-e2e.test.ts
// (same real-Harper spawn / signed TPS-Ed25519 request pattern) for the NEW
// `usedMemoryIds` write-time surface. citation-on-write is a thin, post-commit
// wrapper around the SAME shared ledger core RecordUsage.ts uses
// (resources/usage-recording.ts), so this file focuses on the properties that
// are SPECIFIC to the write-surface integration — the ledger-sharing/dedup
// parity itself, cross-agent isolation, the read-scope gate (a cited id the
// writer cannot read drops IDENTICALLY to a nonexistent one — flair#775),
// post-commit write-success isolation, and that `usedMemoryIds` is never
// persisted on the row — rather than re-proving every RecordUsage property
// (auth/no-enumeration/attribution-sanitization) already covered there
// against the identical underlying ledger.
//
// VISIBILITY NOTE (flair#775): a `durability: "standard"` write with no
// explicit visibility is stamped `private` by Memory's durability-keyed
// default — and a private memory is OUTSIDE any other agent's read scope, so
// a cross-agent citation of it is now (correctly) dropped by the scope gate.
// Every test below whose scenario is "agent B cites agent A's memory and it
// counts" therefore writes the cited memory with an explicit
// `visibility: "shared"`; the scope-gate test at the bottom covers the
// private case.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";

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

/** Signed PUT to /Memory/<id> — the write path these tests use; one of the
 *  two write surfaces citation-on-write hooks (put()). */
async function putMemory(harper: HarperInstance, agent: TestAgent, id: string, body: Record<string, any>): Promise<Response> {
  const path = `/Memory/${id}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...body }),
  });
}

/** Signed POST to the /Memory collection — a create, which may carry
 *  `supersedes` and `usedMemoryIds` (flair#2656 exercises this POST path). */
async function postMemory(harper: HarperInstance, agent: TestAgent, body: Record<string, any>): Promise<Response> {
  const path = "/Memory";
  return fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
let pauseDir = "";

/** Length of the captured Harper log; {@link logSince} returns what followed. */
function logLength(): number {
  return (harper.getLog?.() ?? "").length;
}
function logSince(offset: number): string {
  return (harper.getLog?.() ?? "").slice(offset);
}

/** Wait up to `timeoutMs` for `line` to appear in the log after `offset`. */
async function waitForLogSince(offset: number, line: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (logSince(offset).includes(line)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return logSince(offset).includes(line);
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return existsSync(path);
}

/** Arm a test-only pause point for one request (txn-pause-point.ts consumes the arm file). */
function armPause(point: string): void {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
}
function releasePause(point: string): void {
  writeFileSync(join(pauseDir, `go.${point}`), "");
}

/** The id's ledger row, read through the admin ops API — the ground truth the
 *  usage count derives from. */
async function ledgerRows(memoryId: string): Promise<any[]> {
  const res = await adminOp(harper, {
    operation: "search_by_value", database: "flair", table: "MemoryUsage",
    search_attribute: "memoryId", search_value: memoryId, get_attributes: ["id", "agentId", "memoryId"],
  });
  expect(res.status).toBe(200);
  return await res.json() as any[];
}

describe("citation-on-write e2e (real Harper) — flair#744 slice A", () => {
  beforeAll(async () => {
    if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
    // Pause points let a test hold one memory id's write lock for the length of
    // a controlled request (the "another request holds it" case).
    pauseDir = mkdtempSync(join(tmpdir(), "flair-2858-pause-"));
    harper = await startHarper({
      serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
    });
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  }, HARPER_STOP_BUDGET_MS);

  test("citing a memory on write bumps its usageCount through the SAME shared ledger as POST /RecordUsage", async () => {
    const owner = mkAgent(`cow-owner-${randomUUID()}`);
    const citer = mkAgent(`cow-citer-${randomUUID()}`);
    await registerAgent(harper, owner);
    await registerAgent(harper, citer);

    const citedId = `${owner.id}-cited`;
    const putCited = await putMemory(harper, owner, citedId, { agentId: owner.id, content: "The cited memory, long enough for the dedup gate to consider.", durability: "standard", visibility: "shared" });
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
    expect(rec.writeBackWriteId).toBeString();
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
    await putMemory(harper, owner, citedId, { agentId: owner.id, content: "Dedup-parity cited memory, long enough for the gate.", durability: "standard", visibility: "shared" });

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
    await putMemory(harper, owner, citedId, { agentId: owner.id, content: "Cross-agent-isolation cited memory, long enough for the gate.", durability: "standard", visibility: "shared" });

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
    await putMemory(harper, owner, citedId, { agentId: owner.id, content: "Shape-parity cited memory, long enough for the gate.", durability: "standard", visibility: "shared" });

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

  test("read-scope gate (flair#775 slice 1): citing another agent's PRIVATE memory drops IDENTICALLY to citing a nonexistent id — no usageCount bump, no ledger row, indistinguishable write response", async () => {
    const owner = mkAgent(`cow-gate-owner-${randomUUID()}`);
    const citerA = mkAgent(`cow-gate-citer-a-${randomUUID()}`);
    const citerB = mkAgent(`cow-gate-citer-b-${randomUUID()}`);
    await registerAgent(harper, owner);
    await registerAgent(harper, citerA);
    await registerAgent(harper, citerB);

    const privateId = `${owner.id}-private`;
    const putPrivate = await putMemory(harper, owner, privateId, {
      agentId: owner.id,
      content: "The owner's private memory, outside every other agent's read scope.",
      durability: "standard",
      visibility: "private",
    });
    expect(putPrivate.status).toBe(200);

    // Two citing writes as alike as the API allows — IDENTICAL content
    // (different WRITERS, so the per-agent dedup gate can't collapse them)
    // and the same id suffix — differing ONLY in which cited id rides along:
    // another agent's private memory vs an id that doesn't exist at all.
    const PROBE_CONTENT = "A citing write used to compare the private-cited and nonexistent-cited responses byte for byte.";
    const resPrivate = await putMemory(harper, citerA, `${citerA.id}-gate-probe`, {
      agentId: citerA.id, content: PROBE_CONTENT, durability: "standard",
      usedMemoryIds: [privateId],
    });
    const resMissing = await putMemory(harper, citerB, `${citerB.id}-gate-probe`, {
      agentId: citerB.id, content: PROBE_CONTENT, durability: "standard",
      usedMemoryIds: [`does-not-exist-${randomUUID()}`],
    });
    expect(resPrivate.status).toBe(200);
    expect(resMissing.status).toBe(200);

    // Uniform behavior at the response level: after normalizing each
    // response's own write inputs (the writer's caller-chosen agent id and
    // write timestamps — different for any two writes regardless of what
    // they cite), the two bodies must be byte-identical. Any residual
    // difference would be signal attributable to the CITED id's status
    // (exists-but-unreadable vs nonexistent) — an enumeration oracle.
    const canon = (body: any, citer: TestAgent) =>
      JSON.stringify(body)
        .replaceAll(citer.id, "<WRITER>")
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<TS>");
    expect(canon(await resPrivate.json(), citerA)).toBe(canon(await resMissing.json(), citerB));

    // No credit: the private memory's usageCount is untouched...
    const check = await getMemory(harper, owner, privateId);
    const rec: any = await check.json();
    expect(rec.usageCount ?? 0).toBe(0);

    // ...and no MemoryUsage ledger row exists for it either (checked via the
    // admin ops API — the ledger is the ground truth the count derives from).
    const ledger = await adminOp(harper, {
      operation: "search_by_value", database: "flair", table: "MemoryUsage",
      search_attribute: "memoryId", search_value: privateId, get_attributes: ["id", "agentId", "memoryId"],
    });
    expect(ledger.status).toBe(200);
    expect(await ledger.json()).toEqual([]);
  }, 60_000);

  // ── flair#2858: a POST records its citations after it releases its locks ──
  // As put() does (resources/Memory.ts: put()'s afterRelease queue is drained
  // after withMemoryWriteLock returns; post() drains its own queue the same
  // way). A POST that supersedes a predecessor holds that predecessor's id
  // until its lock releases, so before this fix its own citation of the
  // predecessor was skipped as busy.

  test("a POST that supersedes a predecessor and cites it credits the predecessor once and logs NO busy skip (#2858)", async () => {
    const agent = mkAgent(`cow-post-sup-${randomUUID()}`);
    await registerAgent(harper, agent);

    const predId = `${agent.id}-pred`;
    const putPred = await putMemory(harper, agent, predId, {
      agentId: agent.id,
      content: "The predecessor memory a successor will cite, long enough for the dedup gate.",
      durability: "standard",
      visibility: "shared",
    });
    expect(putPred.status).toBe(200);

    const logBefore = logLength();
    const succId = `${agent.id}-succ`;
    const res = await postMemory(harper, agent, {
      id: succId,
      agentId: agent.id,
      content: "The successor memory, which supersedes the predecessor and cites it.",
      durability: "standard",
      visibility: "shared",
      supersedes: predId,
      usedMemoryIds: [predId],
    });
    const text = await res.text();
    expect(res.status, `superseding POST returned ${res.status}: ${text.slice(0, 300)}`).toBe(201);
    expect((JSON.parse(text) as any).written).toBe(true);

    const rec: any = await (await getMemory(harper, agent, predId)).json();
    expect(rec.validTo).toBeTruthy();
    expect(rec.usageCount).toBe(1);

    const rows = await ledgerRows(predId);
    expect(rows).toHaveLength(1);
    expect(rows[0].agentId).toBe(agent.id);

    expect(logSince(logBefore)).not.toContain(`contribution skipped: busy for memory ${predId}`);
  }, 60_000);

  test("control: a POST citing an unrelated id still credits it once (#2858)", async () => {
    const agent = mkAgent(`cow-post-ctl-${randomUUID()}`);
    await registerAgent(harper, agent);

    const citedId = `${agent.id}-cited`;
    await putMemory(harper, agent, citedId, {
      agentId: agent.id,
      content: "An unrelated cited memory for the POST control, long enough for the gate.",
      durability: "standard",
      visibility: "shared",
    });

    const logBefore = logLength();
    const res = await postMemory(harper, agent, {
      agentId: agent.id,
      content: "A POST with no supersede that cites an unrelated memory.",
      durability: "standard",
      usedMemoryIds: [citedId],
    });
    const text = await res.text();
    expect(res.status, `citing POST returned ${res.status}: ${text.slice(0, 300)}`).toBe(201);

    const rec: any = await (await getMemory(harper, agent, citedId)).json();
    expect(rec.usageCount).toBe(1);
    expect(await ledgerRows(citedId)).toHaveLength(1);
    expect(logSince(logBefore)).not.toContain(`contribution skipped: busy for memory ${citedId}`);
  }, 60_000);

  test("a citation of an id another request holds is still skipped and logged, as on main (#2858)", async () => {
    const agent = mkAgent(`cow-post-busy-${randomUUID()}`);
    await registerAgent(harper, agent);

    const heldId = `${agent.id}-held`;
    const putHeld = await putMemory(harper, agent, heldId, {
      agentId: agent.id,
      content: "The memory another request will hold while a POST cites it.",
      durability: "standard",
      visibility: "shared",
    });
    expect(putHeld.status).toBe(200);

    // An owner PUT that has committed and still holds the id's lock while a
    // test-only pause keeps its request open.
    armPause("memory-put-committed");
    const holder = putMemory(harper, agent, heldId, {
      agentId: agent.id,
      content: "The holder request's replacement content.",
      durability: "standard",
      visibility: "shared",
    });
    expect(await waitFor(join(pauseDir, "paused.memory-put-committed"), 20_000)).toBe(true);

    const logBefore = logLength();
    let res: Response;
    try {
      res = await postMemory(harper, agent, {
        agentId: agent.id,
        content: "A POST citing the id another request holds.",
        durability: "standard",
        usedMemoryIds: [heldId],
      });
    } finally {
      releasePause("memory-put-committed");
    }
    expect((await holder).status).toBe(200);
    expect(res!.status).toBe(201);

    const rec: any = await (await getMemory(harper, agent, heldId)).json();
    expect(rec.usageCount ?? 0).toBe(0);
    expect(await ledgerRows(heldId)).toEqual([]);
    expect(await waitForLogSince(logBefore, `contribution skipped: busy for memory ${heldId}`)).toBe(true);
  }, 60_000);
});
