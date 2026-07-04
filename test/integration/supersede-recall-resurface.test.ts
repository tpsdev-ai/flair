// ops-9rc6 — a server-superseded memory resurfaces in the DEFAULT (no-asOf)
// recall path when its successor isn't semantically/conditions co-present in
// the same search result set.
//
// Root cause: resources/SemanticSearch.ts only ever excluded a superseded
// record two ways: (1) an `asOf` historical query comparing `record.validTo`
// against the caller-supplied `asOf`, or (2) a co-presence check AFTER the
// query — it built a `supersededIds` set from whichever records IN THE
// RESULT SET carried a `supersedes` pointer, then filtered those ids out.
// Neither path fires for the DEFAULT (no-asOf) recall of a query whose
// successor record isn't in the same result set — e.g. the successor was
// written with a different `subject` (this test's reproduction), fell
// outside the HNSW/BM25 candidate window, or was excluded by tag/subject
// filtering. The server supersede path (Memory.put with `supersedes`, or
// memory_update's preserveHistory mode via resources/mcp-tools.ts) closes
// the OLD record by setting `validTo` (Memory.ts closeSupersededRecord) but
// does NOT set `archived` — so the old record sails past the
// `archived not_equal true` condition too.
//
// Fix: an unconditional per-record exclusion — `validTo` set AND in the past
// (relative to real `Date.now()`) — applied in ALL THREE SemanticSearch.ts
// per-record loops (hybrid semantic-candidate, legacy HNSW, keyword-only
// fallback) and in bm25-filter.ts's `passesRecordFilters` (shared by the
// hybrid corpus/BM25 path). Applies regardless of `asOf` or co-presence. A
// record with no `validTo`, or a FUTURE `validTo`, is unaffected — this test
// also asserts that boundary directly (Scenario B).
//
// Pattern: test/integration/dedup-supersede-e2e.test.ts (server supersede via
// signed PUT with `supersedes`) + test/integration/semantic-search-singleton-
// score.test.ts (real Ed25519-signed writes + real embeddings, hitting
// /SemanticSearch over HTTP). `subject` filtering (not embedding-similarity
// distance) is what guarantees genuine non-co-presence here: the successor's
// `subject` differs from the query's `subject` filter, so it's excluded from
// the Harper query's conditions[] entirely — never even fetched as a
// candidate, regardless of HNSW ranking. That is a strictly harder
// reproduction of the bug than relying on embedding distance alone.
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

async function getMemory(harper: HarperInstance, agent: TestAgent, id: string): Promise<Response> {
  const path = `/Memory/${id}`;
  return fetch(`${harper.httpURL}${path}`, {
    headers: { Authorization: ed25519Header(agent, "GET", path) },
  });
}

async function search(harper: HarperInstance, agent: TestAgent, body: Record<string, any>): Promise<any> {
  const path = "/SemanticSearch";
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  expect(res.status, `SemanticSearch → ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

let harper: HarperInstance;
const agent = mkAgent(`ops-9rc6-${randomUUID()}`);

const SUBJECT = "ops-9rc6-budget-approval";
const OTHER_SUBJECT = "ops-9rc6-unrelated-kitchen-topic";

const ID_A = `${agent.id}-a`; // superseded (server path) — must NOT resurface
const ID_B = `${agent.id}-b`; // successor — different subject, never co-present with A's search
const ID_C = `${agent.id}-c`; // control: never superseded, no validTo — must still surface
const ID_D = `${agent.id}-d`; // control: FUTURE validTo, never superseded — must still surface

const CONTENT_A = "The quarterly budget approval deadline for the marketing expansion project is March 15th.";
const CONTENT_B = "The office kitchen coffee machine requires descaling every two weeks per the maintenance schedule.";
const CONTENT_C = "The finance team's Q3 budget sign-off is expected in mid-March for the expansion initiative.";
const CONTENT_D = "The annual budget planning retreat for department heads is confirmed for next spring.";
const QUERY = "When is the marketing budget deadline approved?";

describe("ops-9rc6 — server-superseded (validTo, not archived) memory must not resurface in default recall", () => {
  beforeAll(async () => {
    harper = await startHarper();
    await registerAgent(harper, agent);

    // A: the record that will be server-superseded.
    const putA = await putMemory(harper, agent, ID_A, {
      agentId: agent.id, content: CONTENT_A, durability: "standard", subject: SUBJECT,
    });
    expect(putA.status, `seed PUT ${ID_A} → ${putA.status}: ${await putA.text()}`).toBe(200);

    // B: supersedes A via the SERVER path (Memory.put with `supersedes`).
    // Different `subject` so B is NEVER co-present with a subject-scoped
    // search for A's content — Harper's conditions[] excludes it outright,
    // not just a low HNSW/BM25 rank. This is the bug's actual precondition.
    const putB = await putMemory(harper, agent, ID_B, {
      agentId: agent.id, content: CONTENT_B, durability: "standard",
      subject: OTHER_SUBJECT, supersedes: ID_A,
    });
    const textB = await putB.text();
    expect(putB.status, `supersede PUT ${ID_B} → ${putB.status}: ${textB.slice(0, 300)}`).toBe(200);
    const bodyB: any = JSON.parse(textB);
    expect(bodyB.written).toBe(true);

    // Confirm the server actually closed A (validTo set) — the documented
    // ops-9rc6 mechanism (Memory.ts closeSupersededRecord), NOT archived.
    const getA = await getMemory(harper, agent, ID_A);
    expect(getA.status).toBe(200);
    const recA: any = await getA.json();
    expect(recA.validTo, "server supersede path must set validTo on the old record").toBeTruthy();
    expect(recA.archived, "server supersede path does NOT set archived — that's the whole bug").not.toBe(true);

    // C: control — never superseded, no validTo at all. Same subject as A so
    // it's a candidate in the same subject-scoped search.
    const putC = await putMemory(harper, agent, ID_C, {
      agentId: agent.id, content: CONTENT_C, durability: "standard", subject: SUBJECT,
    });
    expect(putC.status, `seed PUT ${ID_C} → ${putC.status}: ${await putC.text()}`).toBe(200);

    // D: control — a FUTURE validTo (time-boxed fact still valid today).
    // Confirms Option A's boundary: only a PAST validTo excludes.
    const futureValidTo = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();
    const putD = await putMemory(harper, agent, ID_D, {
      agentId: agent.id, content: CONTENT_D, durability: "standard", subject: SUBJECT, validTo: futureValidTo,
    });
    expect(putD.status, `seed PUT ${ID_D} → ${putD.status}: ${await putD.text()}`).toBe(200);
    const getD = await getMemory(harper, agent, ID_D);
    const recD: any = await getD.json();
    expect(recD.validTo).toBe(futureValidTo);
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("a server-superseded record (validTo set, not archived, successor NOT co-present) is excluded from default recall", async () => {
    const body = await search(harper, agent, {
      agentId: agent.id, q: QUERY, subject: SUBJECT, limit: 10, scoring: "raw",
    });
    const ids: string[] = body.results.map((r: any) => r.id);

    // The successor (different subject) must genuinely never be a candidate
    // here — confirms this search truly did NOT have B co-present, which is
    // the bug's precondition (pre-fix, A would ONLY be caught by co-presence,
    // and there is none here).
    expect(ids, "test setup invariant: B must not be co-present in this subject-scoped search").not.toContain(ID_B);

    // The actual assertion: A (server-superseded, validTo in the past, not
    // archived) must NOT resurface just because its successor isn't co-present.
    expect(ids, `superseded record ${ID_A} resurfaced in default recall: ${JSON.stringify(ids)}`).not.toContain(ID_A);

    // Non-superseded records — no validTo, and a FUTURE validTo — must still
    // surface normally.
    expect(ids, `non-superseded control ${ID_C} (no validTo) missing from results: ${JSON.stringify(ids)}`).toContain(ID_C);
    expect(ids, `non-superseded control ${ID_D} (future validTo) missing from results: ${JSON.stringify(ids)}`).toContain(ID_D);
  }, 60_000);
});
