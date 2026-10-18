/**
 * orgevent-reserved-events-2139.test.ts — real Harper, over HTTP.
 *
 * flair#2139 slice 3a: reserved-event protection, no emission.
 *   - POST, single-id PUT/PATCH/DELETE and collection PUT/DELETE refuse a
 *     proposed or stored reserved record (`soul.changed`/`skill.changed` kind,
 *     or an `instruction-change:` id prefix) for agents, admin agents and the
 *     credentialed Basic admin;
 *   - a POST to a reserved addressed id with an ordinary body, and a PATCH
 *     that would create a row at a reserved addressed id, are refused;
 *   - a reserved element refuses a collection PUT as a whole: no element is
 *     written;
 *   - a collection DELETE that selects a reserved row is refused before
 *     anything is deleted; an ordinary-only selection deletes;
 *   - anonymous callers are refused with 401;
 *   - `flair doctor` names a planted impostor and passes on a clean store; it
 *     lists every impostor id, and a real matching InstructionVersion passes;
 *   - a reserved event survives an OrgEventMaintenance run, including one
 *     carrying an expired expiresAt, while an expired ordinary event is deleted;
 *     non-admin and anonymous callers are denied on OrgEventMaintenance.
 *
 * Impostor rows are planted through the raw operations API, the documented
 * exception to the resource guard.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline";
import { nodeBin } from "../helpers/node-runtime";
import { HARPER_STOP_BUDGET_MS, HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";

const CLI = join(process.cwd(), "dist", "cli.js");
const ADMIN_PASS = "test123";
const RESERVED = "reserved_event";
const PREFIX = "instruction-change:";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}
function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}
function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

let harper: HarperInstance;
let cliHome: string;
const agent = mkAgent("agent-a");
const adminAgent = mkAgent("agent-admin-a");

const basic = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
async function ops(op: Record<string, unknown>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify({ database: "flair", ...op }),
    signal: AbortSignal.timeout(15_000),
  });
}
async function adminOp(op: Record<string, unknown>): Promise<any> {
  const res = await ops(op);
  const text = await res.text();
  expect(res.status, `${op.operation} returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
  return text.length ? JSON.parse(text) : null;
}
async function seedAgent(a: TestAgent, role: "agent" | "admin"): Promise<void> {
  await adminOp({
    operation: "insert", table: "Agent",
    records: [{ id: a.id, name: a.id, role, publicKey: a.publicKey, createdAt: new Date().toISOString() }],
  });
}
async function send(who: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(who, method, path), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function basicSend(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: basic(), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function anonSend(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function readEvent(id: string): Promise<any> {
  const rows = await adminOp({
    operation: "search_by_hash", table: "OrgEvent", hash_values: [id], get_attributes: ["*"],
  });
  return (rows as any[])[0] ?? null;
}
async function plantEvent(id: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await adminOp({
    operation: "insert", table: "OrgEvent",
    records: [{
      id,
      authorId: agent.id,
      kind: "soul.changed",
      summary: "planted",
      refId: `soul:${agent.id}:key`,
      createdAt: new Date().toISOString(),
      ...overrides,
    }],
  });
}
async function deleteEvent(id: string): Promise<void> {
  await adminOp({ operation: "delete", table: "OrgEvent", hash_values: [id] });
}
async function countEvents(): Promise<number> {
  const rows = await adminOp({ operation: "sql", sql: "SELECT id FROM flair.OrgEvent" });
  const list = Array.isArray(rows) ? rows : rows?.results;
  if (!Array.isArray(list)) throw new Error(`sql read returned no row array: ${JSON.stringify(rows).slice(0, 200)}`);
  return list.length;
}
async function plantVersion(id: string, subjectType: string): Promise<void> {
  await adminOp({
    operation: "insert", table: "InstructionVersion",
    records: [{
      id, subjectType, subjectId: `soul:${agent.id}:key`, agentId: agent.id, key: "key",
      version: 1, kind: "create", rowId: `soul:${agent.id}:key`, valueHash: "hash",
      previousVersionHash: null, recordHash: "hash", soulSnapshot: null, memoryId: null,
      visibility: null, actorKind: "internal", actorId: null, sourceClass: "internal",
      createdAt: new Date().toISOString(), guarded: false, expectedVersion: null,
    }],
  });
}

function expectReserved(status: number, text: string): void {
  expect(status, text.slice(0, 300)).toBe(403);
  expect(JSON.parse(text).error).toBe(RESERVED);
}

function runDoctor(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = ["doctor", "--port", new URL(harper.httpURL).port];
    const startedAt = Date.now();
    const env = {
      ...process.env,
      HOME: cliHome,
      FLAIR_URL: harper.httpURL,
      FLAIR_OPS_PORT: new URL(harper.opsURL).port,
      FLAIR_TOKEN: "",
      FLAIR_ADMIN_PASS: ADMIN_PASS,
      NO_COLOR: "1",
    };
    const child = spawn(nodeBin({ env }), [CLI, ...args], { env, timeout: 20_000 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(args), 20_000, { status: code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt, timeoutSignal: "SIGTERM" })));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
  cliHome = await mkdtemp(join(tmpdir(), "flair-2139s3a-doctor-home-"));
  await seedAgent(agent, "agent");
  await seedAgent(adminAgent, "admin");
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (cliHome) await rm(cliHome, { recursive: true, force: true, maxRetries: 4 });
}, HARPER_STOP_BUDGET_MS);

describe("flair doctor names stored reserved-event impostors", () => {
  it("passes on a clean store, names a planted impostor, and passes again after it is removed", async () => {
    const clean = await runDoctor();
    expect(clean.stdout).toContain("No stored OrgEvent carries a reserved kind or id without a matching InstructionVersion.");

    const impostor = `${PREFIX}not-a-version-${randomUUID()}`;
    await plantEvent(impostor);
    const reported = await runDoctor();
    expect(reported.stdout).toContain(impostor);
    expect(reported.stdout).not.toContain("No stored OrgEvent carries a reserved kind or id without a matching InstructionVersion.");

    await deleteEvent(impostor);
    const cleanAgain = await runDoctor();
    expect(cleanAgain.stdout).toContain("No stored OrgEvent carries a reserved kind or id without a matching InstructionVersion.");
  }, 90_000);

  it("lists every impostor id when more than ten are stored", async () => {
    const ids = Array.from({ length: 12 }, () => `${PREFIX}many-${randomUUID()}`);
    for (const id of ids) await plantEvent(id);
    const reported = await runDoctor();
    for (const id of ids) expect(reported.stdout, id).toContain(id);
    expect(reported.stdout).toContain("12 stored OrgEvent rows carry");
    for (const id of ids) await deleteEvent(id);
  }, 120_000);

  it("passes a real matching InstructionVersion and names a mismatched one", async () => {
    const versionId = `version-${randomUUID()}`;
    const matched = `${PREFIX}${versionId}`;
    await plantVersion(versionId, "soul");
    await plantEvent(matched, { kind: "soul.changed", refId: versionId });
    const passed = await runDoctor();
    expect(passed.stdout).not.toContain(matched);
    expect(passed.stdout).toContain("No stored OrgEvent carries a reserved kind or id without a matching InstructionVersion.");

    // A subject-type mismatch fails the reader rule.
    await adminOp({
      operation: "update", table: "InstructionVersion",
      records: [{ id: versionId, subjectType: "skill" }],
    });
    const mismatched = await runDoctor();
    expect(mismatched.stdout).toContain(matched);

    await deleteEvent(matched);
    await adminOp({ operation: "delete", table: "InstructionVersion", hash_values: [versionId] });
  }, 120_000);
});

describe("a proposed reserved record is refused on every write shape", () => {
  const principals: Array<{ name: string; send: (m: string, p: string, b?: unknown) => Promise<Response> }> = [
    { name: "agent", send: (m, p, b) => send(agent, m, p, b) },
    { name: "admin agent", send: (m, p, b) => send(adminAgent, m, p, b) },
    { name: "Basic admin", send: (m, p, b) => basicSend(m, p, b) },
  ];

  for (const p of principals) {
    it(`${p.name} POST of a reserved kind or prefix is refused and stores nothing`, async () => {
      for (const body of [
        { id: `reserved-kind-${randomUUID()}`, kind: "soul.changed", summary: "x" },
        { id: `${PREFIX}proposed-${randomUUID()}`, kind: "status", summary: "x" },
      ]) {
        const res = await p.send("POST", "/OrgEvent", body);
        expectReserved(res.status, await res.text());
        expect(await readEvent(body.id)).toBeNull();
      }
    }, 30_000);

    it(`${p.name} PUT of a reserved id is refused and stores nothing`, async () => {
      const id = `${PREFIX}put-${randomUUID()}`;
      const res = await p.send("PUT", `/OrgEvent/${id}`, { id, authorId: agent.id, kind: "status", summary: "x" });
      expectReserved(res.status, await res.text());
      expect(await readEvent(id)).toBeNull();
    }, 30_000);

    it(`${p.name} PATCH that proposes a reserved kind is refused and leaves the row unchanged`, async () => {
      const id = `ordinary-patch-${randomUUID()}`;
      await plantEvent(id, { kind: "status", authorId: p.name === "agent" ? agent.id : adminAgent.id });
      const before = await readEvent(id);
      const res = await p.send("PATCH", `/OrgEvent/${id}`, { kind: "skill.changed", summary: "changed" });
      expectReserved(res.status, await res.text());
      expect(await readEvent(id)).toEqual(before);
    }, 30_000);

    it(`${p.name} collection PUT with a reserved element is refused as a whole`, async () => {
      const ordinary = `ordinary-batch-${randomUUID()}`;
      const reserved = `${PREFIX}batch-${randomUUID()}`;
      const res = await p.send("PUT", "/OrgEvent/", [
        { id: ordinary, authorId: agent.id, kind: "status", summary: "new sibling" },
        { id: reserved, authorId: agent.id, kind: "status", summary: "reserved sibling" },
      ]);
      expectReserved(res.status, await res.text());
      expect(await readEvent(ordinary)).toBeNull();
      expect(await readEvent(reserved)).toBeNull();
    }, 30_000);
  }
});

describe("a stored reserved record is refused on every write shape", () => {
  it("agent POST naming a stored reserved row with an ordinary body is refused", async () => {
    const id = `stored-reserved-post-${randomUUID()}`;
    await plantEvent(id, { kind: "soul.changed", authorId: agent.id });
    const before = await readEvent(id);
    const res = await send(agent, "POST", "/OrgEvent", { id, kind: "status", summary: "overwrite" });
    expectReserved(res.status, await res.text());
    expect(await readEvent(id)).toEqual(before);
  }, 30_000);

  for (const [name, method] of [["PUT", "PUT"], ["PATCH", "PATCH"], ["DELETE", "DELETE"]] as const) {
    it(`agent ${name} of a stored reserved row is refused and the row is unchanged`, async () => {
      const id = `stored-reserved-${name.toLowerCase()}-${randomUUID()}`;
      await plantEvent(id, { authorId: agent.id });
      const before = await readEvent(id);
      const res = method === "DELETE"
        ? await send(agent, method, `/OrgEvent/${id}`)
        : await send(agent, method, `/OrgEvent/${id}`, method === "PATCH"
          ? { summary: "changed" }
          : { id, authorId: agent.id, kind: "status", summary: "changed" });
      expectReserved(res.status, await res.text());
      expect(await readEvent(id)).toEqual(before);
    }, 30_000);

    it(`Basic admin ${name} of a stored reserved row is refused and the row is unchanged`, async () => {
      const id = `stored-reserved-basic-${name.toLowerCase()}-${randomUUID()}`;
      await plantEvent(id);
      const before = await readEvent(id);
      const res = method === "DELETE"
        ? await basicSend(method, `/OrgEvent/${id}`)
        : await basicSend(method, `/OrgEvent/${id}`, method === "PATCH"
          ? { summary: "changed" }
          : { id, authorId: agent.id, kind: "status", summary: "changed" });
      expectReserved(res.status, await res.text());
      expect(await readEvent(id)).toEqual(before);
    }, 30_000);
  }

  it("agent collection PUT naming a stored reserved row with an ordinary element is refused", async () => {
    const id = `stored-reserved-batch-${randomUUID()}`;
    await plantEvent(id, { authorId: agent.id });
    const before = await readEvent(id);
    const res = await send(agent, "PUT", "/OrgEvent/", [{ id, authorId: agent.id, kind: "status", summary: "overwrite" }]);
    expectReserved(res.status, await res.text());
    expect(await readEvent(id)).toEqual(before);
  }, 30_000);
});

describe("a reserved addressed id is refused without a proposed marker", () => {
  const principals: Array<{ name: string; send: (m: string, p: string, b?: unknown) => Promise<Response> }> = [
    { name: "agent", send: (m, p, b) => send(agent, m, p, b) },
    { name: "Basic admin", send: (m, p, b) => basicSend(m, p, b) },
  ];

  for (const p of principals) {
    it(`${p.name} POST to a reserved addressed id with an ordinary body stores nothing`, async () => {
      const id = `${PREFIX}addressed-${randomUUID()}`;
      const res = await p.send("POST", `/OrgEvent/${id}`, { kind: "status", summary: "no body id" });
      expectReserved(res.status, await res.text());
      expect(await readEvent(id)).toBeNull();
    }, 30_000);

    it(`${p.name} PATCH that would create a row at a reserved addressed id is refused`, async () => {
      const id = `${PREFIX}patch-create-${randomUUID()}`;
      const res = await p.send("PATCH", `/OrgEvent/${id}`, { kind: "status", summary: "create via patch" });
      expectReserved(res.status, await res.text());
      expect(await readEvent(id)).toBeNull();
    }, 30_000);
  }
});

describe("a collection DELETE selecting a reserved row is refused before it deletes", () => {
  it("refuses a mixed selection untouched, then deletes an ordinary-only selection", async () => {
    const kind = `ordinary-bulk-${randomUUID()}`;
    const ordinaryIds = [`${kind}-a`, `${kind}-b`];
    const reservedId = `${PREFIX}bulk-${randomUUID()}`;
    for (const id of ordinaryIds) {
      await adminOp({ operation: "insert", table: "OrgEvent", records: [{ id, authorId: agent.id, kind, summary: "ordinary", createdAt: new Date().toISOString() }] });
    }
    await plantEvent(reservedId);
    const before = await countEvents();

    const refused = await basicSend("DELETE", "/OrgEvent/");
    expectReserved(refused.status, await refused.text());
    expect(await countEvents()).toBe(before);
    for (const id of [...ordinaryIds, reservedId]) expect(await readEvent(id)).not.toBeNull();

    const deleted = await basicSend("DELETE", `/OrgEvent/?kind=${encodeURIComponent(kind)}`);
    expect(deleted.status, (await deleted.text()).slice(0, 300)).toBeLessThan(300);
    for (const id of ordinaryIds) expect(await readEvent(id)).toBeNull();
    expect(await readEvent(reservedId)).not.toBeNull();

    await deleteEvent(reservedId);
  }, 60_000);

  it("refuses a projected collection DELETE that selects a reserved row and deletes nothing", async () => {
    const kind = `ordinary-projected-${randomUUID()}`;
    const ordinaryIds = [`${kind}-a`, `${kind}-b`];
    const reservedId = `${PREFIX}projected-${randomUUID()}`;
    for (const id of ordinaryIds) {
      await adminOp({ operation: "insert", table: "OrgEvent", records: [{ id, authorId: agent.id, kind, summary: "ordinary", createdAt: new Date().toISOString() }] });
    }
    await plantEvent(reservedId);
    const before = await countEvents();

    const refused = await basicSend("DELETE", "/OrgEvent/?select(summary)");
    expectReserved(refused.status, await refused.text());
    expect(await countEvents()).toBe(before);
    for (const id of [...ordinaryIds, reservedId]) expect(await readEvent(id)).not.toBeNull();

    for (const id of ordinaryIds) await deleteEvent(id);
    await deleteEvent(reservedId);
  }, 60_000);
});

describe("anonymous callers are refused with 401", () => {
  it("POST, PUT, PATCH, DELETE and collection PUT on a reserved record are unauthenticated", async () => {
    const id = `stored-reserved-anon-${randomUUID()}`;
    await plantEvent(id);
    for (const [method, path, body] of [
      ["POST", "/OrgEvent", { id: `${PREFIX}anon-${randomUUID()}`, kind: "status", summary: "x" }],
      ["PUT", `/OrgEvent/${id}`, { id, authorId: agent.id, kind: "status", summary: "x" }],
      ["PATCH", `/OrgEvent/${id}`, { summary: "x" }],
      ["DELETE", `/OrgEvent/${id}`, undefined],
      ["PUT", "/OrgEvent/", [{ id: `${PREFIX}anon-batch-${randomUUID()}`, authorId: agent.id, kind: "status", summary: "x" }]],
    ] as const) {
      const res = await anonSend(method, path, body);
      expect(res.status, `${method} ${path}: ${(await res.text()).slice(0, 200)}`).toBe(401);
    }
  }, 30_000);
});

describe("ordinary events are unchanged", () => {
  it("POST, PUT, PATCH and DELETE of an ordinary event succeed", async () => {
    const id = `ordinary-verb-${randomUUID()}`;
    const post = await send(agent, "POST", "/OrgEvent", { id, kind: "status", summary: "created" });
    expect(post.status, (await post.text()).slice(0, 300)).toBeLessThan(300);

    const put = await send(agent, "PUT", `/OrgEvent/${id}`, { id, authorId: agent.id, kind: "status", summary: "put" });
    expect(put.status, (await put.text()).slice(0, 300)).toBeLessThan(300);

    const patch = await send(agent, "PATCH", `/OrgEvent/${id}`, { summary: "patched" });
    expect(patch.status, (await patch.text()).slice(0, 300)).toBeLessThan(300);
    expect((await readEvent(id)).summary).toBe("patched");

    const del = await send(agent, "DELETE", `/OrgEvent/${id}`);
    expect(del.status, (await del.text()).slice(0, 300)).toBeLessThan(300);
    expect(await readEvent(id)).toBeNull();
  }, 30_000);
});

describe("an instruction event survives OrgEventMaintenance", () => {
  it("deletes the expired ordinary event and keeps reserved events, including an expired one", async () => {
    const reserved = `${PREFIX}maintenance-${randomUUID()}`;
    const expiredReserved = `${PREFIX}maintenance-expired-${randomUUID()}`;
    const expired = `expired-maintenance-${randomUUID()}`;
    await plantEvent(reserved, { kind: "skill.changed" });
    await plantEvent(expiredReserved, { kind: "skill.changed", expiresAt: "2001-01-01T00:00:00.000Z" });
    await plantEvent(expired, { kind: "status", expiresAt: "2001-01-01T00:00:00.000Z" });

    const res = await send(adminAgent, "POST", "/OrgEventMaintenance/", {});
    const maintText = await res.text();
    expect(res.status, `maintenance ${res.status}: ${maintText.slice(0, 300)}`).toBeLessThan(300);

    expect(await readEvent(reserved)).not.toBeNull();
    expect(await readEvent(expiredReserved)).not.toBeNull();
    expect(await readEvent(expired)).toBeNull();

    await deleteEvent(reserved);
    await deleteEvent(expiredReserved);
  }, 30_000);

  it("refuses a reserved create that carries expiresAt", async () => {
    const id = `${PREFIX}create-expiry-${randomUUID()}`;
    const res = await send(agent, "POST", "/OrgEvent", {
      id, kind: "skill.changed", summary: "x", expiresAt: "2001-01-01T00:00:00.000Z",
    });
    expectReserved(res.status, await res.text());
    expect(await readEvent(id)).toBeNull();
  }, 30_000);

  it("denies a non-admin agent and an anonymous caller", async () => {
    const nonAdmin = await send(agent, "POST", "/OrgEventMaintenance/", {});
    expect([401, 403], `non-admin ${nonAdmin.status}`).toContain(nonAdmin.status);
    const anonymous = await anonSend("POST", "/OrgEventMaintenance/", {});
    expect([401, 403], `anonymous ${anonymous.status}`).toContain(anonymous.status);
  }, 30_000);
});
