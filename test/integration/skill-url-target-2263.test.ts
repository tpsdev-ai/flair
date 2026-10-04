// ─── flair#2263 — a skill PUT whose id is only in the URL ───────────────────
//
// `PUT /Memory/<X>` with a skill body that omits `id` writes at X, exactly as
// the stored-row lookup already reads. This suite drives real REST PUTs against
// a real Harper.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const A = mkAgent(`urlonly-owner-${sfx}`);
const now = () => new Date().toISOString();

let harper: HarperInstance;
let installDir = "";

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
}

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

function ed25519(who: TestAgent, method: string, path: string): string {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${who.id}:${ts}:${nonce}:${method}:${path}`), who.secretKey);
  return `TPS-Ed25519 ${who.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function call(auth: TestAgent, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: ed25519(auth, method, path) };
  const res = await fetch(harper.httpURL + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
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
  return (rows as any[]).sort((a, b) => Number(a.version) - Number(b.version));
}

async function memoryRow(id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] });
  return rows[0] ?? null;
}

const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;
const nextId = (label: string) => `urlonly-${label}-${sfx}`;

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  harper = await startHarper();
  installDir = harper.installDir;
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
  if (installDir) await rm(installDir, { recursive: true, force: true, maxRetries: 4 });
});

describe("flair#2263 — the URL-bound id is the skill write target", () => {
  test("PUT /Memory/<X> with a skill body that has only the URL id lands at X, and an identical retry resolves that same skill", async () => {
    const id = nextId("skill");
    const body = { agentId: A.id, content: "url-only skill", trigger: "when the url names the id", tags: ["skill"], durability: "persistent" };

    const first = await call(A, "PUT", memPath(id), body);
    expect(first.status, first.text.slice(0, 300)).toBeLessThan(300);
    expect(JSON.parse(first.text).id).toBe(id);
    const row = await memoryRow(id);
    expect(row?.skillSubjectId).toBe(id);
    const versions = await versionsOf(id);
    expect(versions.map((v) => v.kind)).toEqual(["create"]);
    expect(versions[0].memoryId).toBe(id);

    // The identical retry addresses the skill now stored at X. It supersedes
    // that skill (one subject) rather than creating a second, independent one.
    const retry = await call(A, "PUT", memPath(id), body);
    expect(retry.status, retry.text.slice(0, 300)).toBeLessThan(300);
    const successorId = JSON.parse(retry.text).id;
    expect(successorId).not.toBe(id);
    const successor = await memoryRow(successorId);
    expect(successor.supersedes).toBe(id);
    expect(successor.skillSubjectId).toBe(id);
    expect((await versionsOf(id)).map((v) => v.kind)).toEqual(["create", "update"]);
  }, 180_000);
});
