/**
 * memory-writer-commit-confirm-2645b.test.ts — real-Harper interleavings for
 * the Memory, Soul and InstructionVersion writers that step one did not
 * exercise (flair#2645).
 *
 * Harper can resolve a transaction's commit while dropping a write that lost
 * to a newer full write of the same row, and still commit the rest of that
 * transaction. Each case holds a writer at an existing test-only pause point
 * (resources/txn-pause-point.ts), commits a newer full record to the same row
 * through the lock-bypassing operations API, releases the writer, and reads the
 * committed state back. The newer record is a copy of the stored row with a
 * changed field, so identity fields do not move.
 *
 * Real Harper, ephemeral instance; every URL is asserted to be this test's own
 * instance before the first call.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import nacl from "tweetnacl";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { ensureFlairAgentRole, ensureFlairAgentUser } from "../../src/cli";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const A = mkAgent(`mwc2-agent-${sfx}`);
const now = () => new Date().toISOString();
const PAST = "2000-01-01T00:00:00.000Z";

let harper: HarperInstance;
let pauseDir = "";
let stubDir = "";
let seq = 0;
const nextId = (label: string) => `mwc2-${label}-${sfx}-${++seq}`;

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
  expect(h.process?.pid).toBeGreaterThan(0);
}

const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

function ed25519(who: TestAgent, method: string, path: string): string {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${who.id}:${ts}:${nonce}:${method}:${path}`), who.secretKey);
  return `TPS-Ed25519 ${who.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function call(auth: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(harper.httpURL + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: ed25519(auth, method, path) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

async function basicCall(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(harper.httpURL + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function memoryRow(id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_hash", database: "flair", table: "Memory", hash_values: [id], get_attributes: ["*"] });
  return (rows as any[])[0] ?? null;
}

async function soulRow(id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table: "Soul", ids: [id], get_attributes: ["*"] });
  return (rows as any[])[0] ?? null;
}

const memPath = (id: string) => `/Memory/${encodeURIComponent(id)}`;
const soulPath = (id: string) => `/Soul/${encodeURIComponent(id)}`;

async function seedMemory(id: string, content: string, extra: Record<string, unknown> = {}): Promise<void> {
  await ops({
    operation: "insert", database: "flair", table: "Memory",
    records: [{
      id, agentId: A.id, content, contentHash: id, visibility: "shared", archived: false,
      durability: "persistent", instanceToken: randomUUID(),
      createdAt: "2026-01-01T00:00:00.000Z", embedding: [0.1, 0.1, 0.1], embeddingModel: getModelId(),
      ...extra,
    }],
  });
}

/** Commit a NEWER full record to the row through the ops API (no write lock):
 *  a copy of the stored row with new content, so identity fields do not move. */
async function commitNewerFullWrite(id: string, content: string): Promise<void> {
  const current = await memoryRow(id);
  expect(current, "the row is missing before the competing write").not.toBeNull();
  await ops({
    operation: "put", database: "flair", table: "Memory",
    records: [{ ...current, content, updatedAt: now() }],
  });
  expect((await memoryRow(id))?.content, "the competing write is not visible while the writer is paused").toBe(content);
}

async function commitNewerFullWriteFields(id: string, patch: Record<string, unknown>): Promise<void> {
  const current = await memoryRow(id);
  expect(current, "the row is missing before the competing write").not.toBeNull();
  await ops({
    operation: "put", database: "flair", table: "Memory",
    records: [{ ...current, ...patch, updatedAt: now() }],
  });
}

async function commitNewerSoulWrite(id: string, patch: Record<string, unknown>): Promise<void> {
  const current = await soulRow(id);
  expect(current, "the Soul row is missing before the competing write").not.toBeNull();
  await ops({
    operation: "put", database: "flair", table: "Soul",
    records: [{ ...current, ...patch, updatedAt: now() }],
  });
}

async function insertPointer(memoryId: string): Promise<void> {
  await ops({
    operation: "insert", database: "flair", table: "MemoryHostSource",
    records: [{
      memoryId,
      hostSource: JSON.stringify({ v: 1, host: "host-a", kind: "run", id: "run-aaaaaaaa" }),
      scopeAtWrite: null, authorId: "host-a", memoryInstanceToken: randomUUID(), receivedAt: now(),
    }],
  });
}

async function pointerRow(memoryId: string): Promise<any | null> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "MemoryHostSource",
    search_attribute: "memoryId", search_type: "equals", search_value: memoryId, get_attributes: ["*"],
  });
  return (rows as any[])[0] ?? null;
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** Arm `point`, start `trigger`, run `compete` once it is paused, release, await it. */
async function withPaused(point: string, trigger: () => Promise<Response>, compete: () => Promise<void>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
  const pending = trigger();
  const paused = await waitFor(join(pauseDir, `paused.${point}`), 20_000);
  try {
    if (paused) await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${point}`), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused";
  return { response, released, paused };
}

/** As above, but the writer does not await the pause: read its release marker. */
async function withPausedBackground(point: string, trigger: () => Promise<Response>, compete: () => Promise<void>) {
  const result = await withPaused(point, trigger, compete);
  let released = result.released;
  for (const until = Date.now() + 5_000; !released && Date.now() < until;) {
    await new Promise((r) => setTimeout(r, 25));
    try { released = readFileSync(join(pauseDir, `released.${point}`), "utf8"); } catch { released = ""; }
  }
  return { ...result, released };
}

async function readUntil(id: string, done: (row: any) => boolean, ms: number): Promise<any> {
  const deadline = Date.now() + ms;
  let row = await memoryRow(id);
  while (!done(row) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    row = await memoryRow(id);
  }
  return row;
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2645b-pause-"));
  stubDir = mkdtempSync(join(tmpdir(), "flair-2645b-stub-"));
  writeFileSync(join(stubDir, "generate-response.json"), JSON.stringify({ candidates: [] }));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper({
      appendRootConfigYaml: [
        "models:",
        "  generative:",
        "    default:",
        `      backend: ${resolve(process.cwd(), "test/fixtures/stub-generative-backend.mjs")}`,
        `      responseFile: ${join(stubDir, "generate-response.json")}`,
      ].join("\n"),
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  if (stubDir) rmSync(stubDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

async function maintain(agentId: string): Promise<any> {
  const res = await basicCall("POST", "/MemoryMaintenance", { agentId });
  const text = await res.text();
  expect(res.status, `maintenance returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

describe("flair#2645 — MemoryMaintenance sweeps under a newer full write", () => {
  it("expiry: a newer full write committed while the delete is paused is kept and the delete is skipped", async () => {
    const id = nextId("expiry");
    await seedMemory(id, "expiry v1", { durability: "ephemeral", expiresAt: PAST });
    const NEWER = "expiry v2-committed-by-the-competitor";
    const { response, paused, released } = await withPaused(
      "maintenance-expiry",
      () => basicCall("POST", "/MemoryMaintenance", { agentId: A.id }),
      () => commitNewerFullWrite(id, NEWER),
    );
    expect(paused, "the expiry delete was not paused between its read and its act").toBe(true);
    expect(released).toBe("go");
    const body = await response.json() as any;
    expect(body.expired, JSON.stringify(body)).toBe(0);
    expect(body.skipped, JSON.stringify(body)).toBeGreaterThanOrEqual(1);
    const row = await memoryRow(id);
    expect(row?.content, "the newer committed write was overwritten or the row was deleted").toBe(NEWER);
  }, 120_000);

  it("archive: a newer full write committed while the archive is paused is kept and the archive is skipped", async () => {
    const id = nextId("archive");
    await seedMemory(id, "archive v1", { durability: "standard", type: "session", createdAt: PAST, expiresAt: undefined });
    const NEWER = "archive v2-committed-by-the-competitor";
    const { response, paused, released } = await withPaused(
      "maintenance-archive",
      () => basicCall("POST", "/MemoryMaintenance", { agentId: A.id }),
      () => commitNewerFullWrite(id, NEWER),
    );
    expect(paused, "the archive was not paused between its read and its act").toBe(true);
    expect(released).toBe("go");
    const body = await response.json() as any;
    expect(body.archived, JSON.stringify(body)).toBe(0);
    expect(body.skipped, JSON.stringify(body)).toBeGreaterThanOrEqual(1);
    const row = await memoryRow(id);
    expect(row?.content, "the newer committed write was overwritten by the archive").toBe(NEWER);
    expect(row?.archived, "the archive landed on the newer row").not.toBe(true);
  }, 120_000);

  it("orphan sweep: a newer full write to the archived Memory row while the pointer delete is paused keeps the pointer", async () => {
    const id = nextId("orphan");
    await seedMemory(id, "orphan v1", { archived: true });
    await insertPointer(id);
    const NEWER = "orphan v2-committed-by-the-competitor";
    const { response, paused, released } = await withPaused(
      "maintenance-orphan",
      () => basicCall("POST", "/MemoryMaintenance", { agentId: A.id }),
      () => commitNewerFullWrite(id, NEWER),
    );
    expect(paused, "the orphan sweep was not paused between its read and its act").toBe(true);
    expect(released).toBe("go");
    const body = await response.json() as any;
    expect(body.orphans, JSON.stringify(body)).toBe(0);
    expect(body.skipped, JSON.stringify(body)).toBeGreaterThanOrEqual(1);
    expect((await memoryRow(id))?.content, "the newer committed write was overwritten").toBe(NEWER);
    expect(await pointerRow(id), "the pointer row of the changed Memory row was deleted").not.toBeNull();
  }, 120_000);
});

describe("flair#2645 — MemoryArchive under a newer full write", () => {
  it("basement: a newer full write committed before the archive's transactional re-read refuses by name", async () => {
    const id = nextId("basement");
    await seedMemory(id, "basement v1");
    const NEWER = "basement v2-committed-by-the-competitor";
    const { response, paused, released } = await withPaused(
      "memory-archive-pre",
      () => call(A, "POST", "/MemoryArchive", { id, action: "basement" }),
      () => commitNewerFullWrite(id, NEWER),
    );
    expect(paused, "the archive was not paused between its two reads").toBe(true);
    expect(released).toBe("go");
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(409);
    expect(JSON.parse(text).error).toBe("memory_changed");
    const row = await memoryRow(id);
    expect(row?.content, "the newer committed write was overwritten by the archive").toBe(NEWER);
    expect(row?.archived, "the archive landed on the newer row").not.toBe(true);
  }, 120_000);
});

describe("flair#2645 — MemoryReflect source stamp under a newer full write", () => {
  it("the lastReflected stamp lands on the newer committed row and keeps its content", async () => {
    const id = nextId("reflect");
    await seedMemory(id, "reflect v1", { durability: "standard", type: "session", createdAt: now() });
    const NEWER = `reflect v2-committed-by-the-competitor-${id}`;
    const { response, paused, released } = await withPausedBackground(
      "reflect-sources",
      () => call(A, "POST", "/ReflectMemories", { agentId: A.id, execute: true }),
      () => commitNewerFullWriteFields(id, { subject: NEWER }),
    );
    expect(paused, "the source stamp was not paused between its read and its write").toBe(true);
    expect(released).toBe("go");
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(200);
    const row = await readUntil(id, (r) => Boolean(r?.lastReflected), 10_000);
    expect(row?.subject, "the newer committed write was overwritten by the stamp").toBe(NEWER);
    expect(row?.lastReflected, "the stamp did not land on the newer row").toBeTruthy();
  }, 120_000);
});

describe("flair#2645 — Soul PATCH under a newer full write", () => {
  it("a newer full write committed after the PATCH's read is kept and the PATCH retries from it", async () => {
    const key = nextId("soul-key");
    const id = `${A.id}:${key}`;
    const created = await basicCall("POST", "/Soul/", { id, agentId: A.id, key, value: "soul v1", durability: "permanent" });
    expect(created.status, (await created.clone().text()).slice(0, 300)).toBeLessThan(300);
    const { response, paused, released } = await withPaused(
      "soul-patch",
      () => basicCall("PATCH", soulPath(id), { value: "soul v2-this-writer" }),
      () => commitNewerSoulWrite(id, { durability: "persistent" }),
    );
    expect(paused, "the Soul PATCH was not paused between its read and its write").toBe(true);
    expect(released).toBe("go");
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBeLessThan(300);
    const row = await soulRow(id);
    expect(row?.value, "the PATCH's declared value did not land on the retried row").toBe("soul v2-this-writer");
    expect(row?.durability, "the newer committed field was reverted by the PATCH").toBe("persistent");
  }, 120_000);
});
