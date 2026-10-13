// owner-scoped-writes.test.ts — every non-admin write to an owner-scoped table is
// owner-checked for each record it writes, against a real Harper.
//
// The rule (resources/owner-scoped-write-policy.ts): for a verified non-admin
// agent, a write that addresses one record is refused with
// `forbidden: cannot modify <Table> owned by another principal` when that
// record exists and is owned by someone else, and a PUT, PATCH or DELETE that
// addresses the table's collection is refused with
// `forbidden: a non-admin write to <Table> must address one record by its id`.
// The record checked is the one Harper resolves the request to, so each address
// form below gets the same decision. A refused request writes nothing.
//
// Every case below asserts three things: the status is 403, the body is exactly
// the named refusal (it carries nothing from the stored row), and the stored row
// is byte-for-byte unchanged afterwards. The positive controls further down
// assert that the owner's own writes, collection creates and administrator
// writes are unaffected, because a guard that broke everyone's writes would
// pass every refusal case just as happily.
//
// Agents resolve to the least-privilege `flair-agent` user here, as they do in
// production (ensureFlairAgentRole/ensureFlairAgentUser), so the cases exercise
// the de-elevated role's real table grants.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";
import { OWNER_FIELDS } from "../../resources/record-owner-guard.js";

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
  // Presence's owner field IS its primary key, so every case uses a fresh owning principal id.
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

describe("owner-scoped writes: each record a non-admin write touches is owner-checked", () => {
  beforeAll(async () => {
    harper = await startHarper();
    await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
    await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
    for (const a of [owner, caller]) {
      await seed("Agent", { id: a.id, name: a.id, role: "agent", admin: false, publicKey: a.publicKey, createdAt: NOW });
    }
    await seed("Agent", { id: adminAgent.id, name: adminAgent.id, role: "admin", publicKey: adminAgent.publicKey, createdAt: NOW });
  }, 240_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  for (const s of SPECS) {
    describe(s.table, () => {
      for (const shape of SHAPES) {
        const variant = shape.ownerInBody === undefined ? "" : shape.ownerInBody ? " (owner field in body)" : " (no owner field in body)";
        test(`${s.table}: ${shape.label}${variant} is refused with 403 and writes nothing`, async () => {
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

  // ── POSITIVE CONTROLS ─────────────────────────────────────────────────────
  describe("the caller's own records stay writable", () => {
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

  // ── A write may name only the record it addresses ──────────────────────────
  // A PUT to a fresh or own id whose body `id` names another principal's
  // existing record must not reach that record. The invariant, over every
  // owner-scoped table served over REST, is that the record named only in the
  // body is byte-for-byte unchanged — whether the resource refuses the write or
  // writes the record it addresses and leaves the named one alone.
  describe("a non-admin write cannot reach a record named only in the body", () => {
    for (const s of SPECS) {
      test(`${s.table}: a PUT to a fresh id whose body names another principal's record leaves that record unchanged`, async () => {
        const f = await fixture(s);
        const before = await storedRow(s.table, s.pk, f.otherId);
        expect(before, `${s.table} fixture row was not seeded`).not.toBeNull();
        const freshId = ownerIsKey(s) ? caller.id : s.idFor(`addr-${randomUUID().slice(0, 6)}`, caller.id);
        // The body names the OTHER principal's existing record; the URL names a
        // fresh/own record. The owner field is set to the caller.
        const body: Record<string, any> = { ...s.row(f.otherId, caller.id), [s.mut]: "named-via-body" };
        body.id = f.otherId;
        if (!ownerIsKey(s)) body[ownerFieldOf(s)] = caller.id;
        const res = await send(caller, "PUT", `/${s.table}/${e(freshId)}`, body);
        const text = await res.text();
        // A refusal is 4xx; a resource that writes the addressed record and
        // ignores the body id answers with its create/update status. Either way
        // the record named only in the body must not have moved.
        expect(res.status, `${s.table} body-id PUT returned ${res.status}: ${text.slice(0, 200)}`).toBeLessThan(500);
        expect(await storedRow(s.table, s.pk, f.otherId), `${s.table}: the record named only in the body was written`).toEqual(before);
      }, 30_000);
    }

    test("OrgEvent: a PUT to a fresh id whose body names another agent's event is refused with the named 403", async () => {
      const s = SPECS.find((x) => x.table === "OrgEvent")!;
      const f = await fixture(s);
      const before = await storedRow("OrgEvent", "id", f.otherId);
      const freshId = s.idFor(`addr-${randomUUID().slice(0, 6)}`, caller.id);
      const res = await send(caller, "PUT", `/OrgEvent/${e(freshId)}`, { id: f.otherId, authorId: caller.id, kind: "k", summary: "named-via-body" });
      const text = await res.text();
      expect(res.status, `OrgEvent body-id PUT returned ${res.status}: ${text.slice(0, 200)}`).toBe(403);
      const parsed = JSON.parse(text);
      expect(parsed.error).toBe("write_id_not_addressed");
      expect(text).not.toContain(f.otherId);
      expect(text).not.toContain(freshId);
      expect(await storedRow("OrgEvent", "id", f.otherId), "the event named only in the body was written").toEqual(before);
    }, 30_000);

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
      const res = await send(caller, "PUT", `/OrgEvent/${e(id)}`, { id, authorId: caller.id, kind: "k", summary: "updated", createdAt: NOW });
      expect(res.status, `OrgEvent addressed PUT returned ${res.status}: ${await res.text()}`).toBeLessThan(300);
      expect((await storedRow("OrgEvent", "id", id))?.summary).toBe("updated");
    }, 30_000);
  });

  describe("administrators are unchanged", () => {
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
  // Every OWNER_FIELDS table served over REST by a resource class that extends
  // the table must have a spec above, so a table that gains an owner column and
  // a resource class is exercised here without anyone remembering to add it.
  test("every owner-scoped table served over REST has a spec", () => {
    const RES = join(import.meta.dir, "..", "..", "resources");
    const served = Object.keys(OWNER_FIELDS).filter((t) => {
      const file = join(RES, `${t}.ts`);
      return existsSync(file) && readFileSync(file, "utf8").includes(`extends (databases as any).flair.${t} `);
    });
    const covered = new Set(SPECS.map((s) => s.table));
    expect(served.filter((t) => !covered.has(t)), "owner-scoped tables served over REST without a spec").toEqual([]);
    expect(served.length, "the served-table scan found nothing; its pattern no longer matches the resource classes").toBeGreaterThan(5);
  });
});
