/**
 * host-pointer-negatives-1940.test.ts — flair#1940 slice A (A1-iv), real-Harper
 * coverage of the host pointer's negative cases.
 *
 * A host pointer lives in its OWN table (MemoryHostSource), keyed by the memory
 * id, and reaches a non-admin reader only through the gated join in
 * resources/host-source-visibility.ts. The join returns the pointer (or
 * "withheld") only when the pointer row's `authorId` is the row's current
 * `agentId`, the pointer row's `memoryInstanceToken` equals the row's
 * server-stamped `instanceToken`, and the row is not archived. Every test below
 * seeds or writes real rows against a real Harper and asserts on what a READ
 * returns.
 *
 *   n1a  a write body's own instanceToken never becomes the stored token;
 *   n1b  a pointer whose stored token does not match its Memory row is not
 *        returned (and one that matches IS — the control);
 *   n2   an author-only pointer on another agent's memory is withheld from a
 *        reader, and shown to the author;
 *   n3   after the Memory row is deleted (its pointer row left behind) the id
 *        returns no record and no pointer;
 *   n4   after a same-id replace the OLD pointer row is not returned for the new
 *        row, and a re-bound pointer is (the control);
 *   n5   a PATCH keeps the stored token, so the pointer stays attached.
 *
 * Memory rows a supported write can produce are written through POST /Memory.
 * Where a test needs a state no supported write can produce (a pointer row whose
 * token does not match, a Memory row removed while its pointer row stays), the ops
 * API places or alters it. No product code is changed.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

interface TestAgent {
  id: string;
  publicKey: string;
  secretKey: Uint8Array;
}

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function ed25519Header(a: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const sig = nacl.sign.detached(
    new TextEncoder().encode(`${a.id}:${ts}:${nonce}:${method}:${path}`),
    a.secretKey,
  );
  return `TPS-Ed25519 ${a.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

let harper: HarperInstance;
const author = mkAgent("hpneg-author");
const reader = mkAgent("hpneg-reader");
const other = mkAgent("hpneg-other");
const POINTER = { v: 1, host: "openclaw", kind: "run", id: "run-neg1aaaa" };

function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}`,
    },
    body: JSON.stringify(op),
  });
}

async function seedAgent(a: TestAgent, role = "agent"): Promise<void> {
  const res = await adminOp({
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [{ id: a.id, name: a.id, role, publicKey: a.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `seed Agent/${a.id} returned ${res.status}`).toBe(200);
}

async function insertRow(table: string, record: Record<string, any>): Promise<void> {
  const res = await adminOp({ operation: "insert", database: "flair", table, records: [record] });
  expect(res.status, `raw insert of ${table}/${record.id ?? record.memoryId} returned ${res.status}`).toBe(200);
}

async function updateRow(table: string, record: Record<string, any>): Promise<void> {
  const res = await adminOp({ operation: "update", database: "flair", table, records: [record] });
  expect(res.status, `raw update of ${table}/${record.id ?? record.memoryId} returned ${res.status}`).toBe(200);
}

async function deleteRow(table: string, id: string): Promise<void> {
  const res = await adminOp({ operation: "delete", database: "flair", table, ids: [id] });
  expect(res.status, `raw delete of ${table}/${id} returned ${res.status}`).toBe(200);
}

/** Read one row by id with the ops API (the named operator path). */
async function readRow(table: string, id: string): Promise<any | null> {
  const res = await adminOp({
    operation: "search_by_id",
    database: "flair",
    table,
    ids: [id],
    get_attributes: ["*"],
  });
  expect(res.status).toBe(200);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/** Read the pointer row (keyed by memoryId) with the ops API. */
async function readPointerRow(memoryId: string): Promise<any | null> {
  const res = await adminOp({
    operation: "search_by_value",
    database: "flair",
    table: "MemoryHostSource",
    search_attribute: "memoryId",
    search_type: "equals",
    search_value: memoryId,
    get_attributes: ["*"],
  });
  expect(res.status).toBe(200);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/** Any verb, signed as `a` (TPS-Ed25519 over method:path). */
async function reqAs(a: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: {
      Authorization: ed25519Header(a, method, path),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** The status and parsed body of a gated Memory read (the join's output). */
async function readMemoryAs(a: TestAgent, id: string): Promise<{ status: number; body: any }> {
  const res = await reqAs(a, "GET", `/Memory/${id}`);
  const text = await res.text();
  let body: any;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

beforeAll(async () => {
  harper = await startHarper();
  await seedAgent(author);
  await seedAgent(reader);
  await seedAgent(other);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
});

describe("flair#1940 A1-iv — host pointer negative cases (real Harper)", () => {
  it("n1a: a write that supplies its own instanceToken does not change the stored token", async () => {
    const id = "hpneg-n1a";
    const create = await reqAs(author, "POST", "/Memory", {
      id,
      agentId: author.id,
      content: "n1a body",
      visibility: "shared",
      hostSource: POINTER,
      hostSourceScope: "record",
    });
    expect(create.ok, `create returned ${create.status}`).toBe(true);
    const before = await readRow("Memory", id);
    expect(typeof before.instanceToken).toBe("string");

    const forgedToken = "forged-instance-token-n1a";
    const put = await reqAs(author, "PUT", `/Memory/${id}`, {
      id,
      agentId: author.id,
      content: "n1a updated",
      visibility: "shared",
      instanceToken: forgedToken,
    });
    expect(put.ok, `put returned ${put.status}`).toBe(true);

    const after = await readRow("Memory", id);
    expect(after.instanceToken).toBe(before.instanceToken);
    expect(after.instanceToken).not.toBe(forgedToken);

    const read = await readMemoryAs(author, id);
    expect(read.body.hostSource).toEqual(POINTER);
  }, 60_000);

  it("n1b: a pointer whose stored token does not match its row's token is not returned", async () => {
    const id = "hpneg-n1b";
    await insertRow("Memory", {
      id,
      agentId: author.id,
      content: "n1b body",
      contentHash: "h",
      visibility: "shared",
      archived: false,
      instanceToken: "inst-real-n1b",
      createdAt: new Date().toISOString(),
    });
    await insertRow("MemoryHostSource", {
      memoryId: id,
      hostSource: JSON.stringify(POINTER),
      scopeAtWrite: "shared",
      authorId: author.id,
      memoryInstanceToken: "inst-forged-n1b",
      receivedAt: new Date().toISOString(),
    });

    const mismatch = await readMemoryAs(author, id);
    expect(mismatch.status).toBe(200);
    expect(mismatch.body.hostSource).toBeUndefined();

    await updateRow("MemoryHostSource", { memoryId: id, memoryInstanceToken: "inst-real-n1b" });
    const matched = await readMemoryAs(author, id);
    expect(matched.status).toBe(200);
    expect(matched.body.hostSource).toEqual(POINTER);
  }, 60_000);

  it("n2: an author-only pointer on another agent's memory is withheld from a reader", async () => {
    const id = "hpneg-n2";
    const create = await reqAs(other, "POST", "/Memory", {
      id,
      agentId: other.id,
      content: "n2 body",
      visibility: "shared",
      hostSource: POINTER,
    });
    expect(create.ok, `create returned ${create.status}`).toBe(true);

    const asReader = await readMemoryAs(reader, id);
    expect(asReader.status).toBe(200);
    expect(asReader.body.hostSource).toBe("withheld");

    const asAuthor = await readMemoryAs(other, id);
    expect(asAuthor.status).toBe(200);
    expect(asAuthor.body.hostSource).toEqual(POINTER);
  }, 60_000);

  it("n3: after the memory row is deleted its pointer is not returned", async () => {
    const id = "hpneg-n3";
    const create = await reqAs(author, "POST", "/Memory", {
      id,
      agentId: author.id,
      content: "n3 body",
      visibility: "shared",
      hostSource: POINTER,
      hostSourceScope: "record",
    });
    expect(create.ok, `create returned ${create.status}`).toBe(true);
    const attached = await readMemoryAs(author, id);
    expect(attached.body.hostSource).toEqual(POINTER);

    // Remove ONLY the Memory row, leaving the pointer row: the design's
    // cleanup-hygiene case (cleanup may lag, so the read join refuses a pointer
    // whose Memory row is gone).
    await deleteRow("Memory", id);
    expect(await readPointerRow(id)).not.toBeNull();

    const afterDelete = await readMemoryAs(author, id);
    expect(afterDelete.status).toBe(404);
  }, 60_000);

  it("n4: after a same-id replace the old pointer is not returned for the new row", async () => {
    const id = "hpneg-n4";
    const create = await reqAs(author, "POST", "/Memory", {
      id,
      agentId: author.id,
      content: "n4 old body",
      visibility: "shared",
      hostSource: POINTER,
      hostSourceScope: "record",
    });
    expect(create.ok, `create returned ${create.status}`).toBe(true);
    const oldToken = (await readRow("Memory", id)).instanceToken;

    // Replace: the old Memory row dies and its pointer row survives, then a NEW
    // row is created for the same id with a fresh incarnation token.
    await deleteRow("Memory", id);
    const recreate = await reqAs(author, "POST", "/Memory", {
      id,
      agentId: author.id,
      content: "n4 new body",
      visibility: "shared",
    });
    expect(recreate.ok, `recreate returned ${recreate.status}`).toBe(true);
    const newToken = (await readRow("Memory", id)).instanceToken;
    expect(newToken).not.toBe(oldToken);

    const stale = await readPointerRow(id);
    expect(stale).not.toBeNull();
    expect(stale.memoryInstanceToken).toBe(oldToken);

    const read = await readMemoryAs(author, id);
    expect(read.status).toBe(200);
    expect(read.body.hostSource).toBeUndefined();

    // Control: re-bind the pointer row to the NEW row's token — the value is
    // returned, so the suppression above was the token mismatch.
    await updateRow("MemoryHostSource", { memoryId: id, memoryInstanceToken: newToken });
    const rebound = await readMemoryAs(author, id);
    expect(rebound.body.hostSource).toEqual(POINTER);
  }, 60_000);

  it("n5: a PATCH keeps the stored token, so the pointer stays attached", async () => {
    const id = "hpneg-n5";
    const create = await reqAs(author, "POST", "/Memory", {
      id,
      agentId: author.id,
      content: "n5 body",
      visibility: "shared",
      hostSource: POINTER,
      hostSourceScope: "record",
    });
    expect(create.ok, `create returned ${create.status}`).toBe(true);
    const token = (await readRow("Memory", id)).instanceToken;

    const patch = await reqAs(author, "PATCH", `/Memory/${id}`, {
      content: "n5 patched body",
      instanceToken: "forged-instance-token-n5",
    });
    expect(patch.ok, `patch returned ${patch.status}`).toBe(true);

    const after = await readRow("Memory", id);
    expect(after.instanceToken).toBe(token);
    expect(after.content).toBe("n5 patched body");

    const read = await readMemoryAs(author, id);
    expect(read.status).toBe(200);
    expect(read.body.hostSource).toEqual(POINTER);
  }, 60_000);
});
