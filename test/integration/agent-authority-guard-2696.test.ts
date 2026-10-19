// agent-authority-guard-2696.test.ts — flair#2696, against a REAL Harper.
//
// An Agent PUT is an administrator operation: a signed PUT from an agent that
// is not an administrator is refused 403 `agent_put_admin_only`, whatever its
// body names, and the row is byte-identical afterwards. Such an agent updates
// its own record with PATCH, which merges the body into the stored row.
//
// A non-admin PATCH that names `role` or `admin` goes through the guard in
// authorizePrincipalWrite (resources/Agent.ts): it compares the role of the
// row it reads with the role that row would have once the body is merged onto
// it and reconciled (reconcileAdminFields in resources/agent-admin.ts).
// `role === "admin"` is the authority; the `admin` field is a mirror and is not
// read as authority. A change an administrator commits after that read is
// covered by agent-patch-race-2696.test.ts.
//
// The PUT refusals run on an ordinary row and on rows whose mirror says admin
// while the role does not: the shape test/integration/admin-field-truth.test.ts
// seeds and shows is not an admin on the gate (two variants, with no `role`
// and with `role: "agent"`). On each mismatched row:
//   - its owner's PATCH naming `admin: true` or `role: "admin"` is refused 403,
//     and the row is byte-identical afterwards;
//   - its owner's PATCH naming neither field succeeds and leaves `role` and
//     `admin` as stored.
// An administrator's PATCH naming `admin: true` on such a row is admitted and
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

/** An ordinary non-admin row, plus the two mismatched variants. */
const PUT_ROWS: { label: string; fields: Record<string, unknown>; mismatched: boolean }[] = [
  { label: "role \"agent\" and admin:false", fields: { role: "agent", admin: false }, mismatched: false },
  ...MISMATCHED_ROWS.map((row) => ({ ...row, mismatched: true })),
];

/** Seed a fresh row owned by its own key, and return that agent. */
async function seedRow(fields: Record<string, unknown>): Promise<TestAgent> {
  const agent = mkAgent(`auth2696-${randomUUID().slice(0, 13)}`);
  await adminOp({
    operation: "insert", database: "flair", table: "Agent",
    records: [{
      id: agent.id, name: agent.id, status: "active", displayName: "stored-name",
      runtime: "stored-runtime", publicKey: agent.publicKey, createdAt: STORED_CREATED_AT, ...fields,
    }],
  });
  expect(await rowIn(agent.id), "the row was not seeded").not.toBeNull();
  return agent;
}

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

describe("flair#2696 — an agent that is not an administrator cannot PUT, and its PATCH cannot change admin status", () => {
  test("positive control: the admin principal passes the admin gate", async () => {
    expect(await probeAdminOnly(ADMIN)).toBe(200);
  }, 30_000);

  for (const row of PUT_ROWS) {
    describe(`a row with ${row.label}`, () => {
      const putRefusals: { name: string; body: (id: string) => Record<string, unknown> }[] = [
        { name: "its owner's PUT naming neither role nor admin", body: (id) => ({ id, name: id, displayName: "put-name" }) },
        { name: "its owner's PUT naming admin: true", body: (id) => ({ id, name: id, displayName: "put-name", admin: true }) },
        { name: "its owner's PUT naming role \"admin\"", body: (id) => ({ id, name: id, displayName: "put-name", role: "admin" }) },
        { name: "its owner's PUT naming status", body: (id) => ({ id, name: id, displayName: "put-name", status: "active" }) },
      ];
      for (const c of putRefusals) {
        test(`${c.name} is refused 403 agent_put_admin_only and the row is byte-identical`, async () => {
          const owner = row.mismatched ? await seedMismatched(row.fields) : await seedRow(row.fields);
          const before = await rowIn(owner.id);
          const path = `/Agent/${owner.id}`;

          const res = await send("PUT", owner, path, c.body(owner.id));

          expect(res.status, `PUT answered ${res.status}: ${res.text}`).toBe(403);
          expect(JSON.parse(res.text).error).toBe("agent_put_admin_only");
          expect(await rowIn(owner.id), "the refused PUT changed the row").toEqual(before);
          expect(await probeAdminOnly(owner), "the row's owner passes the admin gate").toBe(403);
        }, 30_000);
      }
    });
  }

  for (const shape of MISMATCHED_ROWS) {
    describe(`a row with ${shape.label}`, () => {
      const patchRefusals: { name: string; body: Record<string, unknown> }[] = [
        { name: "its owner's PATCH naming admin: true", body: { admin: true } },
        { name: "its owner's PATCH naming role \"admin\"", body: { role: "admin" } },
      ];
      for (const c of patchRefusals) {
        test(`${c.name} is refused 403 and the row is byte-identical`, async () => {
          const owner = await seedMismatched(shape.fields);
          const before = await rowIn(owner.id);
          const path = `/Agent/${owner.id}`;

          const res = await send("PATCH", owner, path, c.body);

          expect(res.status, `PATCH answered ${res.status}: ${res.text}`).toBe(403);
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
