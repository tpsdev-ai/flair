// ─── flair#2998 — a Soul PATCH that fails validation leaves nothing behind ──
//
// Soul.patch validates the patch, then puts the merged row in the same
// transaction as the version append. A ValidationError there must answer 400
// and leave the stored row and its history untouched. This runs against a
// spawned, HOME-isolated Harper and compares the full stored row and the full
// version and event sets around the refused PATCH; a later valid PATCH is the
// positive control.
//
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { mkdtempSync, rmSync } from "node:fs";
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
const A = mkAgent(`soul-patch-a-${sfx}`);
const now = () => new Date().toISOString();

let harper: HarperInstance;
let scratchDir = "";

function assertOwnInstance(h: HarperInstance): void {
  expect(h.external, "external Harper instances are refused").toBe(false);
  expect(h.process?.pid, "startHarper must return a spawned process").toBeGreaterThan(0);
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

/** Every instruction event recorded for the subject, in id order. */
async function eventsOf(subjectId: string): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "OrgEvent",
    search_attribute: "kind", search_value: "soul.changed", get_attributes: ["*"],
  });
  return rows
    .filter((row: any) => JSON.parse(row.detail).subjectId === subjectId)
    .sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
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
  scratchDir = mkdtempSync(join(tmpdir(), "flair-2998-"));
  harper = await startHarper();
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
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

describe("flair#2998 — a Soul PATCH that fails validation", () => {
  test("returns 400 naming the field and leaves the row, versions and events unchanged", async () => {
    const key = `soul-patch-invalid-${sfx}`;
    const id = `${A.id}:${key}`;
    const subjectId = `${A.id}:${key}`;
    await createSoul(id, A.id, key, "before");

    const beforeRow = await soulRow(id);
    expect(beforeRow, "the seeded Soul row must be readable").not.toBeNull();
    const beforeVersions = await versionsOf(subjectId);
    const beforeEvents = await eventsOf(subjectId);
    expect(beforeVersions).toHaveLength(1);
    expect(beforeEvents).toHaveLength(1);

    const res = await call("PATCH", soulPath(id), { value: 123 });
    expect(res.status, res.text.slice(0, 300)).toBe(400);
    const body = JSON.parse(res.text);
    expect(body.code).toBe("ValidationError");
    expect(body.title).toContain("value");
    expect(Array.isArray(body.detail)).toBe(true);
    expect(body.detail.some((issue: any) => issue.path === "value"), JSON.stringify(body.detail)).toBe(true);

    // The whole row, not one field: the refused PATCH changed nothing.
    expect(await soulRow(id)).toEqual(beforeRow);
    expect(await versionsOf(subjectId)).toEqual(beforeVersions);
    expect(await eventsOf(subjectId)).toEqual(beforeEvents);
  }, 120_000);

  test("a subsequent valid PATCH succeeds and adds exactly one version", async () => {
    const key = `soul-patch-valid-${sfx}`;
    const id = `${A.id}:${key}`;
    const subjectId = `${A.id}:${key}`;
    await createSoul(id, A.id, key, "before");
    const beforeVersions = await versionsOf(subjectId);
    const beforeEvents = await eventsOf(subjectId);

    const invalid = await call("PATCH", soulPath(id), { value: 123 });
    expect(invalid.status, invalid.text.slice(0, 300)).toBe(400);

    const res = await call("PATCH", soulPath(id), { value: "after" });
    expect(res.status, res.text.slice(0, 300)).toBeLessThan(300);

    const row = await soulRow(id);
    expect(row.value).toBe("after");
    const versions = await versionsOf(subjectId);
    expect(versions).toHaveLength(beforeVersions.length + 1);
    expect(versions.map((version) => version.kind)).toEqual(["create", "update"]);
    expect(JSON.parse(versions[1].soulSnapshot).value).toBe("after");
    expect(await eventsOf(subjectId)).toHaveLength(beforeEvents.length + 1);
  }, 120_000);
});
