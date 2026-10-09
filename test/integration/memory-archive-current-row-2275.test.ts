/**
 * memory-archive-current-row-2275.test.ts — flair#2275, real Harper.
 *
 * POST /MemoryArchive reads the row, then re-reads it inside a transaction it
 * owns and writes from that re-read. These cases commit a competing change
 * between the two reads (the `memory-archive-pre` pause in
 * resources/txn-pause-point.ts, enabled by FLAIR_ENABLE_TEST_FAULT_INJECTION
 * and FLAIR_TEST_PAUSE_DIR, set for this file's Harper only) and check the
 * response and the stored row: a changed row the caller can still read is
 * refused with 409, a row the caller can no longer read returns 404, and the
 * competing change is kept. The control case (no change during the pause) is
 * still basemented.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";

const PAST = "2000-01-01T00:00:00.000Z";
const POINT = "memory-archive-pre";

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

let harper: HarperInstance;
let pauseDir: string;
let embeddingModel: string;
const owner = mkAgent(`agent-a-${randomUUID()}`);
const other = mkAgent(`agent-b-${randomUUID()}`);

async function adminOp(op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${harper.admin.username}:${harper.admin.password}`)}` },
    body: JSON.stringify(op),
  });
}
async function registerAgent(agent: TestAgent): Promise<void> {
  const res = await adminOp({
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `Agent insert for ${agent.id} returned ${res.status}`).toBe(200);
}
async function insertMemory(record: Record<string, any>): Promise<void> {
  const res = await adminOp({ operation: "insert", database: "flair", table: "Memory", records: [record] });
  expect(res.status, `Memory insert returned ${res.status}`).toBe(200);
}
async function updateMemory(record: Record<string, any>): Promise<void> {
  const res = await adminOp({ operation: "update", database: "flair", table: "Memory", records: [record] });
  expect(res.status, `Memory update returned ${res.status}`).toBe(200);
}
async function readMemory(id: string): Promise<any> {
  const res = await adminOp({ operation: "search_by_hash", database: "flair", table: "Memory", hash_values: [id], get_attributes: ["*"] });
  expect(res.status, `search_by_hash returned ${res.status}`).toBe(200);
  return (JSON.parse(await res.text()) as any[])[0] ?? null;
}
async function archive(agent: TestAgent, id: string, action: "basement" | "restore"): Promise<{ status: number; body: any }> {
  const path = "/MemoryArchive";
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify({ id, action }),
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* keep the text */ }
  return { status: res.status, body };
}
/**
 * The embedding model id this instance stamps, read back from a probe row
 * written through POST /Memory. Fixture rows carry it, so the embedding-stamp
 * migration (resources/migrations/embedding-stamp.ts) does not select them: its
 * boot pass and follow-up rechecks re-embed a row that has no current stamp,
 * and a re-embed that lands between the archive's two reads changes the row.
 */
async function currentEmbeddingModel(agent: TestAgent): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const id = `ma-probe-${randomUUID()}`;
    const path = "/Memory";
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "POST",
      headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({ id, agentId: agent.id, content: `${id} probe body`, durability: "persistent" }),
    });
    expect(res.status, `probe POST /Memory returned ${res.status}`).toBe(201);
    const model = (await readMemory(id))?.embeddingModel;
    if (typeof model === "string" && model.length > 0) return model;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("no probe row was stamped with an embedding model after 30 attempts; fixture rows would be selected by the embedding-stamp migration");
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
 * Arm the pause, start `run` (the archive request), and once it is paused
 * between its two reads run `compete` (the competing write), then release it.
 * Returns the request's result and how the pause ended.
 */
async function withPausedArchive(run: () => Promise<{ status: number; body: any }>, compete: () => Promise<void>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${POINT}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${POINT}`), "");
  const pending = run();
  const paused = await waitFor(join(pauseDir, `paused.${POINT}`), 15_000);
  try {
    if (paused) await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${POINT}`), "");
  }
  const result = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${POINT}`), "utf8") : "never paused";
  return { result, released };
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-ma-2275-pause-"));
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
  await registerAgent(owner);
  await registerAgent(other);
  embeddingModel = await currentEmbeddingModel(owner);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

function row(id: string, overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id, agentId: owner.id, content: `${id} body`, contentHash: id, visibility: "shared",
    durability: "persistent", createdAt: PAST, archived: false, instanceToken: randomUUID(), embeddingModel,
    ...overrides,
  };
}

describe("flair#2275 — MemoryArchive refuses a row changed between its two reads (real Harper)", () => {
  it("control: an unchanged row is basemented through the pause", async () => {
    const id = `ma-ctrl-${randomUUID()}`;
    await insertMemory(row(id));
    const { result, released } = await withPausedArchive(() => archive(owner, id, "basement"), async () => {});
    expect(released, "the archive request was not paused and released by this test").toBe("go");
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect((await readMemory(id))?.archived).toBe(true); // assertion: the unchanged row is basemented
  }, 60_000);

  it("basement: a content edit committed between the two reads is refused with 409 and kept", async () => {
    const id = `ma-basement-edit-${randomUUID()}`;
    const EDITED = "basement target body AFTER the competing edit";
    await insertMemory(row(id));
    const { result, released } = await withPausedArchive(
      () => archive(owner, id, "basement"),
      () => updateMemory({ id, content: EDITED }),
    );
    expect(released, "the archive request was not paused and released by this test").toBe("go");
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(result.body?.error).toBe("memory_changed");
    const stored = await readMemory(id);
    expect(stored?.archived ?? false, "the row was basemented").toBe(false); // assertion: not basemented
    expect(stored?.content).toBe(EDITED); // assertion: the competing edit is kept
  }, 60_000);

  it("restore: a content edit committed between the two reads is refused with 409 and kept", async () => {
    const id = `ma-restore-edit-${randomUUID()}`;
    const EDITED = "restore target body AFTER the competing edit";
    await insertMemory(row(id, { archived: true, archivedAt: PAST, archivedBy: owner.id }));
    const { result, released } = await withPausedArchive(
      () => archive(owner, id, "restore"),
      () => updateMemory({ id, content: EDITED }),
    );
    expect(released, "the archive request was not paused and released by this test").toBe("go");
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(result.body?.error).toBe("memory_changed");
    const stored = await readMemory(id);
    expect(stored?.archived, "the row was restored").toBe(true); // assertion: not restored
    expect(stored?.archivedBy).toBe(owner.id); // assertion: the archive stamp stands
    expect(stored?.content).toBe(EDITED); // assertion: the competing edit is kept
  }, 60_000);

  it("basement: a row that became another agent's private row between the two reads returns 404 and is kept", async () => {
    const id = `ma-basement-owner-${randomUUID()}`;
    await insertMemory(row(id));
    const { result, released } = await withPausedArchive(
      () => archive(owner, id, "basement"),
      () => updateMemory({ id, agentId: other.id, visibility: "private" }),
    );
    expect(released, "the archive request was not paused and released by this test").toBe("go");
    expect(result.status, JSON.stringify(result.body)).toBe(404);
    const stored = await readMemory(id);
    expect(stored?.archived ?? false, "the row was basemented").toBe(false); // assertion: not basemented
    expect(stored?.agentId).toBe(other.id); // assertion: the owner change is kept
    expect(stored?.visibility).toBe("private"); // assertion: the visibility change is kept
  }, 60_000);

  it("restore: a row whose owner changed between the two reads is refused with 409 and kept", async () => {
    const id = `ma-restore-owner-${randomUUID()}`;
    await insertMemory(row(id, { archived: true, archivedAt: PAST, archivedBy: owner.id }));
    const { result, released } = await withPausedArchive(
      () => archive(owner, id, "restore"),
      () => updateMemory({ id, agentId: other.id }),
    );
    expect(released, "the archive request was not paused and released by this test").toBe("go");
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(result.body?.error).toBe("memory_changed");
    const stored = await readMemory(id);
    expect(stored?.archived, "the row was restored").toBe(true); // assertion: not restored
    expect(stored?.agentId).toBe(other.id); // assertion: the owner change is kept
  }, 60_000);
});
