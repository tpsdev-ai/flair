// agent-put-immutable-2696.test.ts — flair#2696.
//
// An Agent PUT is an administrator operation. For a request that reaches
// Agent.put(), the target id is checked first: an id outside the agent-id rule
// is refused 400 (agent-id-rule-2359.test.ts); authentication, routing and
// Harper's resource admission (allowCreate() for a missing target) can refuse
// earlier.
// For a valid id, a signed PUT from an agent that is not an administrator is
// refused 403 and writes nothing: with
// `agent_put_admin_only` when the record exists, and by Harper's create check
// (the resource's allowCreate(), administrators only) when it does not. An
// anonymous PUT is refused. An administrator's PUT (a signed admin agent or
// Admin Basic) updates an EXISTING row as a full replacement. The server sets
// these fields whatever the body says: the id is the URL's; the STORED
// createdAt, publicKey, originatorInstanceId and receiver federation fields
// (_originatorInstanceId, _syncedFrom, _syncedAt) are carried, whether the body
// supplies other values or omits them; updatedAt is set by the handler; role
// and admin are reconciled. Every other field comes from the body, so an
// ordinary field the body omits (`status` and `role` included) is not kept. An
// administrator's PUT to a valid id with no stored row (and no body id that
// disagrees with the URL's) is refused with 404
// `agent_put_requires_existing` (its message names POST /AgentSeed, a creation
// path; POST /Agent/ also creates a row) and writes nothing. PATCH keeps its merge behaviour. A deletion or a key rotation
// committed after an administrator's PUT's first read and before its re-read
// in the write transaction is covered by agent-put-race-2696.test.ts; the
// non-admin PUT refusals on more row shapes and the PATCH admin-status guard,
// by agent-authority-guard-2696.test.ts.
//
// Each case runs against a real Harper; the stored-row assertions use an
// operations search_by_id in a separate request, so they read the committed
// row rather than the write's response.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
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
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

/** Refuse to talk to anything but this test's own ephemeral instance. */
function assertOwnInstance(harper: HarperInstance): void {
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  for (const [label, u] of [["http", http], ["ops", ops]] as const) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${label} target ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (!harper.process?.pid) throw new Error(`refusing to run: ${harper.httpURL} is not an instance this test started`);
}

const ADMIN = mkAgent("put2696-admin");
const OTHER = mkAgent("put2696-other");
const TARGET = mkAgent("put2696-target");

// Fixed stored values so "carried forward" is checked against exact bytes.
const STORED_CREATED_AT = "2026-01-02T03:04:05.000Z";
const STORED_PUBLIC_KEY = TARGET.publicKey;

let harper: HarperInstance;

describe("flair#2696 — an Agent PUT updates an existing row and carries its immutable fields", () => {
  async function adminOp(op: Record<string, any>): Promise<any> {
    const res = await fetch(harper.opsURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
      },
      body: JSON.stringify(op),
    });
    const text = await res.text();
    expect(res.status, `${op.operation} returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
    return JSON.parse(text);
  }

  async function rowIn(id: string): Promise<any | null> {
    const rows = await adminOp({ operation: "search_by_id", database: "flair", table: "Agent", ids: [id], get_attributes: ["*"] });
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  }

  function adminBasic(): string {
    return "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
  }

  async function put(path: string, body: unknown, caller: TestAgent | null): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (caller) headers.Authorization = ed25519Header(caller, "PUT", path);
    const res = await fetch(`${harper.httpURL}${path}`, { method: "PUT", headers, body: JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  }

  beforeAll(async () => {
    harper = await startHarper();
    assertOwnInstance(harper);

    const seed = async (rec: Record<string, any>) => {
      const res = await fetch(harper.opsURL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
        },
        body: JSON.stringify({ operation: "insert", database: "flair", table: "Agent", records: [rec] }),
      });
      expect(res.status, `seed ${rec.id} returned ${res.status}: ${await res.text()}`).toBe(200);
    };

    await seed({
      id: ADMIN.id, name: ADMIN.id, role: "admin", admin: true, status: "active",
      publicKey: ADMIN.publicKey, createdAt: STORED_CREATED_AT,
    });
    await seed({
      id: OTHER.id, name: OTHER.id, role: "agent", admin: false, status: "active",
      runtime: "stored-runtime", publicKey: OTHER.publicKey, createdAt: STORED_CREATED_AT,
    });
    await seed({
      id: TARGET.id, name: TARGET.id, role: "agent", admin: false, status: "active",
      displayName: "stored-name", runtime: "stored-runtime",
      publicKey: STORED_PUBLIC_KEY, createdAt: STORED_CREATED_AT,
    });
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  }, HARPER_STOP_BUDGET_MS);

  test("an admin PUT replaces other fields and keeps the stored createdAt and publicKey", async () => {
    const before = await rowIn(TARGET.id);
    expect(before?.createdAt).toBe(STORED_CREATED_AT);
    expect(before?.publicKey).toBe(STORED_PUBLIC_KEY);

    const path = `/Agent/${TARGET.id}`;
    const res = await put(path, {
      id: TARGET.id,
      name: TARGET.id,
      displayName: "put-name",
      runtime: "put-runtime",
      // Deliberately different immutable values: the stored ones must win.
      createdAt: "1999-01-01T00:00:00.000Z",
      publicKey: "client-supplied-public-key",
    }, ADMIN);
    expect(res.status, `admin PUT returned ${res.status}: ${res.text}`).toBeLessThan(300);

    const after = await rowIn(TARGET.id);
    expect(after?.createdAt, "stored createdAt was replaced").toBe(STORED_CREATED_AT);
    expect(after?.publicKey, "stored publicKey was replaced").toBe(STORED_PUBLIC_KEY);
    expect(after?.displayName, "the PUT's displayName was not stored").toBe("put-name");
    expect(after?.runtime, "the PUT's runtime was not stored").toBe("put-runtime");
  }, 30_000);

  test("an Admin Basic PUT succeeds, stores the changed field, and keeps the stored originatorInstanceId and federation fields whether the body supplies or omits them", async () => {
    const id = `put2696-basic-${randomUUID().slice(0, 8)}`;
    const STORED_FEDERATION = {
      originatorInstanceId: "inst-home-2696",
      _originatorInstanceId: "peer-origin-2696",
      _syncedFrom: "peer-origin-2696",
      _syncedAt: "2026-01-03T04:05:06.000Z",
    };
    const seedRes = await fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: adminBasic() },
      body: JSON.stringify({ operation: "insert", database: "flair", table: "Agent", records: [{
        id, name: id, role: "agent", admin: false, status: "active", displayName: "stored-name",
        publicKey: "stored-basic-key", createdAt: STORED_CREATED_AT, ...STORED_FEDERATION,
      }] }),
    });
    expect(seedRes.status, `seed returned ${seedRes.status}: ${await seedRes.text()}`).toBe(200);
    const seeded = await rowIn(id);
    for (const [field, value] of Object.entries(STORED_FEDERATION)) expect(seeded?.[field], `seeded ${field}`).toBe(value);

    const path = `/Agent/${id}`;
    const basicPut = async (body: Record<string, unknown>) => {
      const res = await fetch(`${harper.httpURL}${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: adminBasic() },
        body: JSON.stringify(body),
      });
      return { status: res.status, text: await res.text() };
    };
    const base = { id, name: id, role: "agent", status: "active" };

    // The body supplies different values for originatorInstanceId and every
    // receiver federation field.
    const supplied = await basicPut({
      ...base, displayName: "basic-supplied",
      originatorInstanceId: "inst-forged", _originatorInstanceId: "forged", _syncedFrom: "forged", _syncedAt: "1999-01-01T00:00:00.000Z",
    });
    expect(supplied.status, `Admin Basic PUT (supplied) returned ${supplied.status}: ${supplied.text}`).toBeLessThan(300);
    const afterSupplied = await rowIn(id);
    expect(afterSupplied?.displayName, "the PUT's displayName was not stored").toBe("basic-supplied");
    for (const [field, value] of Object.entries(STORED_FEDERATION)) {
      expect(afterSupplied?.[field], `a PUT that supplied ${field} replaced it`).toBe(value);
    }
    expect(afterSupplied?.publicKey).toBe("stored-basic-key");
    expect(afterSupplied?.createdAt).toBe(STORED_CREATED_AT);

    // The body omits every carried field.
    const omitted = await basicPut({ ...base, displayName: "basic-omitted" });
    expect(omitted.status, `Admin Basic PUT (omitted) returned ${omitted.status}: ${omitted.text}`).toBeLessThan(300);
    const afterOmitted = await rowIn(id);
    expect(afterOmitted?.displayName, "the PUT's displayName was not stored").toBe("basic-omitted");
    for (const [field, value] of Object.entries(STORED_FEDERATION)) {
      expect(afterOmitted?.[field], `a PUT that omitted ${field} dropped it`).toBe(value);
    }
  }, 30_000);

  test("an administrator's PUT to an id with no stored row is refused 404 and writes no row", async () => {
    const id = `put2696-new-${randomUUID()}`;
    const path = `/Agent/${id}`;
    const res = await put(path, {
      id,
      name: id,
      publicKey: "new-key",
      createdAt: "2026-02-03T04:05:06.000Z",
    }, ADMIN);

    expect(res.status, `create-through-PUT returned ${res.status}, expected 404: ${res.text}`).toBe(404);
    const body = JSON.parse(res.text);
    expect(body.error).toBe("agent_put_requires_existing");
    expect(String(body.message)).toContain("POST /AgentSeed");
    expect(await rowIn(id), "a refused PUT wrote a row").toBeNull();
  }, 30_000);

  test("a signed non-admin PUT to a missing id is refused 403 and writes no row", async () => {
    // A PUT to an id with no record is a create to Harper, which checks the
    // resource's allowCreate() (administrators only) and refuses it before
    // put() runs.
    const id = `put2696-new-${randomUUID()}`;
    const res = await put(`/Agent/${id}`, { id, name: id, status: "active" }, OTHER);
    expect(res.status, `a non-admin PUT to a missing id returned ${res.status}: ${res.text}`).toBe(403);
    expect(await rowIn(id), "a refused PUT wrote a row").toBeNull();
  }, 30_000);

  test("an administrator's PUT is a full replacement: a stored status and role its body omits are not kept", async () => {
    const target = mkAgent(`put2696-status-${randomUUID().slice(0, 8)}`);
    const seedRes = await fetch(harper.opsURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
      },
      body: JSON.stringify({ operation: "insert", database: "flair", table: "Agent", records: [{
        id: target.id, name: target.id, role: "agent", admin: false, status: "deactivated",
        publicKey: target.publicKey, createdAt: STORED_CREATED_AT,
      }] }),
    });
    expect(seedRes.status, `seed returned ${seedRes.status}: ${await seedRes.text()}`).toBe(200);
    expect((await rowIn(target.id))?.status).toBe("deactivated");

    const res = await put(`/Agent/${target.id}`, { id: target.id, name: target.id, displayName: "put-name" }, ADMIN);
    expect(res.status, `admin PUT returned ${res.status}: ${res.text}`).toBeLessThan(300);

    const after = await rowIn(target.id);
    expect(after?.displayName).toBe("put-name");
    expect(after?.status ?? null, "the PUT kept a status its body did not name").toBeNull();
    expect(after?.role ?? null, "the PUT kept a role its body did not name").toBeNull();
    expect(after?.publicKey).toBe(target.publicKey);
  }, 30_000);

  test("an unauthorized PUT is refused and leaves the row byte-identical", async () => {
    const before = await rowIn(TARGET.id);
    expect(before).not.toBeNull();
    const path = `/Agent/${TARGET.id}`;

    const other = await put(path, { id: TARGET.id, name: TARGET.id, displayName: "hijacked" }, OTHER);
    expect(other.status, `another agent's PUT returned ${other.status}: ${other.text}`).toBe(403);
    expect(JSON.parse(other.text).error).toBe("agent_put_admin_only");
    expect(await rowIn(TARGET.id), "another agent's refused PUT changed the row").toEqual(before);

    const anonymous = await put(path, { id: TARGET.id, name: TARGET.id, displayName: "hijacked" }, null);
    expect(anonymous.status, `anonymous PUT returned ${anonymous.status}: ${anonymous.text}`).toBeGreaterThanOrEqual(400);
    expect(await rowIn(TARGET.id), "an anonymous refused PUT changed the row").toEqual(before);
  }, 60_000);

  test("PATCH keeps its merge behaviour", async () => {
    const before = await rowIn(TARGET.id);
    expect(before).not.toBeNull();
    const path = `/Agent/${TARGET.id}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: ed25519Header(ADMIN, "PATCH", path),
      },
      body: JSON.stringify({ runtime: "patched-runtime" }),
    });
    expect(res.status, `admin PATCH returned ${res.status}: ${await res.text()}`).toBeLessThan(300);

    const after = await rowIn(TARGET.id);
    expect(after?.runtime).toBe("patched-runtime");
    expect(after?.createdAt, "PATCH changed createdAt").toBe(before?.createdAt);
    expect(after?.publicKey, "PATCH changed publicKey").toBe(before?.publicKey);
  }, 30_000);
});
