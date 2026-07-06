// A server-superseded Memory record resurfaces in the DEFAULT
// /BootstrapMemories recall path when its successor isn't co-present in
// bootstrap's own candidate set.
//
// Root cause: identical to the fix in PR #566, a different endpoint.
// resources/MemoryBootstrap.ts's Memory loop only ever excluded a record via
// `expiresAt` — never via `validTo`. The server supersede path
// (Memory.ts closeSupersededRecord, exercised via PUT /Memory/<id> with
// `supersedes`) closes the OLD record by setting `validTo` but deliberately
// does NOT set `archived` (see Memory.ts), so the old record survives every
// existing exclusion. Bootstrap does have a partial mitigation — a
// `supersededIds` set built from any `supersedes` pointer found in its own
// (unconditionally-loaded) candidate list — but bootstrap's candidate list is
// the reader's FULL scoped memory set (resources/memory-read-scope.ts,
// no subject/query narrowing at all), so for an ordinary same-agent supersede
// the successor is normally co-present and the mitigation alone would mask
// this bug. This test forces genuine non-co-presence by deleting the
// successor record after the server has closed the original — a legitimate
// real-world case (a prune/cleanup job, or a later hard-delete) where the
// newer record is gone but the older one's `validTo` marker persists.
//
// Fix: an unconditional per-record exclusion in the Memory loop —
// `validTo` set AND in the past (relative to real `Date.now()`) — the SAME
// idiom PR #566 added to resources/SemanticSearch.ts / resources/bm25-filter.ts.
// Applies regardless of co-presence. A record with no `validTo`, or a FUTURE
// `validTo`, is unaffected — this test asserts that boundary too (controls C/D).
//
// Pattern: test/integration/supersede-recall-resurface.test.ts (PR #566),
// adapted for /BootstrapMemories — whose response has no per-record id list,
// so assertions match on content substrings inside `body.context`.
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

async function bootstrap(harper: HarperInstance, agent: TestAgent, body: Record<string, any>): Promise<any> {
  const path = "/BootstrapMemories";
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  expect(res.status, `BootstrapMemories → ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

let harper: HarperInstance;
const agent = mkAgent(`bootstrap-resurface-${randomUUID()}`);

const ID_A = `${agent.id}-a`; // superseded (server path), successor later deleted — must NOT resurface
const ID_B = `${agent.id}-b`; // successor — deleted after closing A, to force genuine non-co-presence
const ID_C = `${agent.id}-c`; // control: never superseded, no validTo — must still surface
const ID_D = `${agent.id}-d`; // control: FUTURE validTo, never superseded — must still surface

const CONTENT_A = "bootstrap-resurface marker: the Q2 vendor contract renewal was approved at the March review.";
const CONTENT_B = "bootstrap-resurface marker: transient successor record, deleted immediately after closing A.";
const CONTENT_C = "bootstrap-resurface marker: the office lease renewal was signed off by facilities in April.";
const CONTENT_D = "bootstrap-resurface marker: the annual compliance audit is scheduled for next winter.";

describe("server-superseded (validTo, not archived) Memory record must not resurface in bootstrap", () => {
  beforeAll(async () => {
    harper = await startHarper();
    await registerAgent(harper, agent);

    // A: the record that will be server-superseded.
    const putA = await putMemory(harper, agent, ID_A, {
      agentId: agent.id, content: CONTENT_A, durability: "standard",
    });
    expect(putA.status, `seed PUT ${ID_A} → ${putA.status}: ${await putA.text()}`).toBe(200);

    // B: supersedes A via the SERVER path (Memory.put with `supersedes`).
    const putB = await putMemory(harper, agent, ID_B, {
      agentId: agent.id, content: CONTENT_B, durability: "standard", supersedes: ID_A,
    });
    const textB = await putB.text();
    expect(putB.status, `supersede PUT ${ID_B} → ${putB.status}: ${textB.slice(0, 300)}`).toBe(200);
    const bodyB: any = JSON.parse(textB);
    expect(bodyB.written).toBe(true);

    // Confirm the server actually closed A (validTo set) — the documented
    // closeSupersededRecord mechanism (Memory.ts), NOT archived.
    const getA = await getMemory(harper, agent, ID_A);
    expect(getA.status).toBe(200);
    const recA: any = await getA.json();
    expect(recA.validTo, "server supersede path must set validTo on the old record").toBeTruthy();
    expect(recA.archived, "server supersede path does NOT set archived — that's the whole bug").not.toBe(true);

    // Delete the successor to force genuine non-co-presence: bootstrap's
    // candidate list is the reader's FULL scoped memory set (no
    // subject/query narrowing), so B would otherwise always be co-present for
    // a same-agent supersede and the pre-existing supersededIds co-presence
    // mitigation would mask the exact gap this test targets.
    const delB = await adminOp(harper, { operation: "delete", database: "flair", table: "Memory", ids: [ID_B] });
    expect(delB.status, `delete ${ID_B} → ${delB.status}`).toBe(200);

    // C: control — never superseded, no validTo at all.
    const putC = await putMemory(harper, agent, ID_C, {
      agentId: agent.id, content: CONTENT_C, durability: "standard",
    });
    expect(putC.status, `seed PUT ${ID_C} → ${putC.status}: ${await putC.text()}`).toBe(200);

    // D: control — a FUTURE validTo (time-boxed fact still valid today).
    const futureValidTo = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();
    const putD = await putMemory(harper, agent, ID_D, {
      agentId: agent.id, content: CONTENT_D, durability: "standard", validTo: futureValidTo,
    });
    expect(putD.status, `seed PUT ${ID_D} → ${putD.status}: ${await putD.text()}`).toBe(200);
    const getD = await getMemory(harper, agent, ID_D);
    const recD: any = await getD.json();
    expect(recD.validTo).toBe(futureValidTo);
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("a server-superseded record (validTo set, not archived, successor NOT co-present) is excluded from bootstrap", async () => {
    const body = await bootstrap(harper, agent, { agentId: agent.id, maxTokens: 8000 });
    const context: string = body.context ?? "";

    // The actual assertion: A (server-superseded, validTo in the past, not
    // archived) must NOT resurface just because its successor isn't co-present.
    expect(context, `superseded record ${ID_A} resurfaced in bootstrap context`).not.toContain(CONTENT_A);

    // Non-superseded records — no validTo, and a FUTURE validTo — must still
    // surface normally.
    expect(context, `non-superseded control ${ID_C} (no validTo) missing from bootstrap context`).toContain(CONTENT_C);
    expect(context, `non-superseded control ${ID_D} (future validTo) missing from bootstrap context`).toContain(CONTENT_D);
  }, 60_000);
});
