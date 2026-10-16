// owner-scoped-writes.test.ts — the owner-scoped write guard, against a real
// Harper: a verified non-admin agent's addressed writes and collection
// PUT/PATCH/DELETE to owner-scoped tables served by table-extending resources.
//
// Middleware can return the owner refusal first on a plain addressed URL.
// If reached, the guard checks string or number body ids before stored ownership.
// Whichever check decides, it decides on the id Harper resolves from the
// request target (repeated or encoded slashes and dot segments included).
// Collection PUT/PATCH/DELETE is refused; collection POST follows the resource.
//
// Each refusal case asserts three things: the status is 403, the body is
// exactly the named refusal (it carries nothing from the stored row), and the
// target row read afterwards deeply equals its earlier read (stored rows
// compared as parsed objects). An owned, addressed POST/PUT/PATCH whose JSON
// body does not parse is refused with 400 write_body_unreadable and leaves the
// row unchanged. Positive controls cover owner writes, collection and
// addressed creates, and administrator requests.
//
// Agents resolve to the least-privilege `flair-agent` user here, as they do in
// production (ensureFlairAgentRole/ensureFlairAgentUser), so the cases exercise
// the de-elevated role's real table grants.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { join } from "node:path";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";
import { OWNER_FIELDS } from "../../resources/record-owner-guard.js";
import { ownerScopedInventory, resourceClasses } from "../helpers/owner-scoped-resource-inventory";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

/** The path and query exactly as the auth middleware reconstructs them for the signature. */
function signedTarget(path: string): string {
  const u = new URL(path, "http://localhost");
  return `${u.pathname}${u.search}`;
}

function ed25519Header(a: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${a.id}:${ts}:${nonce}:${method}:${signedTarget(path)}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), a.secretKey);
  return `TPS-Ed25519 ${a.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

let harper: HarperInstance;
const owner = mkAgent("osw-owner");
const caller = mkAgent("osw-caller");
const adminAgent = mkAgent("osw-admin");
const NOW = new Date().toISOString();

async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}

/** The full stored row, read as the operator; null when absent. */
async function storedRow(table: string, pk: string, id: string): Promise<Record<string, any> | null> {
  const res = await adminOp({ operation: "search_by_value", database: "flair", table, search_attribute: pk, search_value: id, get_attributes: ["*"] });
  const rows = await res.json();
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

/** Every stored row whose `attr` equals `value`, read as the operator. */
async function rowsWhere(table: string, attr: string, value: string): Promise<Array<Record<string, any>>> {
  const res = await adminOp({ operation: "search_by_value", database: "flair", table, search_attribute: attr, search_value: value, get_attributes: ["*"] });
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function seed(table: string, rec: Record<string, any>): Promise<void> {
  const r = await adminOp({ operation: "upsert", database: "flair", table, records: [rec] });
  expect(r.status, `seed ${table} returned ${r.status}`).toBe(200);
}

async function send(a: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(a, method, path) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/**
 * One signed HTTP/1.1 request whose request target is sent byte for byte as
 * given. A client URL parser would merge or resolve some path forms before
 * sending; this does not, so the test controls the target Harper routes. The
 * signature covers the target as the auth middleware reconstructs it.
 */
async function sendRawTarget(a: TestAgent, method: string, target: string, body: unknown): Promise<{ status: number; text: string }> {
  const base = new URL(harper.httpURL);
  const payload = JSON.stringify(body);
  const head = [
    `${method} ${target} HTTP/1.1`,
    `Host: ${base.host}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(payload)}`,
    `Authorization: ${ed25519Header(a, method, target)}`,
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect(Number(base.port), base.hostname, () => socket.write(head + payload));
    socket.setTimeout(20_000, () => socket.destroy(new Error(`no response to ${method} ${target}`)));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks)));
    socket.on("error", reject);
  });
  const split = raw.indexOf("\r\n\r\n");
  expect(split, `malformed response to ${method} ${target}`).toBeGreaterThan(0);
  const headLines = raw.subarray(0, split).toString("latin1").split("\r\n");
  const status = Number(headLines[0].split(" ")[1]);
  let rest = raw.subarray(split + 4);
  if (headLines.some((l) => /^transfer-encoding:\s*chunked/i.test(l))) {
    const parts: Buffer[] = [];
    for (;;) {
      const lineEnd = rest.indexOf("\r\n");
      const size = parseInt(rest.subarray(0, lineEnd).toString("latin1"), 16);
      if (!size) break;
      parts.push(rest.subarray(lineEnd + 2, lineEnd + 2 + size));
      rest = rest.subarray(lineEnd + 2 + size + 2);
    }
    rest = Buffer.concat(parts);
  }
  return { status, text: rest.toString("utf8") };
}

/** A signed request whose body bytes are sent exactly as given, labelled as JSON. */
async function sendRaw(a: TestAgent, method: string, path: string, rawBody: string): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(a, method, path) },
    body: rawBody,
  });
}

/**
 * One owner-scoped table reachable over REST: how to build a valid row, which
 * field a write changes, and how its ids are formed.
 */
interface TableSpec {
  table: string;
  pk: string;
  mut: string;
  /** The owner can PATCH an ordinary field of its own row (false for tables whose own rule refuses it). */
  ownerPatchable: boolean;
  idFor: (n: string, ownerId: string) => string;
  row: (id: string, ownerId: string) => Record<string, any>;
}

const SPECS: TableSpec[] = [
  { table: "Memory", pk: "id", mut: "content", ownerPatchable: true, idFor: (n) => `osw-mem-${n}`,
    row: (id, o) => ({ id, agentId: o, content: "orig", durability: "persistent", createdAt: NOW, updatedAt: NOW }) },
  { table: "Relationship", pk: "id", mut: "object", ownerPatchable: true, idFor: (n) => `osw-rel-${n}`,
    row: (id, o) => ({ id, agentId: o, subject: "s", predicate: "p", object: "orig", createdAt: NOW }) },
  { table: "Soul", pk: "id", mut: "value", ownerPatchable: false, idFor: (n, o) => `${o}:osw-k${n}`,
    row: (id, o) => ({ id, agentId: o, key: id.slice(id.indexOf(":") + 1), value: "orig", durability: "permanent", createdAt: NOW, updatedAt: NOW }) },
  { table: "Credential", pk: "id", mut: "status", ownerPatchable: true, idFor: (n) => `osw-cred-${n}`,
    row: (id, o) => ({ id, principalId: o, kind: "bearer-token", status: "active", createdAt: NOW }) },
  { table: "Integration", pk: "id", mut: "username", ownerPatchable: true, idFor: (n) => `osw-integ-${n}`,
    row: (id, o) => ({ id, agentId: o, platform: "slack", username: "orig", createdAt: NOW }) },
  { table: "Asset", pk: "id", mut: "memoryId", ownerPatchable: true, idFor: (n) => `osw-asset-${n}`,
    row: (id, o) => ({ id, agentId: o, memoryId: "orig", contentType: "image/png", createdAt: NOW }) },
  { table: "MemoryCandidate", pk: "id", mut: "claim", ownerPatchable: true, idFor: (n) => `osw-cand-${n}`,
    row: (id, o) => ({ id, agentId: o, claim: "orig", generatedAt: NOW, status: "pending", createdAt: NOW }) },
  { table: "MemoryGrant", pk: "id", mut: "scope", ownerPatchable: true, idFor: (n) => `osw-grant-${n}`,
    row: (id, o) => ({ id, ownerId: o, granteeId: o, scope: "orig", createdAt: NOW }) },
  { table: "MemoryUsage", pk: "id", mut: "attribution", ownerPatchable: false, idFor: (n, o) => `${o}:osw-use${n}`,
    row: (id, o) => ({ id, agentId: o, memoryId: id.slice(id.indexOf(":") + 1), attribution: "orig", createdAt: NOW }) },
  { table: "Message", pk: "id", mut: "body", ownerPatchable: false, idFor: (n) => `osw-msg-${n}`,
    row: (id, o) => ({ id, from: o, to: "osw-recipient", kind: "text", body: "orig", state: "pending", createdAt: NOW }) },
  { table: "OrgEvent", pk: "id", mut: "summary", ownerPatchable: true, idFor: (n) => `osw-oe-${n}`,
    row: (id, o) => ({ id, authorId: o, kind: "k", summary: "orig", createdAt: NOW }) },
  { table: "WorkspaceState", pk: "id", mut: "ref", ownerPatchable: true, idFor: (n) => `osw-ws-${n}`,
    row: (id, o) => ({ id, agentId: o, ref: "orig", provider: "git", timestamp: NOW, createdAt: NOW }) },
  // Presence uses fresh ids for other rows and reuses caller.id for the caller's row.
  { table: "Presence", pk: "agentId", mut: "activity", ownerPatchable: true, idFor: (n) => `osw-presence-${n}`,
    row: (id) => ({ agentId: id, lastHeartbeatAt: Date.now(), activity: "orig" }) },
];

const ownerFieldOf = (s: TableSpec) => OWNER_FIELDS[s.table];
const ownerIsKey = (s: TableSpec) => ownerFieldOf(s) === s.pk;

const COLLECTION_REFUSAL = (t: string) => ({ error: `forbidden: a non-admin write to ${t} must address one record by its id` });
const RECORD_REFUSAL = (t: string) => ({ error: `forbidden: cannot modify ${t} owned by another principal` });

/** A write body for `row` with the ordinary field changed, the owner field kept or left out. */
function changed(s: TableSpec, row: Record<string, any>, ownerInBody: boolean): Record<string, any> {
  const body: Record<string, any> = { ...row, [s.mut]: "changed" };
  if (!ownerInBody && !ownerIsKey(s)) delete body[ownerFieldOf(s)];
  return body;
}

interface Fixture {
  s: TableSpec;
  /** A row owned by another principal (`owner`). */
  other: Record<string, any>;
  otherId: string;
  /** A row owned by the caller, in the same table. */
  mine: Record<string, any>;
  mineId: string;
}

interface Shape {
  label: string;
  refusal: "collection" | "record";
  /** Whether the request body carries the owner field (only shapes with a record body vary this). */
  ownerInBody?: boolean;
  /** Seed the other principal's row under an id containing a slash. */
  slashId?: boolean;
  /** The request also names the caller's own row, which must be left unchanged too. */
  namesOwnRow?: boolean;
  build: (f: Fixture, ownerInBody: boolean) => { method: string; path: string; body?: unknown };
}

const e = encodeURIComponent;
const SHAPES: Shape[] = [
  // ── Addressed to the collection: refused on PUT, PATCH and DELETE ─────────
  { label: "PUT to the collection with a list of records", refusal: "collection", ownerInBody: false,
    build: (f, o) => ({ method: "PUT", path: `/${f.s.table}/`, body: [changed(f.s, f.other, o)] }) },
  { label: "PUT to the collection with a list of records", refusal: "collection", ownerInBody: true,
    build: (f, o) => ({ method: "PUT", path: `/${f.s.table}/`, body: [changed(f.s, f.other, o)] }) },
  { label: "PUT to the collection path without a trailing slash", refusal: "collection", ownerInBody: false,
    build: (f, o) => ({ method: "PUT", path: `/${f.s.table}`, body: [changed(f.s, f.other, o)] }) },
  { label: "PUT to the collection path without a trailing slash", refusal: "collection", ownerInBody: true,
    build: (f, o) => ({ method: "PUT", path: `/${f.s.table}`, body: [changed(f.s, f.other, o)] }) },
  { label: "PUT to the collection with a list naming the caller's row and another's", refusal: "collection", ownerInBody: false, namesOwnRow: true,
    build: (f, o) => ({ method: "PUT", path: `/${f.s.table}/`, body: [changed(f.s, f.mine, true), changed(f.s, f.other, o)] }) },
  { label: "PUT to the collection with a list naming the caller's row and another's", refusal: "collection", ownerInBody: true, namesOwnRow: true,
    build: (f, o) => ({ method: "PUT", path: `/${f.s.table}/`, body: [changed(f.s, f.mine, true), changed(f.s, f.other, o)] }) },
  { label: "PUT to a collection under the caller's id with a list of records", refusal: "collection", ownerInBody: false,
    build: (f, o) => ({ method: "PUT", path: `/${f.s.table}/${e(f.mineId)}/`, body: [changed(f.s, f.other, o)] }) },
  { label: "PUT to a collection under the caller's id with a list of records", refusal: "collection", ownerInBody: true,
    build: (f, o) => ({ method: "PUT", path: `/${f.s.table}/${e(f.mineId)}/`, body: [changed(f.s, f.other, o)] }) },
  { label: "PUT to the collection with one record", refusal: "collection", ownerInBody: false,
    build: (f, o) => ({ method: "PUT", path: `/${f.s.table}/`, body: changed(f.s, f.other, o) }) },
  { label: "PUT to the collection with an id query", refusal: "collection", ownerInBody: false,
    build: (f, o) => ({ method: "PUT", path: `/${f.s.table}/?${f.s.pk}=${e(f.otherId)}`, body: changed(f.s, f.other, o) }) },
  { label: "PATCH to the collection with one record", refusal: "collection", ownerInBody: false,
    build: (f, o) => ({ method: "PATCH", path: `/${f.s.table}/`, body: changed(f.s, f.other, o) }) },
  { label: "PATCH to the collection with an id query", refusal: "collection",
    build: (f) => ({ method: "PATCH", path: `/${f.s.table}/?${f.s.pk}=${e(f.otherId)}`, body: { [f.s.mut]: "changed" } }) },
  { label: "DELETE from the collection with an id query", refusal: "collection",
    build: (f) => ({ method: "DELETE", path: `/${f.s.table}/?${f.s.pk}=${e(f.otherId)}` }) },
  { label: "DELETE from the collection with an owner query", refusal: "collection",
    build: (f) => ({ method: "DELETE", path: `/${f.s.table}/?${ownerFieldOf(f.s)}=${e(String(f.other[ownerFieldOf(f.s)]))}` }) },

  // ── Addressed to one record owned by another principal ────────────────────
  { label: "PATCH by id", refusal: "record",
    build: (f) => ({ method: "PATCH", path: `/${f.s.table}/${e(f.otherId)}`, body: { [f.s.mut]: "changed" } }) },
  { label: "PATCH by id with a format suffix", refusal: "record",
    build: (f) => ({ method: "PATCH", path: `/${f.s.table}/${e(f.otherId)}.json`, body: { [f.s.mut]: "changed" } }) },
  { label: "PATCH by id with an attribute suffix", refusal: "record",
    build: (f) => ({ method: "PATCH", path: `/${f.s.table}/${e(f.otherId)}.${f.s.mut}`, body: { [f.s.mut]: "changed" } }) },
  { label: "PUT by id with a format suffix", refusal: "record", ownerInBody: false,
    build: (f, o) => ({ method: "PUT", path: `/${f.s.table}/${e(f.otherId)}.json`, body: changed(f.s, f.other, o) }) },
  { label: "PUT by id with an attribute suffix", refusal: "record",
    build: (f) => ({ method: "PUT", path: `/${f.s.table}/${e(f.otherId)}.${f.s.mut}`, body: "changed" }) },
  { label: "POST by id with a format suffix", refusal: "record", ownerInBody: false,
    build: (f, o) => ({ method: "POST", path: `/${f.s.table}/${e(f.otherId)}.json`, body: changed(f.s, f.other, o) }) },
  { label: "DELETE by id with a format suffix", refusal: "record",
    build: (f) => ({ method: "DELETE", path: `/${f.s.table}/${e(f.otherId)}.json` }) },
  { label: "PATCH by an id that contains a slash", refusal: "record", slashId: true,
    build: (f) => ({ method: "PATCH", path: `/${f.s.table}/${f.otherId}`, body: { [f.s.mut]: "changed" } }) },
  { label: "DELETE by an id that contains a slash", refusal: "record", slashId: true,
    build: (f) => ({ method: "DELETE", path: `/${f.s.table}/${f.otherId}` }) },
];

let counter = 0;

/** Seed a row owned by another principal and one owned by the caller; return both. */
async function fixture(s: TableSpec, slashId = false): Promise<Fixture> {
  const n = `${++counter}-${randomUUID().slice(0, 6)}`;
  const baseId = s.idFor(n, owner.id);
  const otherId = slashId ? `${baseId}/x` : baseId;
  const other = s.row(otherId, ownerIsKey(s) ? otherId : owner.id);
  await seed(s.table, other);
  const mineId = ownerIsKey(s) ? caller.id : s.idFor(`mine-${n}`, caller.id);
  const mine = s.row(mineId, caller.id);
  await seed(s.table, mine);
  return { s, other, otherId, mine, mineId };
}

describe("owner-scoped writes: non-admin addressed writes and collection PUT/PATCH/DELETE", () => {
  beforeAll(async () => {
    harper = await startHarper();
    await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
    await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
    for (const a of [owner, caller]) {
      await seed("Agent", { id: a.id, name: a.id, role: "agent", admin: false, publicKey: a.publicKey, createdAt: NOW });
    }
    await seed("Agent", { id: adminAgent.id, name: adminAgent.id, role: "admin", publicKey: adminAgent.publicKey, createdAt: NOW });
  }, 240_000);

  afterAll(async () => { if (harper) await stopHarper(harper); }, HARPER_STOP_BUDGET_MS);

  for (const s of SPECS) {
    describe(s.table, () => {
      for (const shape of SHAPES) {
        const variant = shape.ownerInBody === undefined ? "" : shape.ownerInBody ? " (owner field in body)" : " (no owner field in body)";
        test(`${s.table}: ${shape.label}${variant} is refused with 403 and leaves the target row unchanged`, async () => {
          const f = await fixture(s, shape.slashId === true);
          const otherBefore = await storedRow(s.table, s.pk, f.otherId);
          const mineBefore = await storedRow(s.table, s.pk, f.mineId);
          expect(otherBefore, `${s.table} fixture row was not seeded`).not.toBeNull();

          const r = shape.build(f, shape.ownerInBody === true);
          const res = await send(caller, r.method, r.path, r.body);
          const text = await res.text();
          expect(res.status, `${r.method} ${r.path} returned ${res.status}: ${text.slice(0, 200)}`).toBe(403);
          const expected = shape.refusal === "collection" ? COLLECTION_REFUSAL(s.table) : RECORD_REFUSAL(s.table);
          expect(JSON.parse(text), `${r.method} ${r.path} answered with a different refusal`).toEqual(expected);

          expect(await storedRow(s.table, s.pk, f.otherId), `${s.table} row owned by another principal changed`).toEqual(otherBefore);
          if (shape.namesOwnRow) {
            expect(await storedRow(s.table, s.pk, f.mineId), `${s.table}: the caller's own row was written by a refused request`).toEqual(mineBefore);
          }
        }, 30_000);
      }
    });
  }

  for (const suffix of ["", ".json"]) {
    test(`Relationship: overlapping checks at a ${suffix ? "suffixed" : "plain"} address return the first refusal and preserve both rows`, async () => {
      const s = SPECS.find((spec) => spec.table === "Relationship")!;
      const f = await fixture(s);
      const addressedBefore = await storedRow(s.table, s.pk, f.otherId);
      const bodyBefore = await storedRow(s.table, s.pk, f.mineId);
      expect(addressedBefore).not.toBeNull();
      expect(bodyBefore).not.toBeNull();
      const res = await send(caller, "PATCH", `/Relationship/${e(f.otherId)}${suffix}`, {
        id: f.mineId, object: "changed",
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(suffix
        ? { error: "write_id_not_addressed", message: "a write may name only the record it addresses" }
        : RECORD_REFUSAL(s.table));
      expect(await storedRow(s.table, s.pk, f.otherId)).toEqual(addressedBefore);
      expect(await storedRow(s.table, s.pk, f.mineId)).toEqual(bodyBefore);
    }, 30_000);
  }

  // ── POSITIVE CONTROLS ─────────────────────────────────────────────────────
  describe("the caller's own records stay writable", () => {
    test("a PATCH to the caller's record by an id with a format suffix writes that record, even when a row literally named with the suffix belongs to someone else", async () => {
      // Harper reads `/Relationship/<r>.json` as record <r>. A distinct row whose
      // id is literally `<r>.json`, owned by another principal, must not decide
      // the write: the caller's own <r> is written and the other row is unchanged.
      const r = `osw-rel-sfx-${randomUUID().slice(0, 8)}`;
      const mine = { id: r, agentId: caller.id, subject: "s", predicate: "p", object: "orig", createdAt: NOW };
      const literal = { id: `${r}.json`, agentId: owner.id, subject: "s", predicate: "p", object: "orig", createdAt: NOW };
      await seed("Relationship", mine);
      await seed("Relationship", literal);
      const literalBefore = await storedRow("Relationship", "id", literal.id);
      const res = await send(caller, "PATCH", `/Relationship/${e(r)}.json`, { object: "via-suffix" });
      expect(res.status, `suffixed PATCH returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      expect((await storedRow("Relationship", "id", r))?.object, "the caller's own record was not written").toBe("via-suffix");
      expect(await storedRow("Relationship", "id", literal.id), "the literally suffixed row owned by another principal changed").toEqual(literalBefore);
    }, 30_000);

    for (const s of SPECS.filter((x) => x.ownerPatchable)) {
      test(`${s.table}: the caller's PATCH to its own record by id succeeds and persists`, async () => {
        const f = await fixture(s);
        const res = await send(caller, "PATCH", `/${s.table}/${e(f.mineId)}`, { [s.mut]: "mine-by-id" });
        expect(res.status, `${s.table} own PATCH returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
        expect((await storedRow(s.table, s.pk, f.mineId))?.[s.mut]).toBe("mine-by-id");
      }, 30_000);

      test(`${s.table}: the caller's PATCH to its own record by id with a format suffix succeeds and persists`, async () => {
        const f = await fixture(s);
        const res = await send(caller, "PATCH", `/${s.table}/${e(f.mineId)}.json`, { [s.mut]: "mine-by-suffix" });
        expect(res.status, `${s.table} own suffixed PATCH returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
        expect((await storedRow(s.table, s.pk, f.mineId))?.[s.mut]).toBe("mine-by-suffix");
      }, 30_000);
    }

    test("a non-admin PUT that creates a new record at its own id succeeds", async () => {
      const id = `osw-rel-new-${randomUUID().slice(0, 8)}`;
      const res = await send(caller, "PUT", `/Relationship/${e(id)}`, { id, agentId: caller.id, subject: "a", predicate: "b", object: "c" });
      expect(res.status, `create-by-PUT returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      expect((await storedRow("Relationship", "id", id))?.agentId).toBe(caller.id);
    }, 30_000);
  });

  describe("collection POST still creates records for the caller", () => {
    test("Memory: POST to the collection creates a record owned by the caller", async () => {
      const id = `osw-mem-post-${randomUUID().slice(0, 8)}`;
      const res = await send(caller, "POST", "/Memory/", { id, agentId: caller.id, content: "posted", durability: "standard" });
      expect(res.status, `Memory POST returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      expect((await storedRow("Memory", "id", id))?.agentId).toBe(caller.id);
    }, 30_000);

    test("Relationship: POST to the collection creates a record owned by the caller", async () => {
      const id = `osw-rel-post-${randomUUID().slice(0, 8)}`;
      const res = await send(caller, "POST", "/Relationship/", { id, subject: "x", predicate: "y", object: "z" });
      expect(res.status, `Relationship POST returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      expect((await storedRow("Relationship", "id", id))?.agentId).toBe(caller.id);
    }, 30_000);

    test("Presence: the caller's heartbeat POST still succeeds", async () => {
      const res = await send(caller, "POST", "/Presence", { agentId: caller.id, activity: "reviewing", currentTask: "heartbeat" });
      expect(res.status, `heartbeat returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      expect((await storedRow("Presence", "agentId", caller.id))?.activity).toBe("reviewing");
    }, 30_000);
  });

  // ── A string or number body id must name the addressed record ─────────────
  // A non-admin POST, PUT or PATCH addressed to an id the caller may write (a
  // fresh id, or for Presence the caller's own already-seeded id) whose string
  // or number body `id` names another principal's existing record is refused with the
  // named 403 write_id_not_addressed. Both rows are read back and must be
  // unchanged (deeply equal to their earlier reads): the addressed row (absent before and after for a
  // fresh id) and the record named only in the body. Driven over every SPECS
  // table.
  describe("a non-admin string or number body id must name the addressed record", () => {
    for (const s of SPECS) {
      for (const verb of ["PUT", "PATCH", "POST"] as const) {
        test(`${s.table}: a ${verb} whose string or number body id names another principal's record is refused with write_id_not_addressed`, async () => {
          const f = await fixture(s);
          const before = await storedRow(s.table, s.pk, f.otherId);
          expect(before, `${s.table} fixture row was not seeded`).not.toBeNull();
          // A fresh/own id the caller may address, distinct from the other principal's row.
          const freshId = ownerIsKey(s) ? caller.id : s.idFor(`addr-${randomUUID().slice(0, 6)}`, caller.id);
          const beforeFresh = await storedRow(s.table, s.pk, freshId);
          // Body names the OTHER principal's existing record; URL names freshId.
          const body: Record<string, any> = { ...s.row(f.otherId, caller.id), [s.mut]: "named-via-body" };
          body.id = f.otherId;
          if (!ownerIsKey(s)) body[ownerFieldOf(s)] = caller.id;
          const res = await send(caller, verb, `/${s.table}/${e(freshId)}`, body);
          const text = await res.text();
          expect(res.status, `${s.table} ${verb} body-id returned ${res.status}: ${text.slice(0, 200)}`).toBe(403);
          expect(JSON.parse(text), `${s.table} ${verb} answered with a different refusal`).toEqual({ error: "write_id_not_addressed", message: "a write may name only the record it addresses" });
          expect(text).not.toContain(String(f.otherId));
          expect(text).not.toContain(String(freshId));
          // Read back BOTH rows: the body-named record and the addressed row
          // are each unchanged by the refused write.
          expect(await storedRow(s.table, s.pk, f.otherId), `${s.table}: the record named only in the body was written`).toEqual(before);
          if (freshId !== f.otherId) {
            expect(await storedRow(s.table, s.pk, freshId), `${s.table}: the refused ${verb} wrote the addressed id`).toEqual(beforeFresh);
          }
        }, 30_000);
      }
    }

    test("the owner's own PUT to its record by id, with a matching body id, still succeeds", async () => {
      const s = SPECS.find((x) => x.table === "Relationship")!;
      const id = `osw-rel-addr-ok-${randomUUID().slice(0, 8)}`;
      const res = await send(caller, "PUT", `/${s.table}/${e(id)}`, { id, agentId: caller.id, subject: "a", predicate: "b", object: "addressed" });
      expect(res.status, `addressed PUT returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      expect((await storedRow(s.table, "id", id))?.object).toBe("addressed");
    }, 30_000);

    test("OrgEvent: the owner's own PUT with a matching body id still succeeds", async () => {
      const id = `osw-oe-addr-ok-${randomUUID().slice(0, 8)}`;
      const seedRes = await send(caller, "POST", "/OrgEvent/", { id, authorId: caller.id, kind: "k", summary: "orig" });
      expect(seedRes.status, `OrgEvent seed POST returned ${seedRes.status}: ${await seedRes.text()}`).toBeLessThan(300);
      const seeded = await storedRow("OrgEvent", "id", id);
      expect(seeded?.createdAt, "the seed POST did not store a createdAt").toBeTruthy();
      // The server assigned createdAt on create and keeps it on update
      // (resources/org-event-created-at.ts), so the update body omits it.
      const res = await send(caller, "PUT", `/OrgEvent/${e(id)}`, { id, authorId: caller.id, kind: "k", summary: "updated" });
      expect(res.status, `OrgEvent addressed PUT returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      const updated = await storedRow("OrgEvent", "id", id);
      expect(updated?.summary).toBe("updated");
      expect(updated?.createdAt, "the owner's update changed the stored createdAt").toBe(seeded?.createdAt);
    }, 30_000);

    test("OrgEvent: an addressed POST with no body id writes the addressed record and no other", async () => {
      const addressed = `osw-oe-addrpost-${randomUUID().slice(0, 8)}`;
      const kind = `osw-kind-${randomUUID().slice(0, 8)}`;
      expect(await storedRow("OrgEvent", "id", addressed), "the addressed id must start empty").toBeNull();
      const res = await send(caller, "POST", `/OrgEvent/${e(addressed)}`, { kind, summary: "addressed-no-id" });
      expect(res.status, `addressed OrgEvent POST returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      // Read back both ids: the addressed id holds the caller's event, and no
      // other id (such as a generated one) received a row from this request.
      const row = await storedRow("OrgEvent", "id", addressed);
      expect(row?.authorId, "the addressed id did not receive the event").toBe(caller.id);
      expect(row?.kind).toBe(kind);
      expect((await rowsWhere("OrgEvent", "kind", kind)).map((r) => r.id), "the request wrote an id other than the addressed one").toEqual([addressed]);
    }, 30_000);

    test("OrgEvent: an addressed POST whose numeric body id equals the address writes the addressed record and no other", async () => {
      // `/OrgEvent/0` with `{"id": 0}`: a number body id whose text matches the
      // address is bound to it, so the write lands on the addressed id, not elsewhere.
      const kind = `osw-kind-${randomUUID().slice(0, 8)}`;
      expect(await storedRow("OrgEvent", "id", "0"), "the addressed id must start empty").toBeNull();
      const res = await send(caller, "POST", "/OrgEvent/0", { id: 0, kind, summary: "addressed-numeric-id" });
      expect(res.status, `addressed OrgEvent POST returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      const row = await storedRow("OrgEvent", "id", "0");
      expect(row?.authorId, "the addressed id did not receive the event").toBe(caller.id);
      expect(row?.kind).toBe(kind);
      expect((await rowsWhere("OrgEvent", "kind", kind)).map((r) => r.id), "the request wrote an id other than the addressed one").toEqual(["0"]);
    }, 30_000);

    test("OrgEvent: a root collection POST with no body id writes a generated id", async () => {
      const kind = `osw-kind-${randomUUID().slice(0, 8)}`;
      const res = await send(caller, "POST", "/OrgEvent/", { kind, summary: "collection-no-id" });
      expect(res.status, `collection OrgEvent POST returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      const rows = await rowsWhere("OrgEvent", "kind", kind);
      expect(rows.length).toBe(1);
      expect(rows[0].authorId).toBe(caller.id);
      expect(String(rows[0].id).startsWith(`${caller.id}-`), "a root collection POST with no body id writes a generated id").toBe(true);
    }, 30_000);

    test("OrgEvent: a prefixed collection POST with no body id writes the target id", async () => {
      const prefix = `osw-prefix-${randomUUID().slice(0, 8)}`;
      const kind = `osw-kind-${randomUUID().slice(0, 8)}`;
      const res = await send(caller, "POST", `/OrgEvent/${prefix}/`, { kind, summary: "prefixed-collection" });
      expect(res.status, `prefixed collection POST returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      const rows = await rowsWhere("OrgEvent", "kind", kind);
      expect(rows.map((row) => row.id)).toEqual([`${prefix}/`]);
      expect(rows[0].authorId).toBe(caller.id);
    }, 30_000);

    test("Memory: an addressed POST with no body id writes the addressed record and no other", async () => {
      const addressed = `osw-mem-addrpost-noid-${randomUUID().slice(0, 8)}`;
      const content = `osw-addressed-no-id-${randomUUID().slice(0, 8)}`;
      expect(await storedRow("Memory", "id", addressed), "the addressed id must start empty").toBeNull();
      const res = await send(caller, "POST", `/Memory/${e(addressed)}`, { agentId: caller.id, content, durability: "standard" });
      expect(res.status, `addressed Memory POST returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      const row = await storedRow("Memory", "id", addressed);
      expect(row?.agentId, "the addressed id did not receive the memory").toBe(caller.id);
      expect(row?.content).toBe(content);
      const written = (await rowsWhere("Memory", "agentId", caller.id)).filter((r) => r.content === content);
      expect(written.map((r) => r.id), "the request wrote an id other than the addressed one").toEqual([addressed]);
    }, 30_000);

    test("an addressed POST whose body id matches the URL writes the addressed record and no other", async () => {
      const id = `osw-mem-addrpost-${randomUUID().slice(0, 8)}`;
      const content = `osw-addressed-matching-id-${randomUUID().slice(0, 8)}`;
      const res = await send(caller, "POST", `/Memory/${e(id)}`, { id, agentId: caller.id, content, durability: "standard" });
      expect(res.status, `addressed POST returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      expect((await storedRow("Memory", "id", id))?.agentId).toBe(caller.id);
      const written = (await rowsWhere("Memory", "agentId", caller.id)).filter((r) => r.content === content);
      expect(written.map((r) => r.id), "the request wrote an id other than the addressed one").toEqual([id]);
    }, 30_000);
  });

  // ── A malformed JSON body on an owned, addressed write ────────────────────
  // A non-admin POST, PUT or PATCH addressed to the caller's own OrgEvent, sent
  // through real Harper HTTP with a body labelled JSON that does not parse, is
  // refused with the guard's 400 write_body_unreadable and the row is unchanged.
  // The same caller, verb and address with a well-formed body then writes the
  // row, so the refusal comes from the body alone.
  describe("a non-admin addressed write whose JSON body does not parse fails closed", () => {
    const MALFORMED_JSON = `{"summary":"changed",`;
    for (const verb of ["POST", "PUT", "PATCH"] as const) {
      test(`OrgEvent: an owned, addressed ${verb} with a malformed JSON body is refused with 400 write_body_unreadable and leaves the row unchanged`, async () => {
        const s = SPECS.find((x) => x.table === "OrgEvent")!;
        const f = await fixture(s);
        const path = `/${s.table}/${e(f.mineId)}`;
        const before = await storedRow(s.table, s.pk, f.mineId);
        expect(before?.authorId, "the caller's own OrgEvent was not seeded").toBe(caller.id);

        const res = await sendRaw(caller, verb, path, MALFORMED_JSON);
        const text = await res.text();
        expect(res.status, `${verb} ${path} returned ${res.status}: ${text.slice(0, 200)}`).toBe(400);
        expect(JSON.parse(text), `${verb} ${path} answered with a different refusal`).toEqual({
          error: "write_body_unreadable",
          message: "the OrgEvent write's body could not be read, so the record it names could not be checked",
        });
        expect(await storedRow(s.table, s.pk, f.mineId), `the refused ${verb} changed the caller's row`).toEqual(before);

        // Positive control. The body omits createdAt: the stored value is kept.
        const { createdAt: _kept, ...mine } = f.mine;
        const wellFormed = verb === "PATCH" ? { summary: "well-formed" } : { ...mine, summary: "well-formed" };
        const ok = await send(caller, verb, path, wellFormed);
        expect(ok.status, `well-formed ${verb} ${path} returned ${ok.status}: ${await ok.text()}`).toBeLessThan(300);
        expect((await storedRow(s.table, s.pk, f.mineId))?.summary, `the well-formed ${verb} did not write the caller's row`).toBe("well-formed");
      }, 30_000);
    }
  });

  // ── The decision follows the id Harper resolves from the request target ───
  // Each request target below is sent byte for byte. Harper resolves it to a
  // record id (`resolved`) that differs from the plain id `r`. Two rows exist:
  // `r` and the resolved id, each owned by a different principal. A caller that
  // owns the resolved row writes it, and only it; a caller that owns `r` but
  // not the resolved row is refused with the owner refusal. Both rows are read
  // back in every case.
  describe("an addressed write is decided on the id Harper resolves from the request target", () => {
    const FORMS = [
      { label: "a repeated slash before the id", target: (r: string) => `/Relationship//${r}`, resolved: (r: string) => `/${r}` },
      { label: "a percent-encoded slash before the id", target: (r: string) => `/Relationship/%2F${r}`, resolved: (r: string) => `/${r}` },
      { label: "a dot segment in the path", target: (r: string) => `/Relationship/${r}-x/../${r}`, resolved: (r: string) => `${r}-x/../${r}` },
    ];
    const rel = (id: string, agentId: string) => ({ id, agentId, subject: "s", predicate: "p", object: "orig", createdAt: NOW });

    for (const form of FORMS) {
      for (const verb of ["PATCH", "PUT"] as const) {
        test(`Relationship: the caller's ${verb} through ${form.label} writes the caller's resolved row and leaves another principal's row r unchanged`, async () => {
          const r = `osw-rel-tgt-${randomUUID().slice(0, 8)}`;
          const resolved = form.resolved(r);
          await seed("Relationship", rel(r, owner.id));
          await seed("Relationship", rel(resolved, caller.id));
          const otherBefore = await storedRow("Relationship", "id", r);
          expect(otherBefore?.agentId).toBe(owner.id);

          const object = `via-${verb.toLowerCase()}-${randomUUID().slice(0, 6)}`;
          const body = verb === "PATCH" ? { object } : { id: resolved, agentId: caller.id, subject: "s", predicate: "p", object };
          const res = await sendRawTarget(caller, verb, form.target(r), body);
          expect(res.status, `${verb} ${form.target(r)} returned ${res.status}: ${res.text.slice(0, 200)}`).toBeLessThan(300);

          const mine = await storedRow("Relationship", "id", resolved);
          expect(mine?.object, "the caller's resolved row was not written").toBe(object);
          expect(mine?.agentId).toBe(caller.id);
          expect(await storedRow("Relationship", "id", r), "another principal's row r changed").toEqual(otherBefore);
          const written = (await rowsWhere("Relationship", "object", object)).map((row) => row.id);
          expect(written, "the write reached a row other than the resolved one").toEqual([resolved]);
        }, 30_000);
      }

      test(`Relationship: a PATCH through ${form.label} to a resolved row owned by another principal is refused, even when the caller owns r`, async () => {
        const r = `osw-rel-tgt-${randomUUID().slice(0, 8)}`;
        const resolved = form.resolved(r);
        await seed("Relationship", rel(r, caller.id));
        await seed("Relationship", rel(resolved, owner.id));
        const mineBefore = await storedRow("Relationship", "id", r);
        const otherBefore = await storedRow("Relationship", "id", resolved);
        expect(otherBefore?.agentId).toBe(owner.id);

        const res = await sendRawTarget(caller, "PATCH", form.target(r), { object: "changed" });
        expect(res.status, `PATCH ${form.target(r)} returned ${res.status}: ${res.text.slice(0, 200)}`).toBe(403);
        expect(JSON.parse(res.text)).toEqual(RECORD_REFUSAL("Relationship"));
        expect(await storedRow("Relationship", "id", resolved), "another principal's resolved row changed").toEqual(otherBefore);
        expect(await storedRow("Relationship", "id", r), "the caller's row r changed").toEqual(mineBefore);
      }, 30_000);
    }
  });

  describe("administrator collection PUT and suffixed PATCH", () => {
    test("an admin agent's PUT to the collection with a list of records writes them", async () => {
      const a = `osw-rel-admin-a-${randomUUID().slice(0, 8)}`;
      const b = `osw-rel-admin-b-${randomUUID().slice(0, 8)}`;
      const rows = [a, b].map((id) => ({ id, agentId: owner.id, subject: "s", predicate: "p", object: "by-admin" }));
      const res = await send(adminAgent, "PUT", "/Relationship/", rows);
      expect(res.status, `admin collection PUT returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      for (const id of [a, b]) {
        const row = await storedRow("Relationship", "id", id);
        expect(row?.object).toBe("by-admin");
        expect(row?.agentId).toBe(owner.id);
      }
    }, 30_000);

    test("an admin agent's PATCH to another principal's record by id with a format suffix succeeds", async () => {
      const f = await fixture(SPECS.find((x) => x.table === "Relationship")!);
      const res = await send(adminAgent, "PATCH", `/Relationship/${e(f.otherId)}.json`, { object: "admin-edit" });
      expect(res.status, `admin suffixed PATCH returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      expect((await storedRow("Relationship", "id", f.otherId))?.object).toBe("admin-edit");
    }, 30_000);
  });

  // ── Coverage self-check ─────────────────────────────────────────────────────
  // Primary gate (no parsing): every OWNER_FIELDS table must either have a spec
  // above or be listed in NO_SPEC with the reason it has no table-backed route,
  // so a table added to OWNER_FIELDS fails here until it is accounted for.
  // Cross-check: test/helpers/owner-scoped-resource-inventory.ts reads which
  // resource classes extend which flair table (the `extends` forms listed in
  // its header); every table it finds extended must have a spec, every spec
  // must name a table it finds extended, and every class named after an
  // owner-scoped table that does not extend it must be in NO_SPEC.
  const NO_SPEC: Record<string, string> = {
    AgentReadPosition: "served by a custom Resource at /AgentReadPosition that applies its own owner rule in get()/post(); not table-backed",
    OAuthAuthCode: "no REST route; written by the OAuth flow in-process",
    OAuthToken: "no table-backed REST route; /OAuthToken is the OAuth token endpoint (resources/OAuth.ts)",
  };
  test("every OWNER_FIELDS table has a spec or a stated no-route reason", () => {
    const specced = new Set(SPECS.map((s) => s.table));
    const unaccounted = Object.keys(OWNER_FIELDS).filter((t) => !specced.has(t) && !(t in NO_SPEC));
    expect(unaccounted, "OWNER_FIELDS tables with neither a spec nor a stated reason").toEqual([]);
    expect(Object.keys(NO_SPEC).filter((t) => specced.has(t)), "a table is both specced and excepted").toEqual([]);
    expect(Object.keys(NO_SPEC).filter((t) => !(t in OWNER_FIELDS)), "an exception names a table outside OWNER_FIELDS").toEqual([]);
  });
  test("the resource classes that extend owner-scoped tables match the specs", () => {
    const RES = join(import.meta.dir, "..", "..", "resources");
    const inventory = ownerScopedInventory(resourceClasses(RES), Object.keys(OWNER_FIELDS));
    const covered = new Set(SPECS.map((s) => s.table));
    expect(inventory.tableExtending.filter((t) => !covered.has(t)), "table-extending owner-scoped resource classes without a spec").toEqual([]);
    expect([...covered].filter((t) => !inventory.tableExtending.includes(t)), "a spec names a table no resource class was found to extend").toEqual([]);
    expect(inventory.customRoutes.map((c) => c.className).filter((n) => !(n in NO_SPEC)), "custom routes at an owner-scoped name without a stated reason").toEqual([]);
  });
});
