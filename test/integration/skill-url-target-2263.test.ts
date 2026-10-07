// ─── flair#2263 — a skill PUT whose id is only in the URL ───────────────────
//
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

async function call(auth: TestAgent | "basic", method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: auth === "basic" ? basicAuth() : ed25519(auth, method, path) };
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

async function writeFootprint(): Promise<{ memories: number; versions: number }> {
  const memories = await ops({
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "agentId", search_value: A.id, get_attributes: ["id"],
  });
  const versions = await ops({
    operation: "search_by_value", database: "flair", table: "InstructionVersion",
    search_attribute: "id", search_value: "*", get_attributes: ["id"],
  });
  return { memories: (memories as any[]).length, versions: (versions as any[]).length };
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

describe("flair#2263 — the URL-bound id is the skill write target when the body ID is absent or null", () => {
  test("PUT /Memory/<X> with a skill body that has only the URL id creates at X, and an identical retry writes a successor id with supersedes X and skillSubjectId X", async () => {
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

    const retry = await call(A, "PUT", memPath(id), body);
    expect(retry.status, retry.text.slice(0, 300)).toBeLessThan(300);
    const successorId = JSON.parse(retry.text).id;
    expect(successorId).not.toBe(id);
    const successor = await memoryRow(successorId);
    expect(successor.supersedes).toBe(id);
    expect(successor.skillSubjectId).toBe(id);
    expect((await versionsOf(id)).map((v) => v.kind)).toEqual(["create", "update"]);
  }, 180_000);

  test("an operator feed write whose array id stringifies to the seed id is refused", async () => {
    const id = "skill:using-flair";
    const before = await memoryRow(id);
    const versions = await versionsOf(id);
    const result = await call("basic", "POST", "/FeedMemories", {
      id: [id], agentId: harper.admin.username, content: "fed", trigger: "t", tags: ["skill"], durability: "persistent",
    });
    expect(result.status, result.text.slice(0, 300)).toBe(403);
    expect(JSON.parse(result.text).error).toStartWith("seed_id_reserved");
    expect(await memoryRow(id)).toEqual(before);
    expect(await versionsOf(id)).toEqual(versions);
  }, 180_000);

  test("the feed refuses a body id that differs from its URL-bound id", async () => {
    const id = nextId("feed-url");
    const bodyId = nextId("feed-body");
    const result = await call(A, "POST", `/FeedMemories/${encodeURIComponent(id)}`, {
      id: bodyId, agentId: A.id, content: "feed skill", trigger: "t", tags: ["skill"], durability: "persistent",
    });
    expect(result.status, result.text.slice(0, 300)).toBe(400);
    expect(JSON.parse(result.text).error).toBe("id_target_mismatch");
    expect(await memoryRow(id)).toBeNull();
    expect(await memoryRow(bodyId)).toBeNull();
    expect(await versionsOf(bodyId)).toEqual([]);
  }, 180_000);

  test("PUT /Memory/<X> refuses a body id array that names X and writes no row or version", async () => {
    const id = nextId("put-array");
    const before = await writeFootprint();
    const result = await call(A, "PUT", memPath(id), {
      id: [id], agentId: A.id, content: "array-id skill", trigger: "t", tags: ["skill"], durability: "persistent",
    });
    expect(result.status, result.text.slice(0, 300)).toBe(400);
    expect(JSON.parse(result.text).error).toBe("id_target_mismatch");
    expect(await memoryRow(id)).toBeNull();
    expect(await versionsOf(id)).toEqual([]);
    expect(await writeFootprint()).toEqual(before);
  }, 180_000);

  test("the feed refuses a body id array that names its URL-bound id and writes no row or version", async () => {
    const id = nextId("feed-array");
    const before = await writeFootprint();
    const result = await call(A, "POST", `/FeedMemories/${encodeURIComponent(id)}`, {
      id: [id], agentId: A.id, content: "array-id feed skill", trigger: "t", tags: ["skill"], durability: "persistent",
    });
    expect(result.status, result.text.slice(0, 300)).toBe(400);
    expect(JSON.parse(result.text).error).toBe("id_target_mismatch");
    expect(await memoryRow(id)).toBeNull();
    expect(await versionsOf(id)).toEqual([]);
    expect(await writeFootprint()).toEqual(before);
  }, 180_000);

  test("PUT /Memory/<X> refuses an object body id that stringifies to X and writes no row or version", async () => {
    const id = String({});
    const before = await writeFootprint();
    const result = await call(A, "PUT", memPath(id), {
      id: { label: "object-id" }, agentId: A.id, content: "object-id skill", trigger: "t", tags: ["skill"], durability: "persistent",
    });
    expect(result.status, result.text.slice(0, 300)).toBe(400);
    expect(JSON.parse(result.text).error).toBe("id_target_mismatch");
    expect(await memoryRow(id)).toBeNull();
    expect(await versionsOf(id)).toEqual([]);
    expect(await writeFootprint()).toEqual(before);
  }, 180_000);

  test("PUT /Memory/<X> with a null body id creates the skill at X", async () => {
    const id = nextId("null-skill");
    const body = { id: null, agentId: A.id, content: "null-id skill", trigger: "when the url names the id", tags: ["skill"], durability: "persistent" };

    const result = await call(A, "PUT", memPath(id), body);
    expect(result.status, result.text.slice(0, 300)).toBeLessThan(300);
    expect(JSON.parse(result.text).id).toBe(id);
    const row = await memoryRow(id);
    expect(row?.skillSubjectId).toBe(id);
    const versions = await versionsOf(id);
    expect(versions.map((v) => v.kind)).toEqual(["create"]);
    expect(versions[0].memoryId).toBe(id);
  }, 180_000);

  test("POST /Memory/<X> with a skill body that has only the URL id creates at X, and an identical retry writes a successor id with supersedes X and skillSubjectId X", async () => {
    const id = nextId("post-skill");
    const body = { agentId: A.id, content: "url-only post skill", trigger: "when the url names the id on post", tags: ["skill"], durability: "persistent" };

    const first = await call(A, "POST", memPath(id), body);
    expect(first.status, first.text.slice(0, 300)).toBeLessThan(300);
    expect(JSON.parse(first.text).id).toBe(id);
    const row = await memoryRow(id);
    expect(row?.skillSubjectId).toBe(id);
    const versions = await versionsOf(id);
    expect(versions.map((v) => v.kind)).toEqual(["create"]);
    expect(versions[0].memoryId).toBe(id);

    const retry = await call(A, "POST", memPath(id), body);
    expect(retry.status, retry.text.slice(0, 300)).toBeLessThan(300);
    const successorId = JSON.parse(retry.text).id;
    expect(successorId).not.toBe(id);
    const successor = await memoryRow(successorId);
    expect(successor.supersedes).toBe(id);
    expect(successor.skillSubjectId).toBe(id);
    expect((await versionsOf(id)).map((v) => v.kind)).toEqual(["create", "update"]);
  }, 180_000);

  test("POST /Memory/<X> refuses a stale target snapshot when a concurrent write lands first", async () => {
    const id = nextId("post-stale");
    const body = { agentId: A.id, content: "url-only post stale", trigger: "when the url names the id on a racing post", tags: ["skill"], durability: "persistent" };

    const results = await Promise.all([
      call(A, "POST", memPath(id), body),
      call(A, "POST", memPath(id), body),
    ]);
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses[0]).toBeLessThan(300);
    expect(statuses[1]).toBe(409);
    const loser = results.find((r) => r.status === 409)!;
    expect(JSON.parse(loser.text).error).toBe("skill_target_changed");
  }, 180_000);
});
