/**
 * orgevent-created-at-server-time.test.ts — real Harper, over HTTP.
 *
 * The createdAt check for OrgEvent writes (resources/org-event-created-at.ts):
 *   - POST, PUT (single record, and an administrator's collection PUT of an
 *     array) and an admin PATCH that creates a row store the server's time,
 *     whatever the body says;
 *   - a non-admin agent's collection PUT or PATCH is refused by the
 *     owner-scoped write guard (resources/owner-scoped-write-policy.ts) with
 *     403 `forbidden: a non-admin write to OrgEvent must address one record by
 *     its id` before the createdAt check: no row is created and a stored row is
 *     byte-for-byte unchanged, createdAt included. The guard admits a
 *     collection PUT from an administrator (an admin agent key or a
 *     credentialed Basic admin) and from a trusted in-process call; the
 *     createdAt check does not run for an in-process call, and no HTTP request
 *     resolves to one, so the collection-path createdAt cases run as an
 *     administrator;
 *   - an update that reaches the check with a createdAt that differs from the
 *     stored one is refused with `created_at_immutable` (409) and the stored
 *     row is unchanged, for agents and admin agents alike, including a stored
 *     createdAt that is an empty string; an update that omits createdAt keeps
 *     the stored value;
 *   - after POST normalization and earlier guards, POST and PUT ids outside
 *     a non-empty string or a non-empty array of strings get `invalid_event_id`
 *     (400) before any write. PATCH checks the addressed path id. Trusted
 *     server-originated internal PUT/PATCH skip the id check in _assignCreatedAt;
 *   - malformed bodies reaching the POST, PUT and PATCH resource methods are
 *     refused with `body_must_be_object` (400), except admitted arrays of records,
 *     before the resource method's authentication, attribution, ownership and
 *     createdAt checks. Harper's collection validation can refuse input earlier;
 *   - before validation, an addressed POST binds a missing or null body id to
 *     the addressed id, and a string or number body id when its text matches
 *     the address; any other id type is left unchanged by this step. At the
 *     root collection an absent, null or empty body id gets a generated id. At
 *     POST id validation, at the root collection or an addressed path whose
 *     body id was not bound, a remaining id that the shared id rule does not
 *     read receives `invalid_event_id` (400);
 *   - for malformed ids and bodies, the status each caller gets is pinned, with
 *     a refusal's `error` or `code` field, including input answered before the
 *     check (attribution, the owner-scoped write guard, Flair's body guard
 *     (`body_must_be_object`), Harper's own validation);
 *   - the catch-up feed delivers events in timestamp and ID order, so events
 *     with one server time are delivered in ID order (checked on a second,
 *     frozen-clock instance with IDs in reverse write order);
 *   - a credentialed Basic admin follows the same rule; an administrator's
 *     collection PATCH is refused with `invalid_event_id`, a non-admin's with
 *     the owner-scoped collection refusal, and neither writes anything;
 *   - a table-level write (the path flair's in-process writers use) keeps the
 *     createdAt it supplies;
 *   - a write whose stored-event read fails is refused and writes nothing.
 *
 * The read-failure case runs against a private copy of the built component
 * whose stored-row load throws for marker ids (test/helpers/
 * owner-guard-load-failure-component.ts), armed by a sentinel under the
 * instance ROOTPATH, the same mechanism orgevent-post-id-ownership-2333 uses.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { HARPER_STOP_BUDGET_MS, HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";
import {
  componentWithOwnerGuardLoadFailure,
  LOAD_FAILURE_MARKER,
  ARM_FILE,
  type FailingComponent,
} from "../helpers/owner-guard-load-failure-component";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}
function ed25519Header(agent: TestAgent, method: string, path: string, nowMs: number = Date.now()): string {
  const ts = String(nowMs);
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}
function assertOwnInstance(harper: HarperInstance): void {
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
  }
}

let harper: HarperInstance;
let component: FailingComponent;
const agent = mkAgent("oect-agent");
const admin = mkAgent("oect-admin");
const reader = mkAgent("oect-reader");
const tableReader = mkAgent("oect-table-reader");

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2001-01-01T00:00:00.000Z";
const IMMUTABLE = "created_at_immutable";
const INVALID_ID = "invalid_event_id";
const COLLECTION_REFUSAL = "forbidden: a non-admin write to OrgEvent must address one record by its id";

async function send(who: TestAgent, method: string, path: string, body?: unknown, h: HarperInstance = harper, nowMs?: number): Promise<Response> {
  return fetch(`${h.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(who, method, path, nowMs), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
/** A signed REST call whose body is sent exactly as given (for bodies that are not objects). */
async function sendRaw(who: TestAgent, method: string, path: string, raw: string): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(who, method, path), "Content-Type": "application/json" },
    body: raw,
  });
}
/** A REST call with the instance's credentialed Basic admin (Harper super_user). */
async function basicSend(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function adminOp(op: Record<string, any>, h: HarperInstance = harper): Promise<Response> {
  return fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${h.admin.username}:${h.admin.password}`) },
    body: JSON.stringify(op),
  });
}
async function seedAgent(a: TestAgent, role: "agent" | "admin", h: HarperInstance = harper): Promise<void> {
  const res = await adminOp({
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: a.id, name: a.id, role, publicKey: a.publicKey, createdAt: new Date().toISOString() }],
  }, h);
  expect(res.status, `seed agent ${a.id} returned ${res.status}`).toBe(200);
}
async function readEvent(id: string, h: HarperInstance = harper): Promise<any> {
  const res = await adminOp({
    operation: "search_by_hash", database: "flair", table: "OrgEvent", hash_values: [id], get_attributes: ["*"],
  }, h);
  const text = await res.text();
  expect(res.status, `search_by_hash returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return (JSON.parse(text) as any[])[0] ?? null;
}
async function eventsBySummary(summary: string): Promise<any[]> {
  const res = await adminOp({
    operation: "search_by_value", database: "flair", table: "OrgEvent",
    search_attribute: "summary", search_value: summary, get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, `search_by_value returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return JSON.parse(text) as any[];
}
/** Run `write`, and return its response with the server-time window it ran in. */
async function timed(write: () => Promise<Response>): Promise<{ res: Response; text: string; from: number; to: number }> {
  const from = Date.now();
  const res = await write();
  const text = await res.text();
  const to = Date.now();
  return { res, text, from, to };
}
/** The stored createdAt is a server time inside the request's window. */
function expectServerTime(createdAt: unknown, from: number, to: number): void {
  expect(typeof createdAt, `createdAt ${String(createdAt)} is not a string`).toBe("string");
  const t = Date.parse(createdAt as string);
  expect(Number.isFinite(t), `createdAt ${String(createdAt)} is not a timestamp`).toBe(true);
  expect(t, `createdAt ${String(createdAt)} is before the request`).toBeGreaterThanOrEqual(from);
  expect(t, `createdAt ${String(createdAt)} is after the request`).toBeLessThanOrEqual(to);
}
/** A refusal that names the rule and carries neither the stored nor the requested value. */
function expectImmutableRefusal(status: number, text: string, ...values: string[]): void {
  expect(status, text.slice(0, 300)).toBe(409);
  expect(JSON.parse(text).error).toBe(IMMUTABLE);
  for (const v of values) expect(text).not.toContain(v);
}
/** The refusal for a record whose id the check does not read; echoes nothing. */
function expectInvalidIdRefusal(status: number, text: string): void {
  expect(status, text.slice(0, 300)).toBe(400);
  const body = JSON.parse(text);
  expect(body.error).toBe(INVALID_ID);
  expect(Object.keys(body).sort()).toEqual(["error", "message"]);
}
/** The owner-scoped write guard's refusal of a non-admin collection write; it carries nothing else. */
function expectCollectionRefusal(status: number, text: string): void {
  expect(status, text.slice(0, 300)).toBe(403);
  expect(JSON.parse(text)).toEqual({ error: COLLECTION_REFUSAL });
}
/** The stored row under `id` exactly as the operations API returns it, for a byte-for-byte comparison. */
async function rowBytes(id: string): Promise<string> {
  const res = await adminOp({
    operation: "search_by_hash", database: "flair", table: "OrgEvent", hash_values: [id], get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, `search_by_hash returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return text;
}
/** The rows whose summary is `summary`, exactly as the operations API returns them. */
async function summaryBytes(summary: string): Promise<string> {
  const res = await adminOp({
    operation: "search_by_value", database: "flair", table: "OrgEvent",
    search_attribute: "summary", search_value: summary, get_attributes: ["*"],
  });
  const text = await res.text();
  expect(res.status, `search_by_value returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return text;
}
/** How many OrgEvent rows the instance stores. */
async function countEvents(): Promise<number> {
  const res = await adminOp({ operation: "sql", sql: "SELECT COUNT(*) AS n FROM flair.OrgEvent" });
  const text = await res.text();
  expect(res.status, `count returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
  return Number((JSON.parse(text) as Array<{ n: number }>)[0]?.n);
}
/** Create an event as `who` and return its stored row. */
async function createOwn(who: TestAgent, id: string): Promise<any> {
  const res = await send(who, "POST", "/OrgEvent", { id, authorId: who.id, kind: "status", summary: `stored ${id}` });
  expect(res.status, (await res.text()).slice(0, 300)).toBeLessThan(300);
  const row = await readEvent(id);
  expect(row?.createdAt, `event ${id} was not created`).toBeTruthy();
  return row;
}

function armLookupFailure(): void { writeFileSync(join(harper.installDir, ARM_FILE), "1"); }
function disarmLookupFailure(): void {
  const p = join(harper.installDir, ARM_FILE);
  if (existsSync(p)) rmSync(p, { force: true });
}

beforeAll(async () => {
  component = componentWithOwnerGuardLoadFailure();
  harper = await startHarper({ cwd: component.dir });
  assertOwnInstance(harper);
  await seedAgent(agent, "agent");
  await seedAgent(admin, "admin");
  await seedAgent(reader, "agent");
  await seedAgent(tableReader, "agent");
}, 240_000);

afterAll(async () => {
  if (harper) { disarmLookupFailure(); await stopHarper(harper); }
  if (component) component.cleanup();
}, HARPER_STOP_BUDGET_MS);

describe("on create, an OrgEvent's createdAt is the server's time whatever the body says", () => {
  for (const [label, createdAt] of [["future", FUTURE], ["past", PAST]] as const) {
    it(`POST with a ${label} createdAt stores the server time`, async () => {
      const id = `oect-post-${label}-${randomUUID()}`;
      const w = await timed(() => send(agent, "POST", "/OrgEvent", { id, kind: "status", summary: "post create", createdAt }));
      expect(w.res.status, w.text.slice(0, 300)).toBeLessThan(300);
      expectServerTime((await readEvent(id))?.createdAt, w.from, w.to);
    }, 30_000);

    it(`PUT with a ${label} createdAt stores the server time`, async () => {
      const id = `oect-put-${label}-${randomUUID()}`;
      const w = await timed(() => send(agent, "PUT", `/OrgEvent/${id}`, { id, authorId: agent.id, kind: "status", summary: "put create", createdAt }));
      expect(w.res.status, w.text.slice(0, 300)).toBeLessThan(300);
      expectServerTime((await readEvent(id))?.createdAt, w.from, w.to);
    }, 30_000);

    it(`an admin collection PUT of an array with a ${label} createdAt stores the server time for each element`, async () => {
      const ids = [`oect-arr-${label}-a-${randomUUID()}`, `oect-arr-${label}-b-${randomUUID()}`];
      const w = await timed(() => send(admin, "PUT", "/OrgEvent/", ids.map((id) => ({ id, authorId: admin.id, kind: "status", summary: "array create", createdAt }))));
      expect(w.res.status, w.text.slice(0, 300)).toBeLessThan(300);
      for (const id of ids) expectServerTime((await readEvent(id))?.createdAt, w.from, w.to);
    }, 30_000);

    it(`a non-admin collection PUT of an array with a ${label} createdAt is refused with 403 and creates no row`, async () => {
      const ids = [`oect-arr-agent-${label}-a-${randomUUID()}`, `oect-arr-agent-${label}-b-${randomUUID()}`];
      const res = await send(agent, "PUT", "/OrgEvent/", ids.map((id) => ({ id, authorId: agent.id, kind: "status", summary: "array create", createdAt })));
      expectCollectionRefusal(res.status, await res.text());
      for (const id of ids) expect(await readEvent(id), `element ${id} of a refused collection PUT was stored`).toBeNull();
    }, 30_000);

    it(`an admin PUT with a ${label} createdAt stores the server time`, async () => {
      const id = `oect-admin-put-${label}-${randomUUID()}`;
      const w = await timed(() => send(admin, "PUT", `/OrgEvent/${id}`, { id, authorId: admin.id, kind: "status", summary: "admin put create", createdAt }));
      expect(w.res.status, w.text.slice(0, 300)).toBeLessThan(300);
      expectServerTime((await readEvent(id))?.createdAt, w.from, w.to);
    }, 30_000);

    it(`an admin PATCH that creates a row with a ${label} createdAt stores the server time`, async () => {
      const id = `oect-admin-patch-${label}-${randomUUID()}`;
      const w = await timed(() => send(admin, "PATCH", `/OrgEvent/${id}`, { authorId: admin.id, kind: "status", summary: "admin patch create", createdAt }));
      expect(w.res.status, w.text.slice(0, 300)).toBeLessThan(300);
      expectServerTime((await readEvent(id))?.createdAt, w.from, w.to);
    }, 30_000);
  }
});

describe("an update that changes an OrgEvent's createdAt is refused, and the stored row is unchanged", () => {
  const cases: Array<{ name: string; who: TestAgent; write: (id: string, createdAt: string) => Promise<Response> }> = [
    { name: "PUT", who: agent, write: (id, createdAt) => send(agent, "PUT", `/OrgEvent/${id}`, { id, authorId: agent.id, kind: "status", summary: "changed", createdAt }) },
    { name: "PATCH", who: agent, write: (id, createdAt) => send(agent, "PATCH", `/OrgEvent/${id}`, { summary: "changed", createdAt }) },
    { name: "POST naming the event's id", who: agent, write: (id, createdAt) => send(agent, "POST", "/OrgEvent", { id, kind: "status", summary: "changed", createdAt }) },
    { name: "admin collection PUT of an array", who: admin, write: (id, createdAt) => send(admin, "PUT", "/OrgEvent/", [{ id, authorId: admin.id, kind: "status", summary: "changed", createdAt }]) },
    { name: "admin PUT", who: admin, write: (id, createdAt) => send(admin, "PUT", `/OrgEvent/${id}`, { id, authorId: admin.id, kind: "status", summary: "changed", createdAt }) },
    { name: "admin PATCH", who: admin, write: (id, createdAt) => send(admin, "PATCH", `/OrgEvent/${id}`, { summary: "changed", createdAt }) },
    { name: "admin PUT of an array body", who: admin, write: (id, createdAt) => send(admin, "PUT", `/OrgEvent/oect-array-path-${randomUUID()}`, [{ id, authorId: admin.id, kind: "status", summary: "changed", createdAt }]) },
  ];

  for (const c of cases) {
    for (const [label, createdAt] of [["future", FUTURE], ["past", PAST]] as const) {
      it(`${c.name} with a ${label} createdAt is refused with ${IMMUTABLE} (409)`, async () => {
        const id = `oect-upd-${c.name.replace(/\W+/g, "-")}-${label}-${randomUUID()}`;
        const before = await createOwn(c.who, id);
        const res = await c.write(id, createdAt);
        expectImmutableRefusal(res.status, await res.text(), before.createdAt, createdAt);
        expect(await readEvent(id)).toEqual(before);
      }, 30_000);
    }
  }

  for (const [label, createdAt] of [["future", FUTURE], ["past", PAST]] as const) {
    it(`a non-admin collection PUT of an array with a ${label} createdAt is refused with 403, and the row is byte-for-byte unchanged`, async () => {
      const id = `oect-upd-coll-agent-${label}-${randomUUID()}`;
      const before = await createOwn(agent, id);
      const bytes = await rowBytes(id);
      const res = await send(agent, "PUT", "/OrgEvent/", [{ id, authorId: agent.id, kind: "status", summary: "changed", createdAt }]);
      expectCollectionRefusal(res.status, await res.text());
      expect(await rowBytes(id)).toBe(bytes);
      expect((await readEvent(id))?.createdAt).toBe(before.createdAt);
    }, 30_000);
  }

  it("an admin collection PUT of an array is refused as a whole: a new sibling element is not stored", async () => {
    const id = `oect-batch-old-${randomUUID()}`;
    const sibling = `oect-batch-new-${randomUUID()}`;
    const before = await createOwn(admin, id);
    const res = await send(admin, "PUT", "/OrgEvent/", [
      { id: sibling, authorId: admin.id, kind: "status", summary: "new sibling" },
      { id, authorId: admin.id, kind: "status", summary: "changed", createdAt: PAST },
    ]);
    expectImmutableRefusal(res.status, await res.text(), before.createdAt, PAST);
    expect(await readEvent(id)).toEqual(before);
    expect(await readEvent(sibling), "a sibling of the refused element was stored").toBeNull();
  }, 30_000);

  it("a non-admin collection PUT of an array is refused with 403 as a whole: no element is stored and the existing row is byte-for-byte unchanged", async () => {
    const id = `oect-batch-agent-old-${randomUUID()}`;
    const sibling = `oect-batch-agent-new-${randomUUID()}`;
    const before = await createOwn(agent, id);
    const bytes = await rowBytes(id);
    const res = await send(agent, "PUT", "/OrgEvent/", [
      { id: sibling, authorId: agent.id, kind: "status", summary: "new sibling" },
      { id, authorId: agent.id, kind: "status", summary: "changed", createdAt: PAST },
    ]);
    expectCollectionRefusal(res.status, await res.text());
    expect(await rowBytes(id)).toBe(bytes);
    expect((await readEvent(id))?.createdAt).toBe(before.createdAt);
    expect(await readEvent(sibling), "a sibling in the refused request was stored").toBeNull();
  }, 30_000);
});

describe("an update that omits createdAt keeps the stored value", () => {
  for (const [name, write] of [
    ["PUT", (id: string) => send(agent, "PUT", `/OrgEvent/${id}`, { id, authorId: agent.id, kind: "status", summary: "updated" })],
    ["PATCH", (id: string) => send(agent, "PATCH", `/OrgEvent/${id}`, { summary: "updated" })],
    ["POST naming the event's id", (id: string) => send(agent, "POST", "/OrgEvent", { id, kind: "status", summary: "updated" })],
    ["PUT restating the stored createdAt", null],
  ] as const) {
    it(`${name} keeps the stored createdAt`, async () => {
      const id = `oect-keep-${name.replace(/\W+/g, "-")}-${randomUUID()}`;
      const before = await createOwn(agent, id);
      const res = write
        ? await write(id)
        : await send(agent, "PUT", `/OrgEvent/${id}`, { id, authorId: agent.id, kind: "status", summary: "updated", createdAt: before.createdAt });
      expect(res.status, (await res.text()).slice(0, 300)).toBeLessThan(300);
      const after = await readEvent(id);
      expect(after.summary).toBe("updated");
      expect(after.createdAt).toBe(before.createdAt);
    }, 30_000);
  }
});

describe("catch-up delivers events in timestamp and ID order", () => {
  it("events written with caller-supplied createdAt values are delivered in timestamp and ID order, each at its server time", async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const tag = randomUUID();
    const writes = [
      { id: `oect-cu-1-${tag}`, createdAt: FUTURE },
      { id: `oect-cu-2-${tag}`, createdAt: PAST },
      { id: `oect-cu-3-${tag}`, createdAt: "2050-06-01T00:00:00.000Z" },
    ];
    const windows: Array<{ from: number; to: number }> = [];
    for (const w of writes) {
      const r = await timed(() => send(agent, "PUT", `/OrgEvent/${w.id}`, {
        id: w.id, authorId: agent.id, kind: "status", summary: "catch-up order", targetIds: [reader.id], createdAt: w.createdAt,
      }));
      expect(r.res.status, r.text.slice(0, 300)).toBeLessThan(300);
      windows.push({ from: r.from, to: r.to });
    }

    const path = `/OrgEventCatchup/${reader.id}?since=${encodeURIComponent(since)}&limit=200`;
    const res = await send(reader, "GET", path);
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(200);
    const mine = (JSON.parse(text).events as any[]).filter((e) => String(e.id).endsWith(tag));
    expect(mine.map((e) => e.id)).toEqual(writes.map((w) => w.id));
    mine.forEach((e, i) => expectServerTime(e.createdAt, windows[i].from, windows[i].to));
  }, 30_000);
});

describe("a table-level write keeps the createdAt it supplies", () => {
  it("an event inserted at the table (the path in-process writers use) keeps its createdAt, and catch-up orders it there", async () => {
    const tag = randomUUID();
    const suppliedAt = new Date(Date.now() - 60_000).toISOString();
    const since = new Date(Date.now() - 120_000).toISOString();
    const tableId = `oect-table-${tag}`;
    const ins = await adminOp({
      operation: "insert", database: "flair", table: "OrgEvent",
      records: [{ id: tableId, authorId: "flair-migrations", kind: "migration", summary: "table write", targetIds: [tableReader.id], createdAt: suppliedAt }],
    });
    expect(ins.status, (await ins.text()).slice(0, 300)).toBe(200);
    const restId = `oect-rest-${tag}`;
    const put = await send(agent, "PUT", `/OrgEvent/${restId}`, {
      id: restId, authorId: agent.id, kind: "status", summary: "rest write", targetIds: [tableReader.id], createdAt: PAST,
    });
    expect(put.status, (await put.text()).slice(0, 300)).toBeLessThan(300);

    expect((await readEvent(tableId))?.createdAt).toBe(suppliedAt);
    const res = await send(tableReader, "GET", `/OrgEventCatchup/${tableReader.id}?since=${encodeURIComponent(since)}&limit=200`);
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(200);
    const mine = (JSON.parse(text).events as any[]).filter((e) => String(e.id).endsWith(tag));
    expect(mine.map((e) => e.id)).toEqual([tableId, restId]);
    expect(mine[0].createdAt).toBe(suppliedAt);
  }, 30_000);
});

describe("refusals that write nothing", () => {
  it("a POST with an array body is refused and stores nothing", async () => {
    const summary = `oect-post-array-${randomUUID()}`;
    const res = await send(agent, "POST", "/OrgEvent", [{ id: summary, authorId: agent.id, kind: "status", summary, createdAt: PAST }]);
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(400);
    expect(JSON.parse(text).error).toBe("body_must_be_object");
    expect(await readEvent(summary)).toBeNull();
    expect(await eventsBySummary(summary)).toEqual([]);
  }, 30_000);

  it("an admin POST whose stored-event read fails is refused with created_at_check_unavailable and stores nothing", async () => {
    const id = `${LOAD_FAILURE_MARKER}-oect-${randomUUID()}`;
    armLookupFailure();
    let res: Response;
    try {
      res = await send(admin, "POST", "/OrgEvent", { id, authorId: admin.id, kind: "status", summary: "unreadable" });
    } finally {
      disarmLookupFailure();
    }
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(503);
    expect(JSON.parse(text).error).toBe("created_at_check_unavailable");
    expect(await readEvent(id)).toBeNull();
  }, 30_000);
});

describe("a credentialed Basic admin follows the same createdAt rule", () => {
  for (const [label, createdAt] of [["future", FUTURE], ["past", PAST]] as const) {
    for (const [verb, path, body] of [
      ["POST", "/OrgEvent", (id: string) => ({ id, authorId: agent.id, kind: "status", summary: "basic post", createdAt })],
      ["PUT", null, (id: string) => ({ id, authorId: agent.id, kind: "status", summary: "basic put", createdAt })],
      ["PATCH", null, (_id: string) => ({ authorId: agent.id, kind: "status", summary: "basic patch", createdAt })],
    ] as const) {
      it(`a Basic-admin ${verb} create with a ${label} createdAt stores the server time`, async () => {
        const id = `oect-basic-${verb.toLowerCase()}-${label}-${randomUUID()}`;
        const w = await timed(() => basicSend(verb, path ?? `/OrgEvent/${id}`, body(id)));
        expect(w.res.status, w.text.slice(0, 300)).toBeLessThan(300);
        expectServerTime((await readEvent(id))?.createdAt, w.from, w.to);
      }, 30_000);
    }
  }

  for (const [verb, body] of [
    ["PUT", (id: string, createdAt: string) => ({ id, authorId: agent.id, kind: "status", summary: "changed", createdAt })],
    ["PATCH", (_id: string, createdAt: string) => ({ summary: "changed", createdAt })],
  ] as const) {
    it(`a Basic-admin ${verb} that changes createdAt is refused with ${IMMUTABLE} (409) and the row is unchanged`, async () => {
      const id = `oect-basic-upd-${verb.toLowerCase()}-${randomUUID()}`;
      const before = await createOwn(agent, id);
      const res = await basicSend(verb, `/OrgEvent/${id}`, body(id, PAST));
      expectImmutableRefusal(res.status, await res.text(), before.createdAt, PAST);
      expect(await readEvent(id)).toEqual(before);
    }, 30_000);
  }
});

describe("a PATCH to the OrgEvent collection writes nothing", () => {
  it(`an admin collection PATCH is refused with ${INVALID_ID} (400)`, async () => {
    const id = `oect-coll-patch-${randomUUID()}`;
    const before = await createOwn(agent, id);
    const res = await send(admin, "PATCH", "/OrgEvent/", { summary: "changed", createdAt: PAST });
    expectInvalidIdRefusal(res.status, await res.text());
    expect(await readEvent(id)).toEqual(before);
  }, 30_000);

  it("a non-admin collection PATCH is refused with 403, and the row is byte-for-byte unchanged", async () => {
    const id = `oect-coll-patch-agent-${randomUUID()}`;
    const before = await createOwn(agent, id);
    const bytes = await rowBytes(id);
    const res = await send(agent, "PATCH", "/OrgEvent/", { summary: "changed", createdAt: PAST });
    expectCollectionRefusal(res.status, await res.text());
    expect(await rowBytes(id)).toBe(bytes);
    expect((await readEvent(id))?.createdAt).toBe(before.createdAt);
  }, 30_000);
});

describe("a record that reaches the check with an id it does not read is refused before any write", () => {
  // The empty string is a key Harper accepts; the check does not read it, so
  // every write that reaches the check naming it is refused. The row is
  // seeded at the table.
  const EMPTY_AT = "2026-01-01T00:00:00.000Z";
  let emptyRow: any;

  beforeAll(async () => {
    const ins = await adminOp({
      operation: "upsert", database: "flair", table: "OrgEvent",
      records: [{ id: "", authorId: agent.id, kind: "status", summary: "empty-id row", createdAt: EMPTY_AT }],
    });
    expect(ins.status, (await ins.text()).slice(0, 300)).toBe(200);
    emptyRow = await readEvent("");
    expect(emptyRow?.createdAt).toBe(EMPTY_AT);
  }, 30_000);

  it("an admin collection PUT naming the empty id with a different createdAt is refused, and the row is unchanged", async () => {
    const res = await send(admin, "PUT", "/OrgEvent/", [{ id: "", authorId: agent.id, kind: "status", summary: "changed", createdAt: FUTURE }]);
    expectInvalidIdRefusal(res.status, await res.text());
    expect(await readEvent("")).toEqual(emptyRow);
  }, 30_000);

  it("an admin collection PUT naming the empty id without createdAt is refused, and the row is unchanged", async () => {
    const res = await send(admin, "PUT", "/OrgEvent/", [{ id: "", authorId: agent.id, kind: "status", summary: "changed" }]);
    expectInvalidIdRefusal(res.status, await res.text());
    expect(await readEvent("")).toEqual(emptyRow);
  }, 30_000);

  it("an admin collection PUT with the empty id among its elements stores none of them", async () => {
    const sibling = `oect-empty-sibling-${randomUUID()}`;
    const res = await send(admin, "PUT", "/OrgEvent/", [
      { id: sibling, authorId: admin.id, kind: "status", summary: "new sibling" },
      { id: "", authorId: agent.id, kind: "status", summary: "changed" },
    ]);
    expectInvalidIdRefusal(res.status, await res.text());
    expect(await readEvent(sibling), "a sibling of the refused element was stored").toBeNull();
    expect(await readEvent("")).toEqual(emptyRow);
  }, 30_000);

  // A non-admin collection PUT does not reach the check: the owner-scoped
  // write guard refuses it first (403), whatever its elements.
  describe("a non-admin collection PUT naming the empty id is refused before the check", () => {
    for (const [label, element] of [
      ["with a different createdAt", { id: "", authorId: agent.id, kind: "status", summary: "changed", createdAt: FUTURE }],
      ["without createdAt", { id: "", authorId: agent.id, kind: "status", summary: "changed" }],
    ] as const) {
      it(`a non-admin collection PUT naming the empty id ${label} is refused with 403, and the row is byte-for-byte unchanged`, async () => {
        const bytes = await rowBytes("");
        const res = await send(agent, "PUT", "/OrgEvent/", [element]);
        expectCollectionRefusal(res.status, await res.text());
        expect(await rowBytes("")).toBe(bytes);
        expect(await readEvent("")).toEqual(emptyRow);
      }, 30_000);
    }

    it("a non-admin collection PUT with the empty id among its elements is refused with 403 and stores none of them", async () => {
      const sibling = `oect-empty-sibling-agent-${randomUUID()}`;
      const bytes = await rowBytes("");
      const res = await send(agent, "PUT", "/OrgEvent/", [
        { id: sibling, authorId: agent.id, kind: "status", summary: "new sibling" },
        { id: "", authorId: agent.id, kind: "status", summary: "changed" },
      ]);
      expectCollectionRefusal(res.status, await res.text());
      expect(await readEvent(sibling), "a sibling in the refused request was stored").toBeNull();
      expect(await rowBytes("")).toBe(bytes);
    }, 30_000);
  });

  it("an admin PUT of an array body naming the empty id is refused, and the row is unchanged", async () => {
    const res = await send(admin, "PUT", `/OrgEvent/oect-array-path-${randomUUID()}`, [{ id: "", authorId: agent.id, kind: "status", summary: "changed" }]);
    expectInvalidIdRefusal(res.status, await res.text());
    expect(await readEvent("")).toEqual(emptyRow);
  }, 30_000);

  it("an admin root collection POST naming an id that is not a non-empty string or array of strings is refused and stores nothing", async () => {
    const summary = `oect-post-bad-id-${randomUUID()}`;
    const res = await send(admin, "POST", "/OrgEvent", { id: [], authorId: admin.id, kind: "status", summary });
    expectInvalidIdRefusal(res.status, await res.text());
    expect(await eventsBySummary(summary)).toEqual([]);
  }, 30_000);
});

describe("catch-up delivers events that share one server time in ID order", () => {
  // A second instance whose clock is frozen (test/helpers/harper-freeze-clock.cjs),
  // so every write gets the same server time and only the ID orders them.
  // Requests are signed at the frozen instant, which is the instance's "now".
  let frozen: HarperInstance;
  let frozenAt = 0;
  const writer = mkAgent("oect-tie-writer");
  const tieReader = mkAgent("oect-tie-reader");

  beforeAll(async () => {
    frozenAt = Date.now();
    const clockPreload = fileURLToPath(new URL("../helpers/harper-freeze-clock.cjs", import.meta.url));
    frozen = await startHarper({
      env: {
        FLAIR_TEST_FROZEN_NOW: String(frozenAt),
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${clockPreload}`.trim(),
      },
    });
    assertOwnInstance(frozen);
    await seedAgent(writer, "agent", frozen);
    await seedAgent(tieReader, "agent", frozen);
  }, 240_000);

  afterAll(async () => { if (frozen) await stopHarper(frozen); }, HARPER_STOP_BUDGET_MS);

  it("events written in reverse ID order at one server time are delivered in ID order", async () => {
    const tag = randomUUID();
    // Written c, b, a, each with a different caller createdAt.
    const writes = [
      { id: `oect-tie-c-${tag}`, createdAt: FUTURE },
      { id: `oect-tie-b-${tag}`, createdAt: PAST },
      { id: `oect-tie-a-${tag}`, createdAt: "2050-06-01T00:00:00.000Z" },
    ];
    for (const w of writes) {
      const res = await send(writer, "PUT", `/OrgEvent/${w.id}`, {
        id: w.id, authorId: writer.id, kind: "status", summary: "tie order", targetIds: [tieReader.id], createdAt: w.createdAt,
      }, frozen, frozenAt);
      expect(res.status, (await res.text()).slice(0, 300)).toBeLessThan(300);
    }
    const serverTime = new Date(frozenAt).toISOString();
    for (const w of writes) expect((await readEvent(w.id, frozen))?.createdAt).toBe(serverTime);

    const since = new Date(frozenAt - 1000).toISOString();
    const path = `/OrgEventCatchup/${tieReader.id}?since=${encodeURIComponent(since)}&limit=200`;
    const res = await send(tieReader, "GET", path, undefined, frozen, frozenAt);
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(200);
    const mine = (JSON.parse(text).events as any[]).filter((e) => String(e.id).endsWith(tag));
    expect(mine.map((e) => e.id)).toEqual([...writes].reverse().map((w) => w.id));
  }, 30_000);
});

describe("a stored row's createdAt is kept whatever its value, an empty string included", () => {
  // The schema admits an empty string; such a row is seeded at the table.
  async function seedEmptyAt(): Promise<{ id: string; before: any }> {
    const id = `oect-empty-at-${randomUUID()}`;
    const ins = await adminOp({
      operation: "insert", database: "flair", table: "OrgEvent",
      records: [{ id, authorId: agent.id, kind: "status", summary: "empty createdAt", createdAt: "" }],
    });
    expect(ins.status, (await ins.text()).slice(0, 300)).toBe(200);
    const before = await readEvent(id);
    expect(before?.createdAt).toBe("");
    return { id, before };
  }

  for (const [name, write] of [
    ["POST naming the event's id", (id: string) => send(agent, "POST", "/OrgEvent", { id, kind: "status", summary: "changed", createdAt: FUTURE })],
    ["PUT", (id: string) => send(agent, "PUT", `/OrgEvent/${id}`, { id, authorId: agent.id, kind: "status", summary: "changed", createdAt: FUTURE })],
    ["PATCH", (id: string) => send(agent, "PATCH", `/OrgEvent/${id}`, { summary: "changed", createdAt: PAST })],
    ["admin PUT", (id: string) => send(admin, "PUT", `/OrgEvent/${id}`, { id, authorId: agent.id, kind: "status", summary: "changed", createdAt: FUTURE })],
  ] as const) {
    it(`${name} with a createdAt, for a row whose stored createdAt is empty, is refused with ${IMMUTABLE} (409), and the row is unchanged`, async () => {
      const { id, before } = await seedEmptyAt();
      const res = await write(id);
      const text = await res.text();
      expect(res.status, text.slice(0, 300)).toBe(409);
      expect(JSON.parse(text).error).toBe(IMMUTABLE);
      expect(await readEvent(id)).toEqual(before);
    }, 30_000);
  }

  for (const [name, write] of [
    ["POST naming the event's id", (id: string) => send(agent, "POST", "/OrgEvent", { id, kind: "status", summary: "updated" })],
    ["PUT", (id: string) => send(agent, "PUT", `/OrgEvent/${id}`, { id, authorId: agent.id, kind: "status", summary: "updated" })],
    ["PATCH", (id: string) => send(agent, "PATCH", `/OrgEvent/${id}`, { summary: "updated" })],
  ] as const) {
    it(`${name} without createdAt keeps an empty stored createdAt`, async () => {
      const { id } = await seedEmptyAt();
      const res = await write(id);
      expect(res.status, (await res.text()).slice(0, 300)).toBeLessThan(300);
      const after = await readEvent(id);
      expect(after.summary).toBe("updated");
      expect(after.createdAt).toBe("");
    }, 30_000);
  }
});

describe("a composite (array of strings) id follows the same createdAt rule", () => {
  // The row is the agent's (an administrator may name another authorId), so
  // the agent's own POST naming it reaches the createdAt check.
  it("an admin collection PUT creates it at server time, keeps it when omitted, and refuses a change; a non-admin collection PUT of it is refused with 403", async () => {
    const id = ["oect-composite", randomUUID()];
    const summary = `oect-composite-${id[1]}`;
    const rowOf = async () => {
      const rows = await eventsBySummary(summary);
      expect(rows.length, `rows for ${summary}`).toBe(1);
      return rows[0];
    };
    const w = await timed(() => send(admin, "PUT", "/OrgEvent/", [{ id, authorId: agent.id, kind: "status", summary, createdAt: FUTURE }]));
    expect(w.res.status, w.text.slice(0, 300)).toBeLessThan(300);
    const created = await rowOf();
    expect(created.id).toEqual(id);
    expectServerTime(created.createdAt, w.from, w.to);

    const kept = await send(admin, "PUT", "/OrgEvent/", [{ id, authorId: agent.id, kind: "status", summary, detail: "updated" }]);
    expect(kept.status, (await kept.text()).slice(0, 300)).toBeLessThan(300);
    const afterKeep = await rowOf();
    expect(afterKeep.detail).toBe("updated");
    expect(afterKeep.createdAt).toBe(created.createdAt);

    for (const res of [
      await send(admin, "PUT", "/OrgEvent/", [{ id, authorId: agent.id, kind: "status", summary, createdAt: PAST }]),
      await send(agent, "POST", "/OrgEvent", { id, kind: "status", summary, createdAt: PAST }),
    ]) {
      expectImmutableRefusal(res.status, await res.text(), created.createdAt, PAST);
      expect(await rowOf()).toEqual(afterKeep);
    }

    const bytes = await summaryBytes(summary);
    for (const element of [
      { id, authorId: agent.id, kind: "status", summary, createdAt: PAST },
      { id, authorId: agent.id, kind: "status", summary, detail: "changed" },
    ]) {
      const res = await send(agent, "PUT", "/OrgEvent/", [element]);
      expectCollectionRefusal(res.status, await res.text());
      expect(await summaryBytes(summary)).toBe(bytes);
    }
  }, 30_000);
});

describe("what each malformed id or body gets", () => {
  // Earlier refusals include the owner-scoped write guard (403), attribution,
  // Flair's body guard (`body_must_be_object`) and Harper's own validation.
  // A refused case asserts the status plus its `error` field (flair refusals;
  // the collection refusal's whole body) or `code` field (Harper's problem
  // details); a generated-id POST
  // case asserts a 2xx and exactly one row with a generated id. Storage is
  // checked for POST id cases by rows found by summary; collection PUT id cases
  // check the table count and, when present, the named row's bytes, as well as
  // rows found by summary. Single-record PUT bodies check no row at the path;
  // PATCH checks the row is unchanged. The POST-body cases check only the response.
  type Expect = { status: number; error?: string; code?: string; body?: Record<string, unknown> };
  const INVALID: Expect = { status: 400, error: INVALID_ID };
  const COLLECTION: Expect = { status: 403, error: COLLECTION_REFUSAL, body: { error: COLLECTION_REFUSAL } };
  const ATTRIBUTION: Expect = { status: 403, error: "forbidden: authorId must match authenticated agent" };
  const NOT_ADDRESSED: Expect = { status: 403, error: "write_id_not_addressed" };
  const HARPER_400: Expect = { status: 400, code: "ClientError" };
  const BODY_OBJECT: Expect = { status: 400, error: "body_must_be_object" };

  async function expectResponse(res: Response, want: Expect): Promise<void> {
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(want.status);
    const body = JSON.parse(text);
    if (want.error) expect(body.error).toBe(want.error);
    if (want.code) expect(body.code).toBe(want.code);
    if (want.body) expect(body).toEqual(want.body);
  }

  const IDS: Array<[string, unknown]> = [
    ["missing", undefined], ["empty", ""], ["null", null], ["0", 0], ["false", false],
    ["true", true], ["42", 42], ["[]", []], ["{a:1}", { a: 1 }], ['["x",1]', ["x", 1]],
  ];
  const withId = (who: TestAgent, label: string, id: unknown) => {
    const summary = `oect-malformed-${label.replace(/\W+/g, "_")}-${who === admin ? "admin" : "agent"}-${randomUUID()}`;
    const body: Record<string, unknown> = { authorId: who.id, kind: "status", summary };
    if (label !== "missing") body.id = id;
    return { body, summary };
  };

  // POST to the root collection, [agent, admin]: a missing, null or empty id
  // gets a generated id; every other id here is refused with invalid_event_id.
  const POST_ID: Record<string, [Expect | "generated", Expect | "generated"]> = {
    missing: ["generated", "generated"], empty: ["generated", "generated"], null: ["generated", "generated"],
    "0": [INVALID, INVALID], false: [INVALID, INVALID],
    true: [INVALID, INVALID], "42": [INVALID, INVALID], "[]": [INVALID, INVALID],
    "{a:1}": [INVALID, INVALID], '["x",1]': [INVALID, INVALID],
  };
  // Collection PUT, [agent, admin].
  const COLLECTION_ID: Record<string, [Expect, Expect]> = {
    missing: [COLLECTION, INVALID], empty: [COLLECTION, INVALID], null: [COLLECTION, INVALID],
    "0": [COLLECTION, INVALID], false: [COLLECTION, INVALID], true: [COLLECTION, INVALID],
    "42": [COLLECTION, INVALID], "[]": [COLLECTION, INVALID], "{a:1}": [COLLECTION, INVALID],
    '["x",1]': [COLLECTION, INVALID],
  };

  for (const [label, id] of IDS) {
    for (const [i, who] of [agent, admin].entries()) {
      const role = who === admin ? "admin" : "agent";
      const postWant = POST_ID[label][i];
      it(`POST with a ${label} id as ${role} gets ${postWant === "generated" ? "a generated id" : postWant.status}`, async () => {
        const { body, summary } = withId(who, label, id);
        const res = await send(who, "POST", "/OrgEvent", body);
        if (postWant === "generated") {
          expect(res.status, (await res.text()).slice(0, 300)).toBeLessThan(300);
          const rows = await eventsBySummary(summary);
          expect(rows.length).toBe(1);
          expect(String(rows[0].id).startsWith(`${who.id}-`), `generated id ${rows[0].id}`).toBe(true);
        } else {
          await expectResponse(res, postWant);
          expect(await eventsBySummary(summary)).toEqual([]);
        }
      }, 30_000);

      const putWant = COLLECTION_ID[label][i];
      it(`a collection PUT element with a ${label} id as ${role} gets ${putWant.status}${putWant.error ? ` ${putWant.error}` : ""}`, async () => {
        const { body, summary } = withId(who, label, id);
        const named = typeof id === "string" ? await rowBytes(id) : null;
        const before = await countEvents();
        await expectResponse(await send(who, "PUT", "/OrgEvent/", [body]), putWant);
        expect(await eventsBySummary(summary)).toEqual([]);
        expect(await countEvents(), "a refused collection PUT created a row").toBe(before);
        if (named !== null) expect(await rowBytes(id as string)).toBe(named);
      }, 30_000);
    }
  }

  // POST at a path other than the root collection, [agent, admin]: a missing
  // id takes the path's id (test/integration/owner-scoped-writes.test.ts); an
  // empty or non-string id does not generate one. A non-admin's string or
  // number body id that differs from an addressed id is refused first by the
  // owner-scoped write guard; every other case here is refused with invalid_event_id.
  const ELSEWHERE_ID: Array<[string, unknown]> = [["empty", ""], ["0", 0], ["false", false], ["[]", []], ["object", { toString: null }]];
  const ELSEWHERE_WANT: Record<string, Record<string, [Expect, Expect]>> = {
    addressed: {
      empty: [NOT_ADDRESSED, INVALID], "0": [NOT_ADDRESSED, INVALID], false: [INVALID, INVALID], "[]": [INVALID, INVALID], object: [INVALID, INVALID],
    },
    prefixed: {
      empty: [INVALID, INVALID], "0": [INVALID, INVALID], false: [INVALID, INVALID], "[]": [INVALID, INVALID], object: [INVALID, INVALID],
    },
  };
  for (const [where, pathOf] of [
    ["addressed", (tag: string) => `/OrgEvent/oect-addr-${tag}`],
    ["prefixed", (tag: string) => `/OrgEvent/oect-prefix-${tag}/`],
  ] as const) {
    for (const [label, id] of ELSEWHERE_ID) {
      for (const [i, who] of [agent, admin].entries()) {
        const role = who === admin ? "admin" : "agent";
        const want = ELSEWHERE_WANT[where][label][i];
        it(`POST at ${where === "addressed" ? "an addressed path" : "a prefixed collection"} with a ${label} id as ${role} gets ${want.status} ${want.error} and stores nothing`, async () => {
          const tag = randomUUID();
          const path = pathOf(tag);
          const { body, summary } = withId(who, label, id);
          await expectResponse(await send(who, "POST", path, body), want);
          expect(await eventsBySummary(summary)).toEqual([]);
          expect(await readEvent(path.slice("/OrgEvent/".length))).toBeNull();
        }, 30_000);
      }
    }
  }

  const BODIES: Array<[string, string]> = [["a string", '"abc"'], ["a number", "42"], ["null", "null"], ["true", "true"], ["an array of primitives", '["abc",1]']];
  // [agent, admin] for POST and addressed PUT/PATCH.
  const BODY_WANT: Record<string, Record<string, [Expect, Expect]>> = {
    POST: {
      "a string": [BODY_OBJECT, BODY_OBJECT], "a number": [BODY_OBJECT, BODY_OBJECT], null: [BODY_OBJECT, BODY_OBJECT],
      true: [BODY_OBJECT, BODY_OBJECT], "an array of primitives": [BODY_OBJECT, BODY_OBJECT],
    },
    PUT: {
      "a string": [BODY_OBJECT, BODY_OBJECT], "a number": [BODY_OBJECT, BODY_OBJECT], null: [BODY_OBJECT, BODY_OBJECT],
      true: [BODY_OBJECT, BODY_OBJECT], "an array of primitives": [BODY_OBJECT, BODY_OBJECT],
    },
    PATCH: {
      "a string": [BODY_OBJECT, BODY_OBJECT], "a number": [BODY_OBJECT, BODY_OBJECT], null: [BODY_OBJECT, BODY_OBJECT],
      true: [BODY_OBJECT, BODY_OBJECT], "an array of primitives": [BODY_OBJECT, BODY_OBJECT],
    },
  };

  for (const [label, raw] of BODIES) {
    for (const [i, who] of [agent, admin].entries()) {
      const role = who === admin ? "admin" : "agent";
      for (const verb of ["POST", "PUT", "PATCH"] as const) {
        const want = BODY_WANT[verb][label][i];
        it(`${verb} with ${label} as the body, as ${role}, gets ${want.status}${want.error ? ` ${want.error}` : ` ${want.code}`}`, async () => {
          if (verb === "POST") {
            await expectResponse(await sendRaw(who, "POST", "/OrgEvent", raw), want);
          } else if (verb === "PUT") {
            const id = `oect-raw-put-${randomUUID()}`;
            await expectResponse(await sendRaw(who, "PUT", `/OrgEvent/${id}`, raw), want);
            expect(await readEvent(id)).toBeNull();
          } else {
            const id = `oect-raw-patch-${randomUUID()}`;
            const before = await createOwn(agent, id);
            await expectResponse(await sendRaw(who, "PATCH", `/OrgEvent/${id}`, raw), want);
            expect(await readEvent(id)).toEqual(before);
          }
        }, 30_000);
      }

      const elementWant: Expect = who !== admin
        ? COLLECTION
        : label === "an array of primitives" ? BODY_OBJECT : HARPER_400;
      it(`a collection PUT whose element is ${label}, as ${role}, gets ${elementWant.status} ${elementWant.error ?? elementWant.code}${who !== admin ? " and creates no row" : ""}`, async () => {
        const before = who !== admin ? await countEvents() : 0;
        await expectResponse(await sendRaw(who, "PUT", "/OrgEvent/", `[${raw}]`), elementWant);
        if (who !== admin) expect(await countEvents(), "a refused collection PUT created a row").toBe(before);
      }, 30_000);
    }
  }
});

describe("the body-guard message follows the caller's allowArrayObjects", () => {
  // OrgEvent refuses an array at POST and PATCH (`allowArrayObjects` unset). Its PUT, single-record and collection alike, admits an array of records at the guard (`allowArrayObjects: true`, resources/OrgEvent.ts put()). The refusal message says so: PUT keeps the collection-write wording it has today, and POST and PATCH name a JSON object only.
  const OBJECT_ONLY = "the write body must be a JSON object";
  const COLLECTION = "the write body must be a JSON object, or an array of them for a collection write";

  it("a POST whose body is not an object names a JSON object only", async () => {
    const res = await sendRaw(agent, "POST", "/OrgEvent", '"abc"');
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(400);
    expect((JSON.parse(text) as { message: string }).message, text.slice(0, 300)).toBe(OBJECT_ONLY);
  }, 30_000);

  it("a PATCH whose body is not an object names a JSON object only", async () => {
    const id = `oect-msg-patch-${randomUUID()}`;
    await createOwn(agent, id);
    const res = await sendRaw(agent, "PATCH", `/OrgEvent/${id}`, "42");
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(400);
    expect((JSON.parse(text) as { message: string }).message, text.slice(0, 300)).toBe(OBJECT_ONLY);
  }, 30_000);

  it("a PUT whose caller admits arrays keeps the collection-write wording", async () => {
    const id = `oect-msg-put-${randomUUID()}`;
    const res = await sendRaw(agent, "PUT", `/OrgEvent/${id}`, '"abc"');
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(400);
    expect((JSON.parse(text) as { message: string }).message, text.slice(0, 300)).toBe(COLLECTION);
  }, 30_000);
});
