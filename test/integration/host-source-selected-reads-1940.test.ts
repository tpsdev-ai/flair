/**
 * host-source-selected-reads-1940.test.ts — flair#1940 slice 1, round 17.
 *
 * Real-Harper coverage of the round-17 contract: a non-admin HTTP Memory read
 * IGNORES the caller's `select(...)`/`property`. The auth middleware strips the
 * selection from the request URL before Harper parses it, so the read returns
 * the authorized, pointer-projected row — with EXACT gated values, not just
 * keys — for by-id and collection reads, and pagination still applies. An admin
 * read keeps its selection (control). Response bodies are quoted in the logs.
 *
 * Raw `insert` via the ops API seeds the rows, so a supported write path cannot
 * rewrite the fields being probed.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";

interface TestAgent {
  id: string;
  publicKey: string;
  secretKey: Uint8Array;
}

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
async function authFetch(
  harper: HarperInstance,
  agent: TestAgent,
  method: string,
  path: string,
): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(agent, method, path) },
  });
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
async function seedAgent(harper: HarperInstance, agent: TestAgent, role = "agent"): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [
      { id: agent.id, name: agent.id, role, publicKey: agent.publicKey, createdAt: new Date().toISOString() },
    ],
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
const POINTER = { v: 1, host: "openclaw", kind: "run", id: "run-r17aaaa" };
const CANON = JSON.stringify(POINTER);

const idFull = "hsr-full-shared"; // shared, bound pointer, hit stat
const idOther = "hsr-other-shared"; // shared, no pointer
const HIT_AT = "2026-03-01T00:00:00.000Z";

beforeAll(async () => {
  harper = await startHarper();
  await seedAgent(harper, author);
  await seedAgent(harper, reader);
  await seedAgent(harper, admin, "admin");

  const tok = randomUUID();
  await insertRow(harper, "Memory", {
    id: idFull, agentId: author.id, content: "full body", subject: "the subject",
    contentHash: "h", visibility: "shared", archived: false,
    instanceToken: tok, createdAt: "2026-01-01T00:00:00.000Z",
  });
  await insertRow(harper, "MemoryHostSource", {
    memoryId: idFull, hostSource: CANON, scopeAtWrite: "shared",
    authorId: author.id, memoryInstanceToken: tok, receivedAt: new Date().toISOString(),
  });
  await insertRow(harper, "Memory", {
    id: idOther, agentId: author.id, content: "other body", contentHash: "h",
    visibility: "shared", archived: false, instanceToken: randomUUID(),
    createdAt: "2026-02-01T00:00:00.000Z",
  });
  // A stored hit stat, so a read overlay is observable.
  await insertRow(harper, "MemoryHitStat", { id: idFull, retrievalCount: 7, lastRetrieved: HIT_AT });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
});

describe("flair#1940 round 17 — a non-admin Memory read ignores the caller's selection (real Harper, REST)", () => {
  it("by-id: a request WITH `select(content)` returns the FULL gated row (Harper cannot reapply it)", async () => {
    const res = await authFetch(harper, reader, "GET", `/Memory/${idFull}?select(content)`);
    const body = await res.json();
    console.log("by-id select body:", JSON.stringify(body), "status:", res.status);
    expect(res.status).toBe(200); // assertion: the read succeeded
    expect(body.content).toBe("full body"); // assertion: the requested field is there
    expect(body.agentId).toBe(author.id); // assertion: an UNselected field is present too (full row)
    expect(body.subject).toBe("the subject"); // assertion: full row
    expect(body.visibility).toBe("shared"); // assertion: full row
    expect(body.hostSource).toEqual(POINTER); // assertion: the exact gated pointer value
    expect(body.retrievalCount).toBe(7); // assertion: the stored hit stat is overlaid
  }, 30_000);

  it("by-id: a `.content` property suffix returns the FULL gated row", async () => {
    const res = await authFetch(harper, reader, "GET", `/Memory/${idFull}.content`);
    const body = await res.json();
    console.log("by-id property body:", JSON.stringify(body), "status:", res.status);
    expect(res.status).toBe(200); // assertion: the read succeeded
    expect(body.agentId).toBe(author.id); // assertion: the full row, not the single property
    expect(body.hostSource).toEqual(POINTER); // assertion: the gated pointer value
  }, 30_000);

  it("collection: a request WITH `select(id)` returns FULL rows, and limit still applies", async () => {
    const res = await authFetch(harper, reader, "GET", "/Memory/?select(id)&limit(0,1)&sort(createdAt)");
    const body = await res.json();
    console.log("collection select body:", JSON.stringify(body), "status:", res.status);
    expect(res.status).toBe(200); // assertion: the read succeeded
    expect(Array.isArray(body)).toBe(true); // assertion: a collection
    expect(body.length).toBe(1); // assertion: limit applied
    expect(body[0].id).toBe(idFull); // assertion: sort(createdAt) applied (oldest first)
    expect(body[0].content).toBe("full body"); // assertion: the FULL row, not the id-only selection
    expect(body[0].agentId).toBe(author.id); // assertion: an unselected field is present
    expect(body[0].hostSource).toEqual(POINTER); // assertion: the gated pointer value
    expect(body[0].retrievalCount).toBe(7); // assertion: the stored hit stat is overlaid
  }, 30_000);

  it("admin control: an admin read DOES honour its selection", async () => {
    const res = await authFetch(harper, admin, "GET", `/Memory/${idFull}?select(content)`);
    const body = await res.json();
    console.log("admin select body:", JSON.stringify(body), "status:", res.status);
    expect(res.status).toBe(200); // assertion: the read succeeded
    expect(body).toBe("full body"); // assertion: the admin selection IS applied (control: a scalar select of one attribute)
  }, 30_000);
});
