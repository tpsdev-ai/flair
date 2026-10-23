/**
 * maintenance-usage-lock-2478.test.ts — flair#2478 slice 3b part 1, real Harper.
 *
 * The maintenance archive/expiry writer (resources/MemoryMaintenance.ts) and the
 * usage-count writer (resources/usage-recording.ts, POST /RecordUsage and
 * citation-on-write) take the per-memory-id write lock (resources/memory-write-lock.ts)
 * for the id they write. The real-Harper write trace (test/helpers/embedding-writer-race.ts)
 * asserts the archive writer's committed update names only `archived` and
 * `archivedAt`, and the usage writer's only `usageCount` and its commit marker
 * `writeBackWriteId`; the expiry writer writes no fields (it deletes the row). Each decides on the committed row it reads under the
 * lock, stages its write (the archive and usage writers an update of only the
 * fields they own, the expiry writer a delete), commits before releasing,
 * and confirms its result on the committed row. A writer that cannot take the
 * lock skips the row and reports it.
 *
 * DETERMINISTIC ORDERING via the opt-in pause points
 * (FLAIR_ENABLE_TEST_FAULT_INJECTION + FLAIR_TEST_PAUSE_DIR):
 *   - maintenance-archive-staged / maintenance-expiry-staged: the writer's write
 *     is staged and the id's lock is held;
 *   - maintenance-archive-commit / maintenance-expiry-commit: the last
 *     confirmation passed and the transaction has not committed;
 *   - maintenance-archive-committed / maintenance-expiry-committed: the
 *     transaction committed and the lock is still held;
 *   - maintenance-archive-pre / maintenance-expiry-pre: before the lock and the
 *     transaction (the competing write lands first);
 *   - usage-count-staged / usage-count-commit: the count bump is staged / past
 *     its last confirmation;
 *   - memory-put-committed: an owner PUT after its commit while it holds the id.
 *
 * An owner PUT/PATCH to an id a writer holds is refused `503 memory_busy` (the
 * code and the caller id only) when the hold outlasts the owner's wait budget.
 * The archive and usage cases that see that refusal then send a separate owner
 * request after the release and assert its values are stored. A raw ops write
 * takes no lock; a writer's post-commit verification read catches one that
 * changes the writer's result only if it commits before that read.
 *
 * Throwaway HOME + data dir, ephemeral ports.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import type { ProbeComponent } from "../helpers/component-with-replay-probe";
import { RaceHarness, composeTracedComponent } from "../helpers/embedding-writer-race";

interface TestAgent { id: string; publicKey: Uint8Array; secretKey: Uint8Array; }
const newAgent = (id: string): TestAgent => ({ id, ...nacl.sign.keyPair() });
const owner = newAgent("mul-owner");
/** A second registered agent: the competing usage contribution's caller. */
const reader = newAgent("mul-reader");

let harper: HarperInstance;
let pauseDir: string;
let home: string;
let authHeader: string;
let component: ProbeComponent;
let h: RaceHarness;

/** The writers' own incremental field sets, as the real-Harper write trace
 *  records them. `writeBackWriteId` is the shared write-back helper's commit
 *  marker for a non-idempotent plan (resources/write-back.ts), written beside
 *  `usageCount`. */
const ARCHIVE_WRITER = "maintenance-archive";
const USAGE_WRITER = "usage-count";
const ARCHIVE_FIELDS = ["archived", "archivedAt"];
const USAGE_FIELDS = ["usageCount", "writeBackWriteId"];

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
  const rows = await opsCall({ operation: "search_by_id", database: "flair", table: "Memory", ids: [id], get_attributes: ["*"] });
  return Array.isArray(rows) ? rows[0] ?? null : rows;
}
async function readLedger(agentId: string, memoryId: string): Promise<any> {
  const rows = await opsCall({
    operation: "search_by_id", database: "flair", table: "MemoryUsage", ids: [`${agentId}:${memoryId}`], get_attributes: ["*"],
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
function ownerWrite(agent: TestAgent, method: "PUT" | "PATCH", id: string, body: Record<string, unknown>): Promise<Response> {
  const path = `/Memory/${encodeURIComponent(id)}`;
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(agent, method, path) },
    body: JSON.stringify({ agentId: agent.id, ...body }),
    signal: AbortSignal.timeout(60_000),
  });
}
/** A signed POST /RecordUsage for one id. */
async function recordUsage(agent: TestAgent, memoryId: string): Promise<Response> {
  const path = "/RecordUsage";
  return fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(agent, "POST", path) },
    body: JSON.stringify({ memoryIds: [memoryId] }),
    signal: AbortSignal.timeout(60_000),
  });
}
async function maintain(agentId: string): Promise<any> {
  const res = await fetch(`${harper.httpURL}/MemoryMaintenance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({ agentId }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  expect(res.status, `maintenance returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
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
  expect(released, `${point}: the pause ended by timeout, not by this test`).toBe("go");
}
function arm(point: string): void {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
}
function release(point: string): void {
  writeFileSync(join(pauseDir, `go.${point}`), "");
}
async function pauseAt(point: string): Promise<void> {
  expect(await waitFor(join(pauseDir, `paused.${point}`), 30_000), `nothing paused at ${point}`).toBe(true);
}
function serverLog(): string {
  let text = harper.getLog?.() ?? "";
  const dir = join(harper.installDir, "log");
  if (existsSync(dir)) for (const name of readdirSync(dir)) text += readFileSync(join(dir, name), "utf8");
  return text;
}
async function waitForLog(line: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverLog().includes(line)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return serverLog().includes(line);
}
/** The exact `memory_busy` body: the code and the caller id, nothing else. */
async function expectBusy(res: Response): Promise<void> {
  const body = await res.json() as any;
  expect(res.status, JSON.stringify(body)).toBe(503);
  expect(body).toEqual({ error: "memory_busy", caller: owner.id });
}
async function seed(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  await opsCall({
    operation: "insert", database: "flair", table: "Memory",
    records: [{
      id, agentId: owner.id, content: `content of ${id}`, durability: "standard", visibility: "shared",
      embedding: [0.1, 0.2, 0.3], instanceToken: randomUUID(), usageCount: 0,
      createdAt: new Date().toISOString(), archived: false, ...extra,
    }],
  });
}
const PAST = "2000-01-01T00:00:00.000Z";

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2478-3b1-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2478-3b1-pause-"));
  component = composeTracedComponent();
  harper = await startHarper({
    cwd: component.dir, harperBinDir: component.sourceRoot,
    serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir }, homeDir: home,
  });
  h = new RaceHarness(pauseDir);
  h.harper = harper;
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
    records: [owner, reader].map((agent) => ({ id: agent.id, name: agent.id, role: "agent", publicKey: Buffer.from(agent.publicKey).toString("base64"), createdAt: new Date().toISOString() })),
  });
}, 240_000);

afterAll(async () => {
  if (harper) {
    const installDir = harper.installDir;
    await stopHarper(harper).catch(() => {});
    rmSync(installDir, { recursive: true, force: true, maxRetries: 4 });
  }
  if (home) rmSync(home, { recursive: true, force: true });
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  component?.cleanup();
}, HARPER_STOP_BUDGET_MS);

describe("flair#2478 slice 3b — the maintenance archive writer (real Harper)", () => {
  it("CONTROL: an uncontended run archives the expired row and leaves its other fields as stored", async () => {
    const id = "mul-arc-control";
    await seed(id, { validTo: PAST, usageCount: 4 });
    const stats = await maintain(owner.id);
    expect(stats.archived, JSON.stringify(stats)).toBe(1);
    const row = await readRow(id);
    expect(row?.archived).toBe(true);
    expect(row?.archivedAt).toBeTruthy();
    expect(row?.content).toBe(`content of ${id}`);
    expect(row?.visibility).toBe("shared");
    expect(row?.usageCount).toBe(4);
    h.expectIncrementalWrites(id, ARCHIVE_WRITER, ARCHIVE_FIELDS);
    expect(h.writesBy(id, ARCHIVE_WRITER)).toHaveLength(1);
  }, 60_000);

  it("held after staging: an owner PUT is refused memory_busy; after release the archive and a later owner PUT's content and visibility are stored", async () => {
    const id = "mul-arc-staged";
    await seed(id, { validTo: PAST });
    const point = "maintenance-archive-staged";
    arm(point);
    const pending = maintain(owner.id);
    await pauseAt(point);
    await expectBusy(await ownerWrite(owner, "PUT", id, { content: "owner text after the staged archive" }));
    release(point);
    const stats = await pending;
    await assertReleased(point);
    expect(stats.archived, JSON.stringify(stats)).toBe(1);
    expect((await readRow(id))?.archived).toBe(true);
    h.expectIncrementalWrites(id, ARCHIVE_WRITER, ARCHIVE_FIELDS);
    const put = await ownerWrite(owner, "PUT", id, { content: "owner text after the archive committed", visibility: "private" });
    expect(put.status, `owner PUT after release: ${await put.clone().text()}`).toBeLessThan(300);
    const row = await readRow(id);
    expect(row?.content).toBe("owner text after the archive committed");
    expect(row?.visibility).toBe("private");
  }, 120_000);

  it("held past its confirmation, before the commit: an owner PATCH is refused memory_busy; both writes are stored afterwards", async () => {
    const id = "mul-arc-commit";
    await seed(id, { validTo: PAST });
    const point = "maintenance-archive-commit";
    arm(point);
    const pending = maintain(owner.id);
    await pauseAt(point);
    await expectBusy(await ownerWrite(owner, "PATCH", id, { content: "owner patch at the commit point" }));
    release(point);
    const stats = await pending;
    await assertReleased(point);
    expect(stats.archived, JSON.stringify(stats)).toBe(1);
    expect((await readRow(id))?.archived).toBe(true);
    const patch = await ownerWrite(owner, "PATCH", id, { content: "owner patch after the archive", visibility: "private" });
    expect(patch.status, `owner PATCH after release: ${await patch.clone().text()}`).toBeLessThan(300);
    const row = await readRow(id);
    expect(row?.content).toBe("owner patch after the archive");
    expect(row?.visibility).toBe("private");
    expect(row?.archived).toBe(true);
  }, 120_000);

  it("a second run while the id is held skips the row and reports it", async () => {
    const id = "mul-arc-miss";
    await seed(id, { validTo: PAST });
    const point = "maintenance-archive-staged";
    arm(point);
    const held = maintain(owner.id);
    await pauseAt(point);
    const second = await maintain(owner.id);
    expect(second.skipped, JSON.stringify(second)).toBeGreaterThanOrEqual(1);
    expect(second.archived, JSON.stringify(second)).toBe(0);
    release(point);
    await held;
    await assertReleased(point);
    expect(await waitForLog("[MemoryMaintenance] row skipped: busy"), "the skipped row was not reported").toBe(true);
  }, 120_000);

  it("owner first: the run reads the owner's committed row and skips it, and the owner's fields are stored", async () => {
    const id = "mul-arc-ownerfirst";
    await seed(id, { validTo: PAST });
    const point = "maintenance-archive-pre";
    arm(point);
    const pending = maintain(owner.id);
    await pauseAt(point);
    const put = await ownerWrite(owner, "PUT", id, { content: "owner text committed first" });
    expect(put.status, `owner PUT: ${await put.clone().text()}`).toBeLessThan(300);
    release(point);
    const stats = await pending;
    await assertReleased(point);
    expect(stats.archived, JSON.stringify(stats)).toBe(0);
    expect(stats.skipped, JSON.stringify(stats)).toBeGreaterThanOrEqual(1);
    const row = await readRow(id);
    expect(row?.content).toBe("owner text committed first");
    expect(row?.archived).toBe(false);
  }, 120_000);
});

describe("flair#2478 slice 3b — the maintenance expiry writer (real Harper)", () => {
  it("held after staging: an owner PUT is refused memory_busy, then the delete commits", async () => {
    const id = "mul-exp-staged";
    await seed(id, { durability: "ephemeral", visibility: "private", expiresAt: PAST });
    const point = "maintenance-expiry-staged";
    arm(point);
    const pending = maintain(owner.id);
    await pauseAt(point);
    await expectBusy(await ownerWrite(owner, "PUT", id, { content: "owner text at the staged delete" }));
    release(point);
    const stats = await pending;
    await assertReleased(point);
    expect(stats.expired, JSON.stringify(stats)).toBe(1);
    expect(await readRow(id)).toBeNull();
  }, 120_000);

  it("a second run while the id is held skips the delete and reports it", async () => {
    const id = "mul-exp-miss";
    await seed(id, { durability: "ephemeral", visibility: "private", expiresAt: PAST });
    const point = "maintenance-expiry-staged";
    arm(point);
    const held = maintain(owner.id);
    await pauseAt(point);
    const second = await maintain(owner.id);
    expect(second.skipped, JSON.stringify(second)).toBeGreaterThanOrEqual(1);
    expect(second.expired, JSON.stringify(second)).toBe(0);
    release(point);
    await held;
    await assertReleased(point);
    expect(await waitForLog("[MemoryMaintenance] row skipped: busy"), "the skipped row was not reported").toBe(true);
  }, 120_000);

  it("owner first: the run reads the owner's committed row and skips the delete", async () => {
    const id = "mul-exp-ownerfirst";
    await seed(id, { durability: "ephemeral", visibility: "private", expiresAt: PAST });
    const point = "maintenance-expiry-pre";
    arm(point);
    const pending = maintain(owner.id);
    await pauseAt(point);
    const put = await ownerWrite(owner, "PUT", id, { content: "owner text before the expiry" });
    expect(put.status, `owner PUT: ${await put.clone().text()}`).toBeLessThan(300);
    release(point);
    const stats = await pending;
    await assertReleased(point);
    expect(stats.expired, JSON.stringify(stats)).toBe(0);
    expect(stats.skipped, JSON.stringify(stats)).toBeGreaterThanOrEqual(1);
    const row = await readRow(id);
    expect(row?.content).toBe("owner text before the expiry");
  }, 120_000);
});

describe("flair#2478 slice 3b — the usage-count writer (real Harper)", () => {
  it("CONTROL: one contribution bumps usageCount by one and leaves the other fields as stored", async () => {
    const id = "mul-use-control";
    await seed(id, { usageCount: 2 });
    const res = await recordUsage(owner, id);
    expect(res.status, `RecordUsage: ${await res.clone().text()}`).toBe(200);
    expect((await readRow(id))?.usageCount).toBe(3);
    expect((await readRow(id))?.content).toBe(`content of ${id}`);
    expect((await readLedger(owner.id, id))?.id).toBe(`${owner.id}:${id}`);
    h.expectIncrementalWrites(id, USAGE_WRITER, USAGE_FIELDS);
    expect(h.writesBy(id, USAGE_WRITER)).toHaveLength(1);
  }, 60_000);

  it("held after the count is staged: an owner PUT is refused memory_busy; after release the count and a later owner PUT's content and visibility are stored", async () => {
    const id = "mul-use-staged";
    await seed(id);
    const point = "usage-count-staged";
    arm(point);
    const pending = recordUsage(owner, id);
    await pauseAt(point);
    await expectBusy(await ownerWrite(owner, "PUT", id, { content: "owner text at the staged count" }));
    release(point);
    const res = await pending;
    await assertReleased(point);
    expect(res.status, `RecordUsage: ${await res.clone().text()}`).toBe(200);
    expect((await readRow(id))?.usageCount).toBe(1);
    h.expectIncrementalWrites(id, USAGE_WRITER, USAGE_FIELDS);
    const put = await ownerWrite(owner, "PUT", id, { content: "owner text after the count", visibility: "private" });
    expect(put.status, `owner PUT after release: ${await put.clone().text()}`).toBeLessThan(300);
    const row = await readRow(id);
    expect(row?.content).toBe("owner text after the count");
    expect(row?.visibility).toBe("private");
  }, 120_000);

  it("held past its confirmation, before the commit: an owner PATCH is refused memory_busy; both writes are stored afterwards", async () => {
    const id = "mul-use-commit";
    await seed(id);
    const point = "usage-count-commit";
    arm(point);
    const pending = recordUsage(owner, id);
    await pauseAt(point);
    await expectBusy(await ownerWrite(owner, "PATCH", id, { content: "owner patch at the count commit point" }));
    release(point);
    const res = await pending;
    await assertReleased(point);
    expect(res.status, `RecordUsage: ${await res.clone().text()}`).toBe(200);
    expect((await readRow(id))?.usageCount).toBe(1);
    const patch = await ownerWrite(owner, "PATCH", id, { content: "owner patch after the count", visibility: "private" });
    expect(patch.status, `owner PATCH after release: ${await patch.clone().text()}`).toBeLessThan(300);
    const row = await readRow(id);
    expect(row?.content).toBe("owner patch after the count");
    expect(row?.visibility).toBe("private");
  }, 120_000);

  it("a second agent's contribution while the id is held is skipped and reported: no ledger row for that agent, no second bump", async () => {
    const id = "mul-use-miss";
    await seed(id);
    const point = "usage-count-staged";
    arm(point);
    const held = recordUsage(owner, id);
    await pauseAt(point);
    const second = await recordUsage(reader, id);
    expect(second.status, `second RecordUsage: ${await second.clone().text()}`).toBe(200);
    release(point);
    await held;
    await assertReleased(point);
    expect(await waitForLog("[usage-recording] contribution skipped: busy"), "the skipped contribution was not reported").toBe(true);
    expect((await readRow(id))?.usageCount).toBe(1);
    expect((await readLedger(owner.id, id))?.id).toBe(`${owner.id}:${id}`);
    expect(await readLedger(reader.id, id), "the skipped contribution wrote a ledger row").toBeNull();
  }, 120_000);

  it("owner first: an owner PUT holding the id makes the contribution skip, and the owner's fields are stored", async () => {
    const id = "mul-use-ownerfirst";
    await seed(id);
    const point = "memory-put-committed";
    arm(point);
    const put = ownerWrite(owner, "PUT", id, { content: "owner text holding the id", visibility: "private" });
    await pauseAt(point);
    const res = await recordUsage(owner, id);
    expect(res.status, `RecordUsage: ${await res.clone().text()}`).toBe(200);
    release(point);
    expect((await put).status).toBeLessThan(300);
    await assertReleased(point);
    expect(await waitForLog("[usage-recording] contribution skipped: busy")).toBe(true);
    const row = await readRow(id);
    expect(row?.content).toBe("owner text holding the id");
    expect(row?.visibility).toBe("private");
    expect(await readLedger(owner.id, id)).toBeNull();
  }, 120_000);
});
