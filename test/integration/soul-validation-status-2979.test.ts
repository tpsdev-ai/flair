// ─── flair#2979 — a Soul schema validation failure keeps its 400 ────────────
//
// Soul.ts validates inside recordVersion's `prepare`, i.e. inside the
// instruction-version append's transaction. Before this fix the append helper's
// catch converted every non-RowMutationDenied throw into a 500
// `instruction_version_append_failed`, including Harper's own 400
// ValidationError. These tests run against a spawned, HOME-isolated Harper:
//   - a numeric `value` returns 400, names the field, and leaves no Soul row
//     and no InstructionVersion row;
//   - a forced append failure still returns the 500 append error and rolls the
//     staged Soul row and version back;
//   - a valid Soul PUT still succeeds and records its version.
//
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const A = mkAgent(`soul-valid-a-${sfx}`);
const now = () => new Date().toISOString();

let harper: HarperInstance;
let pauseDir = "";

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
}

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(harper.httpURL + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(operation),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

async function versionsOf(subjectId: string): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "InstructionVersion",
    search_attribute: "subjectId", search_value: subjectId, get_attributes: ["*"],
  });
  return rows.sort((a: any, b: any) => Number(a.version) - Number(b.version));
}

async function soulRow(id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table: "Soul", ids: [id], get_attributes: ["*"] });
  return rows[0] ?? null;
}

const soulPath = (id: string) => `/Soul/${encodeURIComponent(id)}`;

async function createSoul(id: string, agentId: string, key: string, value: string): Promise<void> {
  const res = await call("POST", "/Soul/", { id, agentId, key, value, durability: "permanent" });
  expect(res.status, `Soul POST ${id}: ${res.text.slice(0, 200)}`).toBeLessThan(300);
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2979-pause-"));
  harper = await startHarper({
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir },
  });
  assertOwnInstance(harper);
  await ops({
    operation: "upsert", database: "flair", table: "Agent",
    records: [{ id: A.id, name: A.id, role: "agent", publicKey: A.publicKey, createdAt: now() }],
  });
  await ensureFlairAgentRole(harper.opsURL, harper.admin.username, harper.admin.password);
  await ensureFlairAgentUser(harper.opsURL, harper.admin.username, harper.admin.password);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (harper?.installDir) await rm(harper.installDir, { recursive: true, force: true, maxRetries: 4 });
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2979 — a Soul schema validation failure", () => {
  test("a numeric value returns the validator's 400 naming the field and writes nothing", async () => {
    const key = `soul-invalid-${sfx}`;
    const id = `${A.id}:${key}`;
    const subjectId = `${A.id}:${key}`;

    const res = await call("PUT", soulPath(id), { id, agentId: A.id, key, value: 123 });
    expect(res.status, res.text.slice(0, 300)).toBe(400);
    const body = JSON.parse(res.text);
    expect(body.code).toBe("ValidationError");
    expect(body.title).toContain("value");
    expect(Array.isArray(body.detail)).toBe(true);
    expect(body.detail.some((issue: any) => issue.path === "value"), JSON.stringify(body.detail)).toBe(true);

    expect(await soulRow(id)).toBeNull();
    expect(await versionsOf(subjectId)).toHaveLength(0);
  }, 120_000);

  test("a forced append failure still returns instruction_version_append_failed and writes nothing", async () => {
    const key = `soul-append-fail-${sfx}`;
    const id = `${A.id}:${key}`;
    const subjectId = `${A.id}:${key}`;
    await createSoul(id, A.id, key, "before");
    const beforeRow = await soulRow(id);
    const beforeVersions = await versionsOf(subjectId);
    expect(beforeVersions).toHaveLength(1);

    // The helper's test-only switch (txnFault, armed by file) fails the append
    // after the version row is staged, inside the owned transaction.
    writeFileSync(join(pauseDir, "fail.instruction-version-append-fail"), "");
    const res = await call("PUT", soulPath(id), { id, agentId: A.id, key, value: "after" });
    expect(res.status, res.text.slice(0, 300)).toBe(500);
    expect(JSON.parse(res.text).error).toBe("instruction_version_append_failed");

    expect(await soulRow(id)).toEqual(beforeRow);
    expect(await versionsOf(subjectId)).toEqual(beforeVersions);
  }, 120_000);

  test("a valid Soul PUT succeeds and records its version", async () => {
    const key = `soul-write-${sfx}`;
    const id = `${A.id}:${key}`;
    await createSoul(id, A.id, key, "v1");

    const res = await call("PUT", soulPath(id), { id, agentId: A.id, key, value: "v2" });
    expect(res.status, res.text.slice(0, 300)).toBeLessThan(300);

    const rows = await versionsOf(`${A.id}:${key}`);
    expect(rows.map((row) => row.kind)).toEqual(["create", "update"]);
    expect(JSON.parse(rows[1].soulSnapshot).value).toBe("v2");
  }, 120_000);
});
