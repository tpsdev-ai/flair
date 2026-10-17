/**
 * orgevent-reserved-events-2139.test.ts — real Harper, over HTTP.
 *
 * flair#2139 slice 3a: reserved-event protection, no emission.
 *   - POST, single-id PUT/PATCH/DELETE and collection PUT refuse a proposed or
 *     stored reserved record (`soul.changed`/`skill.changed` kind, or an
 *     `instruction-change:` id prefix) with 403 `reserved_event` for agents,
 *     admin agents and the credentialed Basic admin;
 *   - a reserved element refuses a collection PUT as a whole: no element is
 *     written;
 *   - anonymous callers keep their existing 401;
 *   - `flair doctor` names a planted impostor and passes on a clean store;
 *   - an instruction event with no expiresAt survives an OrgEventMaintenance
 *     run, while an expired ordinary event is deleted.
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

describe("anonymous callers keep their existing 401", () => {
  it("POST, PUT, PATCH, DELETE and collection PUT on a reserved record are unauthenticated", async () => {
    const id = `stored-reserved-anon-${randomUUID()}`;
    await plantEvent(id);
    for (const [method, body] of [
      ["POST", { id: `${PREFIX}anon-${randomUUID()}`, kind: "status", summary: "x" }],
      ["PUT", { id, authorId: agent.id, kind: "status", summary: "x" }],
      ["PATCH", { summary: "x" }],
      ["DELETE", undefined],
      ["PUT", [{ id: `${PREFIX}anon-batch-${randomUUID()}`, authorId: agent.id, kind: "status", summary: "x" }]],
    ] as const) {
      const path = method === "POST" ? "/OrgEvent" : `/OrgEvent/${id}`;
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
  it("deletes the expired ordinary event and keeps the reserved event with no expiresAt", async () => {
    const reserved = `${PREFIX}maintenance-${randomUUID()}`;
    const expired = `expired-maintenance-${randomUUID()}`;
    await plantEvent(reserved, { kind: "skill.changed" });
    await plantEvent(expired, { kind: "status", expiresAt: "2001-01-01T00:00:00.000Z" });

    const res = await basicSend("POST", "/OrgEventMaintenance/", {});
    expect(res.status, (await res.text()).slice(0, 300)).toBeLessThan(300);

    expect(await readEvent(reserved)).not.toBeNull();
    expect(await readEvent(expired)).toBeNull();
  }, 30_000);
});
