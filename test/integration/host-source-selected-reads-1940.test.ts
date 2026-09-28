/**
 * host-source-selected-reads-1940.test.ts — flair#1940 slice 1, round 12.
 *
 * Real-Harper coverage of the round-12 rule: on a non-admin `Memory.get` /
 * `Memory.search`, the pointer decision reads the STORED row and the caller's
 * `select`/`property` shapes only the OUTPUT. Two shapes are exercised over
 * REST against a spawned Harper:
 *   t1  a COLLECTION GET whose selection omits `archived`, against an ARCHIVED
 *       shared row whose pointer is bound: it must render nothing, exactly like
 *       the full-row read;
 *   t2  the BY-ID scalar selection Harper supports, against a row carrying an
 *       UNBOUND inline pointer: it must return no value; the same scalar read of
 *       a BOUND pointer by its author returns the gated pointer.
 * Response bodies are quoted in the assertions' failure messages / the logs.
 *
 * Raw `insert` via the ops API seeds the rows, so a supported write path cannot
 * rewrite the archived flag / inline field being probed.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
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
async function authFetch(harper: HarperInstance, agent: TestAgent, method: string, path: string): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, { method, headers: { Authorization: ed25519Header(agent, method, path) } });
}
async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}
async function seedAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status).toBe(200); // assertion: setup seeded the agent
}
async function insertRow(harper: HarperInstance, table: string, record: Record<string, any>): Promise<void> {
  const res = await adminOp(harper, { operation: "insert", database: "flair", table, records: [record] });
  expect(res.status, `raw insert of ${table}/${record.id} returned ${res.status}`).toBe(200);
}

let harper: HarperInstance;
const author = mkAgent("hsr-author");
const reader = mkAgent("hsr-reader");
const POINTER = { v: 1, host: "openclaw", kind: "run", id: "run-r12aaaa" };
const CANON = JSON.stringify(POINTER);

const idArchived = "hsr-archived-shared";       // t1: archived, bound pointer
const idUnbound = "hsr-inline-unbound";         // t2a: inline hostSource, no pointer row
const idBound = "hsr-bound-author";             // t2b: bound pointer, no inline field
const idPrivate = "hsr-private-other";          // round 14 t5: private, owned by `author`
const idClean = "hsr-clean-shared";             // round 14 t6/t7: clean shared row

beforeAll(async () => {
  harper = await startHarper();
  await seedAgent(harper, author);
  await seedAgent(harper, reader);

  const tokArchived = randomUUID();
  const tokUnbound = randomUUID();
  const tokBound = randomUUID();
  await insertRow(harper, "Memory", {
    id: idArchived, agentId: author.id, content: "archived shared note", contentHash: "h",
    visibility: "shared", archived: true, instanceToken: tokArchived, createdAt: new Date().toISOString(),
  });
  await insertRow(harper, "MemoryHostSource", {
    memoryId: idArchived, hostSource: CANON, scopeAtWrite: "shared",
    authorId: author.id, memoryInstanceToken: tokArchived, receivedAt: new Date().toISOString(),
  });

  await insertRow(harper, "Memory", {
    id: idUnbound, agentId: author.id, content: "inline pointer note", contentHash: "h",
    visibility: "shared", archived: false, hostSource: CANON, instanceToken: tokUnbound, createdAt: new Date().toISOString(),
  });

  await insertRow(harper, "Memory", {
    id: idBound, agentId: author.id, content: "bound pointer note", contentHash: "h",
    visibility: "shared", archived: false, instanceToken: tokBound, createdAt: new Date().toISOString(),
  });
  await insertRow(harper, "MemoryHostSource", {
    memoryId: idBound, hostSource: CANON, scopeAtWrite: "shared",
    authorId: author.id, memoryInstanceToken: tokBound, receivedAt: new Date().toISOString(),
  });

  await insertRow(harper, "Memory", {
    id: idPrivate, agentId: author.id, content: "author private note", contentHash: "h",
    visibility: "private", archived: false, instanceToken: randomUUID(), createdAt: new Date().toISOString(),
  });

  await insertRow(harper, "Memory", {
    id: idClean, agentId: author.id, content: "clean body", contentHash: "h",
    visibility: "shared", archived: false, instanceToken: randomUUID(), createdAt: new Date().toISOString(),
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
});

describe("flair#1940 round 12 — selected reads decide on the stored row (real Harper, REST)", () => {
  it("t1: a collection select that OMITS `archived` renders no pointer for an ARCHIVED row", async () => {
    const path = "/Memory/?select(id,agentId,instanceToken,visibility,hostSource)";
    const res = await authFetch(harper, reader, "GET", path);
    const body = await res.text();
    console.log("t1 body:", body);
    expect(res.status).toBe(200); // assertion: the collection read succeeded
    const rows = JSON.parse(body) as any[];
    const archived = rows.find((r) => r.id === idArchived);
    expect(archived).toBeDefined(); // assertion: the archived shared row WAS returned
    expect(archived.hostSource).toBeUndefined(); // assertion: no pointer, though the selection omitted `archived`
    // Positive control in the same response: a NON-archived bound row IS rendered.
    const bound = rows.find((r) => r.id === idBound);
    expect(bound?.hostSource).toEqual(POINTER); // assertion: the selection does not suppress a live pointer
  }, 30_000);

  it("t1-ctrl: the FULL-row collection read of the archived row renders no pointer either", async () => {
    const res = await authFetch(harper, reader, "GET", "/Memory/");
    const body = await res.text();
    const row = (JSON.parse(body) as any[]).find((r) => r.id === idArchived);
    expect(row).toBeDefined(); // assertion: the archived shared row was returned
    expect(row.hostSource).toBeUndefined(); // assertion: the full-row read renders nothing
  }, 30_000);

  it("t2: the by-id scalar select of hostSource returns no value on an UNBOUND inline pointer", async () => {
    const res = await authFetch(harper, reader, "GET", `/Memory/${idUnbound}?select(hostSource)`);
    const body = await res.text();
    console.log("t2 unbound body:", JSON.stringify(body), "status:", res.status);
    expect(body.trim()).toBe(""); // assertion: no value returned
    expect(body).not.toContain(POINTER.id); // assertion: the raw inline pointer did not leak
  }, 30_000);

  it("t2b: the same scalar select of a BOUND pointer by its author returns the gated pointer", async () => {
    const res = await authFetch(harper, author, "GET", `/Memory/${idBound}?select(hostSource)`);
    const body = await res.text();
    console.log("t2b bound body:", body, "status:", res.status);
    expect(res.status).toBe(200); // assertion: the author's scalar read succeeded
    expect(body).toContain(POINTER.id); // assertion: the gated pointer is rendered
  }, 30_000);
});

describe("flair#1940 round 14 — REST selection validation and clean-row parity (real Harper, REST)", () => {
  it("t5: an unsupported REST selection is refused 400 BEFORE the scope pre-read (not 404)", async () => {
    // A PRIVATE row owned by another agent would make the middleware's scope
    // pre-read answer 404. A 400 here proves the middleware validated Harper's
    // parsed `?select(*)` selection and refused it BEFORE any Memory read — the
    // ordering fix for the pre-read. (If the pre-read ran first, this would be
    // the 404 the t5-ctrl control below shows.)
    const res = await authFetch(harper, reader, "GET", `/Memory/${idPrivate}?select(*)`);
    const body = await res.text();
    console.log("t5 body:", body, "status:", res.status);
    expect(res.status).toBe(400); // assertion: the selection refusal, NOT the pre-read's 404
  }, 30_000);

  it("t5-ctrl: a SUPPORTED selection on that private row still reaches the scope pre-read (404)", async () => {
    const res = await authFetch(harper, reader, "GET", `/Memory/${idPrivate}?select(content)`);
    const body = await res.text();
    console.log("t5-ctrl body:", body, "status:", res.status);
    expect(res.status).toBe(404); // assertion: the private row is denied by the scope pre-read
  }, 30_000);

  it("t6: a clean-row array select with a missing key matches Harper's shape", async () => {
    const res = await authFetch(harper, reader, "GET", `/Memory/${idClean}?select(content,noSuchField)`);
    const body = await res.text();
    console.log("t6 body:", body, "status:", res.status);
    expect(res.status).toBe(200); // assertion: the read succeeded
    const row = JSON.parse(body);
    expect(row.content).toBe("clean body"); // assertion: the present key keeps its value
    expect("noSuchField" in row).toBe(false); // assertion: a missing key serializes away (undefined, not null)
  }, 30_000);

  it("t7: a clean-row array select returns an object with the named keys", async () => {
    const res = await authFetch(harper, reader, "GET", `/Memory/${idClean}?select(content,agentId)`);
    const body = await res.text();
    console.log("t7 body:", body, "status:", res.status);
    expect(res.status).toBe(200); // assertion: the read succeeded
    const row = JSON.parse(body);
    expect(row).toEqual({ content: "clean body", agentId: author.id }); // assertion: the array-of-names shape
  }, 30_000);
});
