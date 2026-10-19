// agent-authority-guard-2696.test.ts — flair#2696, against a REAL Harper.
//
// A non-admin write cannot change an agent's authority. The guard PUT and
// PATCH share (authorizePrincipalWrite in resources/Agent.ts) compares the
// stored `role` with the role the record will have once the body is merged
// onto the stored row and reconciled (reconcileAdminFields in
// resources/agent-admin.ts). `role === "admin"` is the authority; the `admin`
// field is a mirror and is not read as authority.
//
// Every row here carries `admin: true` without the admin role: the shape
// test/integration/admin-field-truth.test.ts seeds and shows is not an admin
// on the gate. Two variants, with no `role` and with `role: "agent"`. For each:
//   - its owner's signed PUT or PATCH naming `admin: true` or `role: "admin"`
//     is refused 403, and the row is byte-identical afterwards;
//   - its owner's ordinary self-update naming neither field succeeds and never
//     stores the admin role: a PATCH leaves `role` and `admin` as stored; a PUT
//     stores the body's fields, which name no role, with the mirror reconciled
//     to `admin: false`.
// An administrator's write naming `admin: true` on such a row is admitted and
// stores the admin role.
//
// The stored-row assertions read the committed row through an operations
// search_by_id in a separate request. The gate probe is an admin-only read.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
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
function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const [label, u] of [["http", http], ["ops", ops]] as const) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${label} target ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

/** ADMIN-ONLY probe: FederationInstance.allowRead() is allowAdmin(). */
const ADMIN_ONLY_PATH = "/FederationInstance";
const STORED_CREATED_AT = "2026-01-02T03:04:05.000Z";
const ADMIN = mkAgent("auth2696-admin");

let harper: HarperInstance;

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

async function send(method: "PUT" | "PATCH", caller: TestAgent, path: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(caller, method, path) },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function probeAdminOnly(agent: TestAgent): Promise<number> {
  const res = await fetch(`${harper.httpURL}${ADMIN_ONLY_PATH}`, {
    headers: { Authorization: ed25519Header(agent, "GET", ADMIN_ONLY_PATH) },
  });
  await res.text();
  return res.status;
}

/** The two variants of a row whose mirror says admin while its role does not. */
const MISMATCHED_ROWS: { label: string; fields: Record<string, unknown> }[] = [
  { label: "admin:true with no role", fields: { admin: true } },
  { label: "admin:true with role \"agent\"", fields: { role: "agent", admin: true } },
];

/** Seed a fresh mismatched row owned by its own key, and return that agent. */
async function seedMismatched(fields: Record<string, unknown>): Promise<TestAgent> {
  const agent = mkAgent(`auth2696-${randomUUID().slice(0, 13)}`);
  await adminOp({
    operation: "insert", database: "flair", table: "Agent",
    records: [{
      id: agent.id, name: agent.id, status: "active", displayName: "stored-name",
      runtime: "stored-runtime", publicKey: agent.publicKey, createdAt: STORED_CREATED_AT, ...fields,
    }],
  });
  const seeded = await rowIn(agent.id);
  expect(seeded?.admin, "the seeded row's mirror does not say admin").toBe(true);
  expect(seeded?.role, "the seeded row carries the admin role").not.toBe("admin");
  return agent;
}

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
  await adminOp({
    operation: "insert", database: "flair", table: "Agent",
    records: [{
      id: ADMIN.id, name: ADMIN.id, role: "admin", admin: true, status: "active",
      publicKey: ADMIN.publicKey, createdAt: STORED_CREATED_AT,
    }],
  });
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
}, HARPER_STOP_BUDGET_MS);

describe("flair#2696 — a non-admin write cannot change an agent's authority", () => {
  test("positive control: the admin principal passes the admin gate", async () => {
    expect(await probeAdminOnly(ADMIN)).toBe(200);
  }, 30_000);

  for (const shape of MISMATCHED_ROWS) {
    describe(`a row with ${shape.label}`, () => {
      const refusals: { name: string; method: "PUT" | "PATCH"; body: (id: string) => Record<string, unknown> }[] = [
        { name: "its owner's PUT naming admin: true", method: "PUT", body: (id) => ({ id, name: id, displayName: "put-name", admin: true }) },
        { name: "its owner's PUT naming role \"admin\"", method: "PUT", body: (id) => ({ id, name: id, displayName: "put-name", role: "admin" }) },
        { name: "its owner's PATCH naming admin: true", method: "PATCH", body: () => ({ admin: true }) },
        { name: "its owner's PATCH naming role \"admin\"", method: "PATCH", body: () => ({ role: "admin" }) },
      ];
      for (const c of refusals) {
        test(`${c.name} is refused 403 and the row is byte-identical`, async () => {
          const owner = await seedMismatched(shape.fields);
          const before = await rowIn(owner.id);
          const path = `/Agent/${owner.id}`;

          const res = await send(c.method, owner, path, c.body(owner.id));

          expect(res.status, `${c.method} answered ${res.status}: ${res.text}`).toBe(403);
          expect(JSON.parse(res.text).error).toBe("only admin principals can change a principal's admin status");
          expect(await rowIn(owner.id), "the refused write changed the row").toEqual(before);
          expect(await probeAdminOnly(owner), "the row's owner passes the admin gate").toBe(403);
        }, 30_000);
      }

      test("its owner's PATCH naming neither field succeeds and leaves role and admin as stored", async () => {
        const owner = await seedMismatched(shape.fields);
        const before = await rowIn(owner.id);
        const path = `/Agent/${owner.id}`;

        const res = await send("PATCH", owner, path, { runtime: "patched-runtime" });

        expect(res.status, `PATCH answered ${res.status}: ${res.text}`).toBeLessThan(300);
        const after = await rowIn(owner.id);
        expect(after?.runtime, "the PATCH's runtime was not stored").toBe("patched-runtime");
        expect(after?.role, "the PATCH changed the stored role").toBe(before?.role);
        expect(after?.admin, "the PATCH changed the stored admin mirror").toBe(before?.admin);
        expect(await probeAdminOnly(owner), "the row's owner passes the admin gate").toBe(403);
      }, 30_000);

      test("its owner's PUT naming neither field succeeds and stores no admin role", async () => {
        const owner = await seedMismatched(shape.fields);
        const path = `/Agent/${owner.id}`;

        const res = await send("PUT", owner, path, { id: owner.id, name: owner.id, displayName: "put-name" });

        expect(res.status, `PUT answered ${res.status}: ${res.text}`).toBeLessThan(300);
        const after = await rowIn(owner.id);
        expect(after?.displayName, "the PUT's displayName was not stored").toBe("put-name");
        expect(after?.role, "the PUT stored the admin role").not.toBe("admin");
        expect(after?.role ?? null, "the PUT stored a role its body did not name").toBeNull();
        expect(after?.admin, "the PUT did not reconcile the mirror to the stored role").toBe(false);
        expect(after?.publicKey, "the PUT replaced the stored publicKey").toBe(owner.publicKey);
        expect(await probeAdminOnly(owner), "the row's owner passes the admin gate").toBe(403);
      }, 30_000);
    });
  }

  test("an administrator's PATCH naming admin: true on such a row is admitted and stores the admin role", async () => {
    const target = await seedMismatched({ role: "agent", admin: true });
    const path = `/Agent/${target.id}`;

    const res = await send("PATCH", ADMIN, path, { admin: true });

    expect(res.status, `admin PATCH answered ${res.status}: ${res.text}`).toBeLessThan(300);
    const after = await rowIn(target.id);
    expect(after?.role).toBe("admin");
    expect(after?.admin).toBe(true);
  }, 30_000);
});
