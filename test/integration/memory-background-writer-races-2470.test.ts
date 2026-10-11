/**
 * memory-background-writer-races-2470.test.ts — a background writer that owns
 * only some fields of a Memory row must not supersede an earlier-started owner
 * PUT that still answers 200 (flair#2470), real Harper.
 *
 * Harper orders a transaction by its FIRST READ. The boot `visibility-backfill`
 * migration used to write back the WHOLE row it read (`{ ...existing, visibility }`
 * through the shared write-back helper), so an owner PUT whose transaction opened
 * FIRST — and therefore committed as an OLDER full update — was dropped by
 * Harper's out-of-order reconciliation while the PUT still answered 200
 * (measured during flair#2469 round 5, with audit logging on). The migration now
 * writes an INCREMENTAL update of `visibility` only, which Harper folds around
 * the older PUT instead of superseding it.
 *
 * DETERMINISTIC ORDERING via the existing pause-point helpers
 * (resources/txn-pause-point.ts, enabled by FLAIR_ENABLE_TEST_FAULT_INJECTION and
 * FLAIR_TEST_PAUSE_DIR, set in this process's environment while it starts its
 * Harper, then restored):
 *   - `visibility-backfill-pre` holds the migration BEFORE its owned transaction
 *     opens (before its read);
 *   - `memory-put` holds the owner PUT inside its own transaction, after its first
 *     read and before its write, so its transaction opens FIRST.
 * The migration's pre-pause is released only once the PUT is held, so the
 * migration's transaction opens AFTER the PUT's read and commits BEFORE the PUT's
 * write: the PUT is the OLDER full update, the migration's write the NEWER one.
 *
 * Boot-keyed migration means exactly that: one cycle per boot. A row seeded into
 * an already-booted instance is not seen by that boot's cycle, so the candidate
 * row is seeded in a first boot, Harper is stopped and restarted against the same
 * data dir, and the second boot's cycle — armed to pause — is the one under test.
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
import { getModelId } from "../../resources/embeddings-provider.ts";
import { stripEnginePrefix } from "../../resources/embedding-space-guard.ts";

const PRE_POINT = "visibility-backfill-pre";
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
async function waitForCycleDone(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await healthDetail();
    const phase = detail?.migrations?.cyclePhase;
    if (phase === "done" || phase === "idle") return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
/** Wait until the migration's incremental write to `id` has committed. */
async function waitForVisibility(id: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await readRow(id);
    if (row?.visibility === "shared") return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
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

const CANDIDATE_ID = "bwr-candidate";
const USAGE_ID = "bwr-usage";

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  home = mkdtempSync(join(tmpdir(), "flair-2470-home-"));
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2470-pause-"));

  // Boot 1: no fault injection. Wait for the boot migration cycle to finish
  // BEFORE seeding, so that cycle can never see (and process) the candidate.
  const first = await startHarper({ homeDir: home });
  authHeader = "Basic " + Buffer.from(`${first.admin.username}:${first.admin.password}`).toString("base64");
  harper = first;
  await waitForCycleDone(30_000);
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
      id: CANDIDATE_ID, agentId: owner.id, content: ORIGINAL, durability: "permanent",
      // No `visibility` — the migration's candidate. A current bare stamp so the
      // boot embedding-stamp migration never touches it.
      embedding: [0.1, 0.2, 0.3], embeddingModel: SEED_MODEL_ID, instanceToken: randomUUID(),
      createdAt: new Date().toISOString(),
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
  await stopHarper(first, { keepInstallDir: true });

  // Boot 2: fault injection on; the migration's pre-transaction pause is armed
  // before the spawn, so its cycle pauses before opening its transaction.
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${PRE_POINT}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${PRE_POINT}`), "");
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
});

describe("flair#2470 — a background field-only writer keeps an earlier-started owner PUT (real Harper)", () => {
  it("the visibility-backfill migration's newer incremental write folds around the older owner PUT; the edit survives and visibility lands", async () => {
    // Hold the migration before its own transaction opens.
    const migrationPaused = await waitFor(join(pauseDir, `paused.${PRE_POINT}`), 45_000);
    expect(migrationPaused, "the migration never reached its pre-transaction pause").toBe(true);

    // Start the owner PUT; its transaction opens FIRST and is held before its write.
    for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${PUT_POINT}`), { force: true });
    writeFileSync(join(pauseDir, `arm.${PUT_POINT}`), "");
    const pendingPut = editAs(owner, CANDIDATE_ID, EDITED);
    const putPaused = await waitFor(join(pauseDir, `paused.${PUT_POINT}`), 30_000);
    expect(putPaused, "the owner PUT never reached its in-transaction pause").toBe(true);

    // Let the migration run to completion (its newer incremental write commits
    // first), THEN release the PUT — so the PUT's older full update commits last
    // and Harper's out-of-order reconciliation is the case under test.
    writeFileSync(join(pauseDir, `go.${PRE_POINT}`), "");
    await waitFor(join(pauseDir, `released.${PRE_POINT}`), 30_000);
    const stamped = await waitForVisibility(CANDIDATE_ID, 30_000);
    expect(stamped, "the migration did not commit its visibility write").toBe(true);
    writeFileSync(join(pauseDir, `go.${PUT_POINT}`), "");
    const put = await pendingPut;
    const released = readFileSync(join(pauseDir, `released.${PUT_POINT}`), "utf8");

    expect(released, "the PUT pause ended by timeout, not by this test").toBe("go");
    expect(put.status, `the owner PUT did not answer 200: ${await put.clone().text()}`).toBe(200);

    const row = await readRow(CANDIDATE_ID);
    expect(row, "the row vanished").not.toBeNull();
    expect(row.visibility, "the migration's own field did not land").toBe("shared");
    expect(row.content, "the background write reverted the owner's committed edit").toBe(EDITED);
  }, 120_000);

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
    await waitFor(join(pauseDir, "released.usage-count-pre"), 30_000);
    const bumped = await waitForUsageCount(USAGE_ID, 1, 30_000);
    expect(bumped, "the usage-count bump did not commit").toBe(true);
    writeFileSync(join(pauseDir, `go.${PUT_POINT}`), "");
    const [usage, put] = await Promise.all([pendingUsage, pendingPut]);

    expect(usage.status, `the usage bump did not answer 2xx: ${await usage.clone().text()}`).toBeLessThan(300);
    expect(put.status, `the owner PUT did not answer 200: ${await put.clone().text()}`).toBe(200);

    const row = await readRow(USAGE_ID);
    expect(row.usageCount, "the usage-count bump did not land").toBe(1);
    expect(row.content, "the background write reverted the owner's committed edit").toBe(EDITED);
  }, 120_000);
});
