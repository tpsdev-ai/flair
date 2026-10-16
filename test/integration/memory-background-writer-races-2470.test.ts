/**
 * memory-background-writer-races-2470.test.ts — usage-count and archive patches
 * preserve the content edit in an earlier-started owner PUT (flair#2470), real Harper.
 *
 * Harper orders a transaction by its FIRST READ. The converted writers below
 * (the usage-count bump and the maintenance archive) used to write back the
 * WHOLE row they read; an owner PUT whose transaction opened FIRST — and
 * therefore committed as an OLDER full update — was dropped by Harper's
 * out-of-order reconciliation while the PUT still answered 200 (measured during
 * flair#2469 round 5, with audit logging on). Each now writes an INCREMENTAL
 * update of only its named patch fields, which Harper folds around the older PUT
 * instead of superseding it.
 *
 * DETERMINISTIC ORDERING via the existing pause-point helpers
 * (resources/txn-pause-point.ts, enabled by FLAIR_ENABLE_TEST_FAULT_INJECTION and
 * FLAIR_TEST_PAUSE_DIR, set in this process's environment while it starts its
 * Harper, then restored): each writer pauses at its own `*-pre` point BEFORE its
 * owned transaction opens (before its read), and `memory-put` holds the owner PUT
 * inside its own transaction, after its first read and before its write, so the
 * PUT's transaction opens FIRST. The writer's pre-pause is released only once the
 * PUT is held, so the writer's transaction opens AFTER the PUT's read and commits
 * BEFORE the PUT's write: the PUT is the OLDER full update, the writer's write the
 * NEWER one.
 *
 * The rows are seeded in a first boot; Harper is then stopped and restarted
 * against the same data dir with the pause points armed, and the second boot's
 * request-driven writers are the ones under test.
 *
 * Throwaway HOME + data dir, ephemeral ports.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { stripEnginePrefix } from "../../resources/embedding-space-guard.ts";

const PUT_POINT = "memory-put";
// A bare (engine-prefix-stripped) current stamp: the boot embedding-stamp
// migration treats the seeded row as current-space and never re-embeds it, so
// it cannot race the write under test.
const SEED_MODEL_ID = stripEnginePrefix(getModelId());
const ORIGINAL = "the original text held before the owner's edit";
const EDITED = "the owner's edit that a full-row background write must not revert";

interface TestAgent { id: string; publicKey: Uint8Array; secretKey: Uint8Array; }
const newAgent = (id: string): TestAgent => ({ id, ...nacl.sign.keyPair() });
const owner = newAgent("bwr-owner");

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
async function healthDetail(): Promise<any> {
  const res = await fetch(`${harper.httpURL}/HealthDetail`, { headers: { Authorization: authHeader } });
  if (!res.ok) return null;
  return res.json();
}
function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}
/** An owner PUT over the real HTTP route, signed as `agent`. */
function editAs(agent: TestAgent, id: string, content: string): Promise<Response> {
  const path = `/Memory/${encodeURIComponent(id)}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(agent, "PUT", path) },
    body: JSON.stringify({ agentId: agent.id, content }),
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
/**
 * A boot migration cycle that finished cleanly: phase "done", no cycle error, a
 * migrations list with at least one entry, and every entry "completed".
 * "idle" means the boot trigger never loaded (migration-boot.ts), and the
 * runner can mark a cycle "done" after a migration failed or halted
 * (runner.ts); an empty list is the idle/no-op shape. None of those is a
 * completed cycle, so the guard accepts only a non-empty list of completed
 * entries (flair#2494).
 */
export function cycleCompletedCleanly(migrations: any): boolean {
  if (migrations?.cyclePhase !== "done" || migrations?.lastCycleError) return false;
  if (!Array.isArray(migrations?.migrations)) return false;
  return migrations.migrations.length > 0 && migrations.migrations.every((m: any) => m?.state === "completed");
}
async function waitForCycleDone(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await healthDetail();
    if (detail?.migrations?.cyclePhase === "done") return cycleCompletedCleanly(detail.migrations);
    await new Promise((r) => setTimeout(r, 250));
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
/** Wait until the usage-count bump on `id` has committed. */
async function waitForUsageCount(id: string, expected: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await readRow(id);
    if (row?.usageCount === expected) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
/** A signed POST /RecordUsage (the usage-count bump's trigger). */
function recordUsage(agent: TestAgent, memoryIds: string[]): Promise<Response> {
  const path = "/RecordUsage";
  return fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(agent, "POST", path) },
    body: JSON.stringify({ memoryIds }),
    signal: AbortSignal.timeout(60_000),
  });
}
/** A signed POST /MemoryMaintenance (the archive worker's trigger). */
function runMaintenance(agent: TestAgent): Promise<Response> {
  const path = "/MemoryMaintenance";
  return fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: ed25519Header(agent, "POST", path) },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(60_000),
  });
}
/** Wait until the maintenance archive flip on `id` has committed. */
async function waitForArchived(id: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await readRow(id);
    if (row?.archived === true) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const USAGE_ID = "bwr-usage";
const ARCHIVE_ID = "bwr-archive";

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2470-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2470-pause-"));

  // Boot 1: no fault injection. Wait for the boot migration cycle to finish
  // BEFORE seeding, so that cycle can never see (and process) the seeded rows.
  const first = await startHarper({ homeDir: home });
  authHeader = "Basic " + Buffer.from(`${first.admin.username}:${first.admin.password}`).toString("base64");
  harper = first;
  expect(await waitForCycleDone(30_000), "the first boot migration cycle did not finish before seeding").toBe(true);
  await opsCall({
    operation: "upsert", database: "flair", table: "Agent",
    records: [{
      id: owner.id, name: owner.id, role: "agent",
      publicKey: Buffer.from(owner.publicKey).toString("base64"), createdAt: new Date().toISOString(),
    }],
  });
  await opsCall({
    operation: "insert", database: "flair", table: "Memory",
    records: [{
      id: USAGE_ID, agentId: owner.id, content: ORIGINAL, durability: "standard", visibility: "shared",
      embedding: [0.1, 0.2, 0.3], embeddingModel: SEED_MODEL_ID, instanceToken: randomUUID(),
      usageCount: 0, createdAt: new Date().toISOString(),
    }],
  });
  await opsCall({
    operation: "insert", database: "flair", table: "Memory",
    records: [{
      id: ARCHIVE_ID, agentId: owner.id, content: ORIGINAL, durability: "standard", visibility: "shared",
      // An archive candidate by validTo (already ended). Set from the start of
      // boot 2 so the request-driven maintenance can archive it.
      validTo: new Date(Date.now() - 60_000).toISOString(),
      embedding: [0.1, 0.2, 0.3], embeddingModel: SEED_MODEL_ID, instanceToken: randomUUID(),
      createdAt: new Date().toISOString(),
    }],
  });
  await stopHarper(first, { keepInstallDir: true });

  // Boot 2: fault injection on, so the request-driven writers' pause points are
  // live for the cases below to arm at run time.
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper({ installDir: first.installDir, homeDir: home });
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
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper).catch(() => {});
  if (home) rmSync(home, { recursive: true, force: true });
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);


describe("cycleCompletedCleanly (the first-boot guard)", () => {
  const ok = { id: "m", rowsDone: 0, rowsRemaining: 0, state: "completed" };
  it("accepts a clean completed cycle", () => {
    expect(cycleCompletedCleanly({ cyclePhase: "done", migrations: [ok] })).toBe(true);
  });
  it("rejects an idle cycle (the boot trigger never loaded)", () => {
    expect(cycleCompletedCleanly({ cyclePhase: "idle", migrations: [] })).toBe(false);
  });
  it("rejects a cycle that ended with an error", () => {
    expect(cycleCompletedCleanly({ cyclePhase: "done", lastCycleError: "x", migrations: [ok] })).toBe(false);
  });
  it("rejects a done cycle with a failed migration", () => {
    expect(cycleCompletedCleanly({ cyclePhase: "done", migrations: [ok, { ...ok, id: "f", state: "failed" }] })).toBe(false);
  });
  it("rejects a done cycle with a halted migration", () => {
    expect(cycleCompletedCleanly({ cyclePhase: "done", migrations: [{ ...ok, state: "halted" }] })).toBe(false);
  });
  it("rejects a snapshot without a migrations list", () => {
    expect(cycleCompletedCleanly({ cyclePhase: "done" })).toBe(false);
  });
  it("rejects a done cycle with an empty migration list (the idle/no-op shape)", () => {
    expect(cycleCompletedCleanly({ cyclePhase: "done", migrations: [] })).toBe(false);
  });
  it("rejects a done cycle with an entry still idle", () => {
    expect(cycleCompletedCleanly({ cyclePhase: "done", migrations: [{ ...ok, state: "idle" }] })).toBe(false);
  });
  it("rejects a done cycle whose only entry is not completed", () => {
    expect(cycleCompletedCleanly({ cyclePhase: "done", migrations: [{ ...ok, state: "running" }] })).toBe(false);
  });
});

describe("flair#2470 — usage-count and archive patches preserve an earlier-started owner content edit (real Harper)", () => {
  it("the usage-count bump's newer incremental write folds around the older owner PUT; the edit survives and the count lands", async () => {
    // Hold the usage-count bump before its own transaction opens.
    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.usage-count-pre`), { force: true });
    writeFileSync(join(pauseDir, "arm.usage-count-pre"), "");
    const pendingUsage = recordUsage(owner, [USAGE_ID]);
    const usagePaused = await waitFor(join(pauseDir, "paused.usage-count-pre"), 30_000);
    expect(usagePaused, "the usage-count bump never reached its pre-transaction pause").toBe(true);

    // Start the owner PUT; its transaction opens FIRST and is held before its write.
    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${PUT_POINT}`), { force: true });
    writeFileSync(join(pauseDir, `arm.${PUT_POINT}`), "");
    const pendingPut = editAs(owner, USAGE_ID, EDITED);
    const putPaused = await waitFor(join(pauseDir, `paused.${PUT_POINT}`), 30_000);
    expect(putPaused, "the owner PUT never reached its in-transaction pause").toBe(true);

    // Let the count bump commit first, then release the PUT (its older full
    // update commits last — the out-of-order case).
    writeFileSync(join(pauseDir, "go.usage-count-pre"), "");
    await assertReleased("usage-count-pre");
    const bumped = await waitForUsageCount(USAGE_ID, 1, 30_000);
    expect(bumped, "the usage-count bump did not commit").toBe(true);
    writeFileSync(join(pauseDir, `go.${PUT_POINT}`), "");
    const [usage, put] = await Promise.all([pendingUsage, pendingPut]);
    await assertReleased(PUT_POINT);

    expect(usage.status, `the usage bump did not answer 2xx: ${await usage.clone().text()}`).toBeLessThan(300);
    expect(put.status, `the owner PUT did not answer 200: ${await put.clone().text()}`).toBe(200);

    const row = await readRow(USAGE_ID);
    expect(row.usageCount, "the usage-count bump did not land").toBe(1);
    expect(row.content, "the background write reverted the owner's committed edit").toBe(EDITED);
  }, 120_000);

  it("the maintenance archive's newer field-only write folds around the older owner PUT; the edit survives and archived lands", async () => {
    // Hold the maintenance archive before its own transaction opens.
    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.maintenance-archive-pre`), { force: true });
    writeFileSync(join(pauseDir, "arm.maintenance-archive-pre"), "");
    const pendingMaintenance = runMaintenance(owner);
    const maintenancePaused = await waitFor(join(pauseDir, "paused.maintenance-archive-pre"), 30_000);
    expect(maintenancePaused, "the maintenance archive never reached its pre-transaction pause").toBe(true);

    // Start the owner PUT; its transaction opens FIRST and is held before its write.
    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${PUT_POINT}`), { force: true });
    writeFileSync(join(pauseDir, `arm.${PUT_POINT}`), "");
    const pendingPut = editAs(owner, ARCHIVE_ID, EDITED);
    const putPaused = await waitFor(join(pauseDir, `paused.${PUT_POINT}`), 30_000);
    expect(putPaused, "the owner PUT never reached its in-transaction pause").toBe(true);

    // Let the archive commit first (its newer field-only write), THEN release the
    // PUT — its older full update commits last; Harper's out-of-order
    // reconciliation is the case under test. A full-row archive write here would
    // revert the PUT's content.
    writeFileSync(join(pauseDir, "go.maintenance-archive-pre"), "");
    await assertReleased("maintenance-archive-pre");
    const archived = await waitForArchived(ARCHIVE_ID, 30_000);
    expect(archived, "the maintenance did not commit its archived flip").toBe(true);
    writeFileSync(join(pauseDir, `go.${PUT_POINT}`), "");
    const [put] = await Promise.all([pendingPut, pendingMaintenance]);
    await assertReleased(PUT_POINT);

    expect(put.status, `the owner PUT did not answer 200: ${await put.clone().text()}`).toBe(200);
    const row = await readRow(ARCHIVE_ID);
    expect(row, "the row vanished").not.toBeNull();
    expect(row.archived, "the maintenance's own field did not land").toBe(true);
    expect(row.content, "the background write reverted the owner's committed edit").toBe(EDITED);
  }, 120_000);
});
