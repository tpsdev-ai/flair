import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { computeContentHash } from "../../resources/memory-feed-lib.js";
import { SEED_SKILL_ROW_ID } from "../../resources/seed-ids.js";

// A small, non-default TTL so the repaired row can be reaped inside the test.
const TTL_HOURS = "0.001"; // 3.6s
const PRIOR_TTL = process.env.FLAIR_EPHEMERAL_TTL_HOURS;
process.env.FLAIR_EPHEMERAL_TTL_HOURS = TTL_HOURS;

// The test-only pause inside the repair's owned transaction
// (resources/txn-pause-point.ts), between its read and its write.
const POINT = "feed-dedup-repair";

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

function assertOwnInstance(harper: HarperInstance): void {
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
  }
}

async function authFetch(harper: HarperInstance, agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Authorization: ed25519Header(agent, method, path) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${harper.httpURL}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}

async function seedAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status).toBe(200);
}

/** The whole stored row, read back through the admin surface (Harper's own metadata dropped). */
async function readStored(harper: HarperInstance, id: string): Promise<Record<string, any> | null> {
  const read = await adminOp(harper, {
    operation: "search_by_hash", database: "flair", table: "Memory", hash_values: [id], get_attributes: ["*"],
  });
  const text = await read.text();
  expect(read.status, `search_by_hash returned ${read.status}: ${text.slice(0, 200)}`).toBe(200);
  const record = (JSON.parse(text) as any[])[0];
  if (!record) return null;
  return Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith("__")));
}

/** Insert a stored Memory row directly, with the content hash the feed dedups on. */
async function seedMemory(harper: HarperInstance, agent: TestAgent, row: Record<string, any>): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Memory",
    records: [{ contentHash: computeContentHash(agent.id, String(row.content)), createdAt: new Date().toISOString(), ...row }],
  });
  expect(res.status).toBe(200);
}

async function runMaintenance(harper: HarperInstance, agentId: string): Promise<any> {
  const res = await fetch(`${harper.httpURL}/MemoryMaintenance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify({ agentId }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * Arm the pause, start `write`, and once the repair is paused inside its
 * transaction run `compete`, then release the repair. Returns the write's
 * response, the competing step's result and how the pause ended.
 */
async function withPausedRepair<T>(write: () => Promise<Response>, compete: () => Promise<T>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${POINT}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${POINT}`), "");
  const pending = write();
  const paused = await waitFor(join(pauseDir, `paused.${POINT}`), 15_000);
  let competed: T | undefined;
  try {
    if (paused) competed = await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${POINT}`), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${POINT}`), "utf8") : "never paused";
  return { response, competed, released };
}

let harper: HarperInstance;
let pauseDir: string;
const agent = mkAgent("dedup-eph-owner");
const other = mkAgent("dedup-eph-other");

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-dedup-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper();
  } finally {
    // The spawned Harper has its copy; no later Harper in this process inherits it.
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assertOwnInstance(harper);
  await seedAgent(harper, agent);
  await seedAgent(harper, other);
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  if (PRIOR_TTL === undefined) delete process.env.FLAIR_EPHEMERAL_TTL_HOURS;
  else process.env.FLAIR_EPHEMERAL_TTL_HOURS = PRIOR_TTL;
});

describe("deduplicated ephemeral feed expiry (flair#2358)", () => {
  test("a deduplicated ephemeral row with no expiry is repaired, returned as stored, and then reaped", async () => {
    const content = `deduplicated ephemeral state ${randomUUID()}`;
    const id = `dedup-eph-${randomUUID()}`;
    await seedMemory(harper, agent, { id, agentId: agent.id, content, durability: "ephemeral" });
    expect((await readStored(harper, id))?.expiresAt ?? null).toBeNull();

    // Same agent + content: the feed's content-hash dedup returns the stored
    // row instead of writing a new one.
    const before = Date.now();
    const res = await authFetch(harper, agent, "POST", "/FeedMemories", { agentId: agent.id, content });
    expect(res.status).toBe(200);
    const body = await res.json();

    const stored = await readStored(harper, id);
    expect(stored?.durability).toBe("ephemeral");
    expect(typeof stored?.expiresAt).toBe("string");
    expect(Date.parse(stored!.expiresAt!)).toBeGreaterThanOrEqual(before + Number(TTL_HOURS) * 3600000);
    expect(Date.parse(stored!.expiresAt!)).toBeLessThanOrEqual(Date.now() + Number(TTL_HOURS) * 3600000);
    // The response body is the stored row.
    expect(body).toEqual(stored!);

    // The repaired expiry is the reap signal: once it passes, maintenance reaps.
    await new Promise((r) => setTimeout(r, 6000));
    const result = await runMaintenance(harper, agent.id);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await readStored(harper, id)).toBeNull();
  }, 30_000);

  test("a deduplicated ephemeral row that already has an expiry keeps it", async () => {
    const content = `deduplicated dated state ${randomUUID()}`;
    const id = `dedup-keep-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await seedMemory(harper, agent, { id, agentId: agent.id, content, durability: "ephemeral", expiresAt });

    const res = await authFetch(harper, agent, "POST", "/FeedMemories", { agentId: agent.id, content });
    expect(res.status).toBe(200);

    const stored = await readStored(harper, id);
    expect(stored?.durability).toBe("ephemeral");
    expect(stored?.expiresAt).toBe(expiresAt);
  }, 30_000);

  test("a deduplicated persistent row gets no expiry", async () => {
    const content = `deduplicated durable fact ${randomUUID()}`;
    const id = `dedup-persist-${randomUUID()}`;
    await seedMemory(harper, agent, { id, agentId: agent.id, content, durability: "persistent" });

    const res = await authFetch(harper, agent, "POST", "/FeedMemories", { agentId: agent.id, content });
    expect(res.status).toBe(200);

    const stored = await readStored(harper, id);
    expect(stored?.durability).toBe("persistent");
    expect(stored?.expiresAt ?? null).toBeNull();
  }, 30_000);

  test("a matched row replaced under the same id before the repair writes is refused and left as replaced", async () => {
    const content = `deduplicated replaced state ${randomUUID()}`;
    const replacementContent = `replacement under the same id ${randomUUID()}`;
    const id = `dedup-replaced-${randomUUID()}`;
    await seedMemory(harper, agent, { id, agentId: agent.id, content, durability: "ephemeral" });

    const { response, competed, released } = await withPausedRepair(
      () => authFetch(harper, agent, "POST", "/FeedMemories", { agentId: agent.id, content }),
      async () => {
        const removed = await adminOp(harper, { operation: "delete", database: "flair", table: "Memory", hash_values: [id] });
        expect(removed.status).toBe(200);
        await seedMemory(harper, other, { id, agentId: other.id, content: replacementContent, durability: "ephemeral" });
        return readStored(harper, id);
      },
    );
    expect(released, "the repair was not paused and released by this test").toBe("go");
    expect(competed?.agentId).toBe(other.id);

    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(409);
    expect(JSON.parse(text).error).toBe("feed_dedup_target_changed");
    // The replacement is unchanged: no expiry was written to it.
    expect(await readStored(harper, id)).toEqual(competed!);
  }, 60_000);

  test("a competing request that stamps the expiry first: the response carries the current stamped row", async () => {
    const content = `deduplicated contended state ${randomUUID()}`;
    const id = `dedup-contended-${randomUUID()}`;
    await seedMemory(harper, agent, { id, agentId: agent.id, content, durability: "ephemeral" });

    const { response, competed, released } = await withPausedRepair(
      () => authFetch(harper, agent, "POST", "/FeedMemories", { agentId: agent.id, content }),
      async () => {
        const res = await authFetch(harper, agent, "POST", "/FeedMemories", { agentId: agent.id, content });
        return { status: res.status, body: await res.json() };
      },
    );
    expect(released, "the repair was not paused and released by this test").toBe("go");
    expect(competed?.status).toBe(200);

    const stored = await readStored(harper, id);
    expect(typeof stored?.expiresAt).toBe("string");
    expect(competed?.body.expiresAt).toBe(stored!.expiresAt);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(stored!);
  }, 60_000);

  test("a matched row whose id the feed does not write is refused and left unchanged", async () => {
    const seedContent = `deduplicated reserved state ${randomUUID()}`;
    await adminOp(harper, { operation: "delete", database: "flair", table: "Memory", hash_values: [SEED_SKILL_ROW_ID] });
    await seedMemory(harper, agent, { id: SEED_SKILL_ROW_ID, agentId: agent.id, content: seedContent, durability: "ephemeral" });
    const seedRes = await authFetch(harper, agent, "POST", "/FeedMemories", { agentId: agent.id, content: seedContent });
    const seedText = await seedRes.text();
    expect(seedRes.status, seedText.slice(0, 300)).toBe(403);
    expect(seedText).toContain("seed_id_reserved");
    expect((await readStored(harper, SEED_SKILL_ROW_ID))?.expiresAt ?? null).toBeNull();

    const suffixContent = `deduplicated suffixed state ${randomUUID()}`;
    const suffixId = `dedup-suffix-${randomUUID()}.content`;
    await seedMemory(harper, agent, { id: suffixId, agentId: agent.id, content: suffixContent, durability: "ephemeral" });
    const suffixRes = await authFetch(harper, agent, "POST", "/FeedMemories", { agentId: agent.id, content: suffixContent });
    const suffixText = await suffixRes.text();
    expect(suffixRes.status, suffixText.slice(0, 300)).toBe(400);
    expect(JSON.parse(suffixText).error).toBe("memory_id_content_suffix");
    expect((await readStored(harper, suffixId))?.expiresAt ?? null).toBeNull();
  }, 30_000);
});
