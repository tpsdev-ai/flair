/**
 * memory-write-lock-2478.test.ts — the per-id memory write lock serializes the
 * ordinary owner PUT/PATCH (flair#2478 slice 1, part 1), real Harper.
 *
 * The converted verbs acquire the lock BEFORE their first stored read, and
 * their row write owns its transaction, so the read, the decision and the
 * COMMIT all happen before the lock releases. Two writers on one id therefore
 * cannot interleave:
 *
 *   - a second writer that cannot take the lock within its 200 x 10 ms budget
 *     answers 503 memory_busy (the caller id only), and does not write;
 *   - a second writer that takes the lock after the first released it reads the
 *     first's COMMITTED row and commits its own write — no lost write and no
 *     spurious 409.
 *
 * DETERMINISTIC ORDERING via the `memory-put-committed` / `memory-patch-committed`
 * pause points (resources/txn-pause-point.ts, enabled by
 * FLAIR_ENABLE_TEST_FAULT_INJECTION / FLAIR_TEST_PAUSE_DIR): each holds a writer
 * AFTER its owned transaction committed and while the write lock is still held.
 *
 * Throwaway HOME + data dir, ephemeral ports.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

interface TestAgent { id: string; publicKey: Uint8Array; secretKey: Uint8Array; }
const newAgent = (id: string): TestAgent => ({ id, ...nacl.sign.keyPair() });
const owner = newAgent("wlk-owner");

let harper: HarperInstance;
let pauseDir: string;
let home: string;
let authHeader: string;

async function opsCall(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`ops call failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}
async function readRow(id: string): Promise<any> {
  const rows = await opsCall({
    operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"],
  });
  return Array.isArray(rows) ? rows[0] ?? null : rows;
}
function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}
/** A signed owner PUT over the real HTTP route. */
function editAs(agent: TestAgent, id: string, content: string): Promise<Response> {
  const path = `/Memory/${encodeURIComponent(id)}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(agent, "PUT", path) },
    body: JSON.stringify({ agentId: agent.id, content }),
    signal: AbortSignal.timeout(60_000),
  });
}
/** A signed owner PATCH over the real HTTP route. */
function patchAs(agent: TestAgent, id: string, content: string): Promise<Response> {
  const path = `/Memory/${encodeURIComponent(id)}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(agent, "PATCH", path) },
    body: JSON.stringify({ agentId: agent.id, content }),
    signal: AbortSignal.timeout(60_000),
  });
}
function patchBodyAs(agent: TestAgent, id: string, body: Record<string, unknown>): Promise<Response> {
  const path = `/Memory/${encodeURIComponent(id)}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(agent, "PATCH", path) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}
/** An UNSIGNED (anonymous) PUT over the real HTTP route. */
function anonymousPut(id: string, body: Record<string, unknown>): Promise<Response> {
  const path = `/Memory/${encodeURIComponent(id)}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}
async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
async function assertReleased(point: string): Promise<void> {
  const path = join(pauseDir, `released.${point}`);
  const deadline = Date.now() + 30_000;
  let released = "";
  while (Date.now() < deadline) {
    if (existsSync(path)) released = readFileSync(path, "utf8");
    if (released) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(released, "the pause ended by timeout, not by this test").toBe("go");
}
function clearMarkers(point: string): void {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
}
function arm(point: string): void {
  clearMarkers(point);
  writeFileSync(join(pauseDir, `arm.${point}`), "");
}
function release(point: string): void {
  writeFileSync(join(pauseDir, `go.${point}`), "");
}
async function seedMemory(id: string, content: string): Promise<void> {
  await opsCall({
    operation: "insert", database: "flair", table: "Memory",
    records: [{
      id, agentId: owner.id, content, durability: "standard", visibility: "shared",
      embedding: [0.1, 0.2, 0.3], instanceToken: randomUUID(),
      usageCount: 0, createdAt: new Date().toISOString(),
    }],
  });
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2478-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2478-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper({ homeDir: home });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  authHeader = "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  for (const url of [http, ops]) {
    if (url.hostname !== "127.0.0.1" || !(Number(url.port) > 0) || url.port === "9925" || url.port === "9926") {
      throw new Error(`refusing to run against ${url.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
  }
  await opsCall({
    operation: "upsert", database: "flair", table: "Agent",
    records: [{
      id: owner.id, name: owner.id, role: "agent",
      publicKey: Buffer.from(owner.publicKey).toString("base64"), createdAt: new Date().toISOString(),
    }],
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper).catch(() => {});
  if (home) rmSync(home, { recursive: true, force: true });
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

const POINT = "memory-put-committed";

describe("flair#2478 — the per-id memory write lock serializes the owner PUT (real Harper)", () => {
  it("a PATCH on the same id cannot take the lock while a PUT holds it past the budget: 503 memory_busy, caller id only, and no write", async () => {
    const id = `wlk-busy-${Date.now()}`;
    await seedMemory(id, "the original text");
    arm(POINT);
    const held = editAs(owner, id, "the held PUT");
    expect(await waitFor(join(pauseDir, `paused.${POINT}`), 30_000), "the first PUT never reached its post-commit pause").toBe(true);

    // The lock is held: a second writer to the SAME id waits its whole budget and is refused.
    const refused = await patchAs(owner, id, "the refused PATCH");
    const body = await refused.json() as any;
    expect(refused.status, JSON.stringify(body)).toBe(503);
    expect(body.error).toBe("memory_busy");
    expect(body.caller).toBe(owner.id);

    release(POINT);
    const heldRes = await held;
    await assertReleased(POINT);
    expect(heldRes.status, `the held PUT was not 2xx: ${await heldRes.clone().text()}`).toBeLessThan(300);
    expect((await readRow(id))?.content, "the refused PATCH wrote after all").toBe("the held PUT");
  }, 120_000);

  it("a second PUT waits out a short hold and commits on top of the first's committed row: no lost write, no spurious 409", async () => {
    const id = `wlk-serial-${Date.now()}`;
    await seedMemory(id, "the original text");
    arm(POINT);
    const first = editAs(owner, id, "the first PUT");
    expect(await waitFor(join(pauseDir, `paused.${POINT}`), 30_000), "the first PUT never reached its post-commit pause").toBe(true);

    // Start the second PUT while the first holds the lock, then release well
    // inside the second's budget: it takes the lock and commits its own write.
    const second = editAs(owner, id, "the second PUT");
    await new Promise((r) => setTimeout(r, 250));
    release(POINT);
    const [a, b] = await Promise.all([first, second]);
    await assertReleased(POINT);
    expect(a.status, `the first PUT was not 2xx: ${await a.clone().text()}`).toBeLessThan(300);
    expect(b.status, `the second PUT was not 2xx: ${await b.clone().text()}`).toBeLessThan(300);
    expect((await readRow(id))?.content, "the second PUT did not land on the first's committed row").toBe("the second PUT");
  }, 120_000);
});

describe("flair#2478 — the lock guards a PATCH too", () => {
  it("a PUT on the same id cannot take the lock while a PATCH holds it past the budget: 503 memory_busy", async () => {
    const id = `wlk-patch-busy-${Date.now()}`;
    await seedMemory(id, "the original text");
    const patchPoint = "memory-patch-committed";
    clearMarkers(patchPoint);
    writeFileSync(join(pauseDir, `arm.${patchPoint}`), "");
    const held = patchAs(owner, id, "the held PATCH");
    expect(await waitFor(join(pauseDir, `paused.${patchPoint}`), 30_000), "the PATCH never reached its post-commit pause").toBe(true);

    const refused = await editAs(owner, id, "the refused PUT");
    const body = await refused.json() as any;
    expect(refused.status, JSON.stringify(body)).toBe(503);
    expect(body.error).toBe("memory_busy");

    release(patchPoint);
    const heldRes = await held;
    await assertReleased(patchPoint);
    expect(heldRes.status, `the held PATCH was not 2xx: ${await heldRes.clone().text()}`).toBeLessThan(300);
    expect((await readRow(id))?.content, "the refused PUT wrote after all").toBe("the held PATCH");
  }, 120_000);
});

// flair#2478: the authorization and visibility refusals must decide BEFORE (or
// regardless of) the lock and the owned write — a refusal that moved after the
// lock would let an anonymous reindex or a visibility-widening flip reach the
// row. Both cases run through the REAL per-id lock path (Memory.primaryStore).
describe("flair#2478 — a refusal decides before the lock, and the write does not land", () => {
  it("an anonymous PUT carrying _reindex is refused 401, and the row is unchanged", async () => {
    const id = `wlk-anon-reindex-${Date.now()}`;
    await seedMemory(id, "the original text");
    const before = await readRow(id);
    expect(before?.content).toBe("the original text");

    const res = await anonymousPut(id, { agentId: owner.id, content: "the original text", _reindex: true });
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(401);
    expect(body.error).toBe("authentication required");

    const after = await readRow(id);
    expect(after?.content, "the anonymous reindex re-PUT the row").toBe("the original text");
    expect(after?.instanceToken, "the anonymous reindex rotated the row's instance token").toBe(before.instanceToken);
  }, 120_000);

  it("a PATCH moving a shared record to ephemeral is refused by name through the lock, row unchanged", async () => {
    const id = `wlk-vis-${Date.now()}`;
    await seedMemory(id, "the shared text");
    const before = await readRow(id);
    expect(before?.visibility).toBe("shared");
    expect(before?.durability).toBe("standard");

    const res = await patchBodyAs(owner, id, { agentId: owner.id, durability: "ephemeral" });
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error).toBe("invalid_visibility_for_durability");

    const after = await readRow(id);
    expect(after?.durability, "the refused PATCH wrote after all").toBe("standard");
    expect(after?.visibility).toBe("shared");
    expect(after?.instanceToken).toBe(before.instanceToken);
  }, 120_000);
});
