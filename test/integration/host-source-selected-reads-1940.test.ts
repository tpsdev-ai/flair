/**
 * host-source-selected-reads-1940.test.ts — flair#1940 slice 1, round 15.
 *
 * Real-Harper coverage of the round-15 narrowed selection contract: on a
 * non-admin `Memory.get` / `Memory.search`, a selection is accepted ONLY as an
 * array of plain Memory schema attribute names. For an accepted array on a
 * clean row the handler output equals Harper's own select output (the same
 * attributes, in order); every other REST shape (`select(*)`, a scalar, an
 * unknown name, a trailing or doubled comma, a path property, ...) is refused
 * with 400 BEFORE the scope pre-read (never the pre-read's 404).
 *
 * Response bodies are quoted in the logs / assertion messages.
 *
 * Raw `insert` via the ops API seeds the rows, so a supported write path cannot
 * rewrite the flags / fields being probed.
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
const admin = mkAgent("hsr-admin");
const POINTER = { v: 1, host: "openclaw", kind: "run", id: "run-r12aaaa" };
const CANON = JSON.stringify(POINTER);

const idArchived = "hsr-archived-shared";       // t1: archived, bound pointer
const idUnbound = "hsr-inline-unbound";         // t2a: inline hostSource, no pointer row
const idBound = "hsr-bound-author";             // t2b: bound pointer, no inline field
const idPrivate = "hsr-private-other";          // round 14 t5: private, owned by `author`
const idClean = "hsr-clean-shared";             // round 15: clean shared row
let CLEAN_CREATED_AT = "";                      // the clean row's writer-supplied createdAt

beforeAll(async () => {
  harper = await startHarper();
  await seedAgent(harper, author);
  await seedAgent(harper, reader);
  // A role "admin" Agent, so a read through it takes the UNCHANGED admin branch
  // — Harper's own native select projection (the independent comparison for t7).
  const adminSeed = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: admin.id, name: admin.id, role: "admin", publicKey: admin.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(adminSeed.status).toBe(200); // assertion: setup seeded the admin agent

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

  CLEAN_CREATED_AT = new Date().toISOString();
  await insertRow(harper, "Memory", {
    id: idClean, agentId: author.id, content: "clean body", contentHash: "h",
    visibility: "shared", archived: false, instanceToken: randomUUID(), createdAt: CLEAN_CREATED_AT,
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
});

describe("flair#1940 round 15 — an accepted REST array equals Harper's own select; other shapes are 400 (real Harper, REST)", () => {
  it("t7: a clean-row accepted array equals Harper's own native select output", async () => {
    const res = await authFetch(harper, reader, "GET", `/Memory/${idClean}?select(content,createdAt)`);
    const body = await res.text();
    // The comparison is an ACTUAL native Harper read, not a value built by hand:
    // an admin read takes the unchanged branch, so Harper itself projects the
    // same row with the same select. The non-admin handler output must equal it.
    const native = await authFetch(harper, admin, "GET", `/Memory/${idClean}?select(content,createdAt)`);
    const nativeBody = await native.text();
    console.log("t7 handler body:", body, "| native Harper body:", nativeBody, "status:", res.status, native.status);
    expect(res.status).toBe(200); // assertion: the read succeeded
    expect(native.status).toBe(200); // assertion: the native admin read succeeded
    expect(body).toBe(nativeBody); // assertion: the handler output == Harper's OWN native select output
  }, 30_000);

  it("t6: a name not in the Memory schema is refused 400 over REST", async () => {
    const res = await authFetch(harper, reader, "GET", `/Memory/${idClean}?select(content,noSuchField)`);
    const body = await res.text();
    console.log("t6 body:", body, "status:", res.status);
    expect(res.status).toBe(400); // assertion: refused
  }, 30_000);

  it("t5: an unsupported REST selection is refused 400 BEFORE the scope pre-read (not 404)", async () => {
    // A PRIVATE row owned by another agent would make the middleware's scope
    // pre-read answer 404. A 400 here proves the middleware validated the
    // parsed `?select(*)` selection and refused it BEFORE any Memory read — the
    // ordering fix for the pre-read. (If the pre-read ran first, this would be
    // the 404 the t5-ctrl control below shows.)
    const res = await authFetch(harper, reader, "GET", `/Memory/${idPrivate}?select(*)`);
    const body = await res.text();
    console.log("t5 body:", body, "status:", res.status);
    expect(res.status).toBe(400); // assertion: the selection refusal, NOT the pre-read's 404
  }, 30_000);

  it("t5-ctrl: an ACCEPTED array selection on that private row still reaches the scope pre-read (404)", async () => {
    const res = await authFetch(harper, reader, "GET", `/Memory/${idPrivate}?select(content,agentId)`);
    const body = await res.text();
    console.log("t5-ctrl body:", body, "status:", res.status);
    expect(res.status).toBe(404); // assertion: the private row is denied by the scope pre-read
  }, 30_000);

  it("t2: a by-id SCALAR select is refused 400 over REST", async () => {
    const res = await authFetch(harper, reader, "GET", `/Memory/${idBound}?select(hostSource)`);
    const body = await res.text();
    console.log("t2 body:", body, "status:", res.status);
    expect(res.status).toBe(400); // assertion: a scalar selection is refused
  }, 30_000);

  it("t1: an accepted array on the archived shared row returns the named keys (collection read)", async () => {
    const res = await authFetch(harper, reader, "GET", "/Memory/?select(id,content)");
    const body = await res.text();
    console.log("t1 body:", body);
    expect(res.status).toBe(200); // assertion: the collection read succeeded
    const rows = JSON.parse(body) as any[];
    const archived = rows.find((r) => r.id === idArchived);
    expect(archived).toBeDefined(); // assertion: the archived shared row WAS returned
    expect(archived.content).toBe("archived shared note"); // assertion: the selected key is returned
    expect(archived.id).toBe(idArchived); // assertion: the selected key is returned
  }, 30_000);

  it("t1-ctrl: the FULL-row collection read of the archived row still returns it", async () => {
    const res = await authFetch(harper, reader, "GET", "/Memory/");
    const body = await res.text();
    const row = (JSON.parse(body) as any[]).find((r) => r.id === idArchived);
    expect(row).toBeDefined(); // assertion: the archived shared row was returned
    expect(row.content).toBe("archived shared note"); // assertion: the full-row read still works
  }, 30_000);
});
