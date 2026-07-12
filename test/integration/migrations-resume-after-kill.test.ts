/**
 * migrations-resume-after-kill.test.ts — proves crash-resume (invariant IV:
 * "Idempotent, resumable, observable... crash-resume free" /
 * flair#695: "ENOSPC/crash mid-run = clean halt,
 * auto-resume next boot").
 *
 * Seeds rows spanning multiple batches, starts Harper, waits for the
 * migration to genuinely be mid-flight, SIGTERMs the Harper process (real
 * kill, not a simulated stop), restarts a FRESH Harper process against the
 * SAME data directory (harper-lifecycle.ts's documented installDir-reuse
 * pattern), and asserts the new boot resumes and completes — no row lost,
 * none double-processed in a way that corrupts data.
 *
 * ── MIGRATION ISOLATION (root-cause fix for CI failure #2, 2026-07-12) ──
 * The registry runs migrations SEQUENTIALLY, and `embedding-stamp` (always
 * registered, first in order) considers any row whose `embeddingModel` ≠
 * getModelId() stale. This test's seeded rows originally carried a stub
 * `embeddingModel: "test-stub"` — so on boot #2, embedding-stamp detected
 * ALL 140 rows and re-embedded them one-by-one via loopback HTTP PUT with
 * REAL embedding computation, while the synthetic migration this test
 * observes sat queued in state "checking" behind it. CI evidence (run
 * 29177056065): phase-1 timed out at 120s with the synthetic migration
 * still `{"state":"checking","rowsDone":0}`; in the SAME job,
 * migrations-synthetic-e2e (8 rows, same stub stamp) completed in 9.1s —
 * ~0.5-0.75s per CPU re-embed, which scales to ~70-105s for 140 rows,
 * plus embedding-stamp's own knob-widened batch sleeps: past the deadline.
 * Local Metal-accelerated embeds (~10-30ms/row) masked this entirely.
 * Fix: pin FLAIR_EMBEDDING_MODEL (only consumed by getModelId() — the
 * stamp string, never model loading) and seed rows with the EXACT stamp
 * getModelId() computes for that pinned base id (derived by calling the
 * real function, below — not hardcoded, so this test can't silently drift
 * from embeddings-provider.ts's actual gate state, see flair#504), so
 * embedding-stamp detects NOTHING and the synthetic migration — the one
 * under test — starts immediately after the shared pre-hash. The ground
 * truth check asserts the isolation held (embeddingModel still the pinned
 * stamp at the end — embedding-stamp never touched the rows).
 *
 * ── DETERMINISM (fix for CI failure #1) ──
 *   - FLAIR_MIGRATION_TEST_BATCH_DELAY_MS (runner.ts's test-only throttle
 *     override, double-gated on FLAIR_ENABLE_TEST_MIGRATIONS) widens each
 *     batch delay to 2.5s so the running phase spans SECONDS and the kill
 *     lands mid-flight deterministically;
 *   - two-phase observation: wait for state=running (120s deadline, covers
 *     the deferred start — tables-ready + embeddings settle + async
 *     pre-hash), THEN catch mid-flight inside the widened window;
 *   - too-fast guard kept: "completed" seen before mid-flight FAILS loudly.
 *
 * On any phase timeout the assertion message carries full self-diagnostics
 * (whole migrations status block, migration state-store file, boot-log
 * tail) so a future CI failure explains itself without another
 * evidence-gathering cycle.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider";

const RESERVED_TEST_AGENT_ID = "__flair_migration_synthetic_test_agent__";
const SYNTHETIC_TARGET_MARKER = "synthetic-ci-schema-stamp-done";
const SYNTHETIC_MIGRATION_ID = "synthetic-ci-schema-stamp";
const ROW_COUNT = 140; // 3 batches at the schema-additive batch size (50) — two observable mid-flight windows
const TEST_BATCH_DELAY_MS = 2500; // widens each mid-flight window to ~2.5s (vs the 100ms prod default)
// Pinned base id — see "MIGRATION ISOLATION" above. Set as FLAIR_EMBEDDING_MODEL
// for the spawned Harper (beforeAll, below).
const PINNED_EMBEDDING_MODEL = "resume-test-pinned-model";
// The EXACT stamp getModelId() computes for PINNED_EMBEDDING_MODEL under
// this build's THE GATE (flair#504) — derived by calling the real,
// harper-free `getModelId()` (it only reads env vars + the module-level
// gate constant, never triggers embeddings-provider.ts's deferred Harper
// import), not hardcoded as a literal. This is what makes the isolation
// hold regardless of which way THE GATE is currently set: whether
// `getModelId()` returns the bare base id or `<base>+searchprefix`, this
// constant always matches it, so the seeded rows below never read as stale
// to embedding-stamp inside the spawned Harper (same build, same env var,
// same gate — see the spawned process's own getModelId() for why this is a
// faithful mirror, not a guess).
const PINNED_EMBEDDING_STAMP = (() => {
  const saved = process.env.FLAIR_EMBEDDING_MODEL;
  process.env.FLAIR_EMBEDDING_MODEL = PINNED_EMBEDDING_MODEL;
  try {
    return getModelId();
  } finally {
    if (saved === undefined) delete process.env.FLAIR_EMBEDDING_MODEL;
    else process.env.FLAIR_EMBEDDING_MODEL = saved;
  }
})();

let harper: HarperInstance;
let installDir: string;
let authHeader: string;
let bootLog = "";

/** Re-attach after every startHarper — captures the CURRENT process's output for failure diagnostics. */
function captureBootLog(inst: HarperInstance): void {
  bootLog = "";
  inst.process?.stdout?.on("data", (d: Buffer) => { bootLog += d.toString(); });
  inst.process?.stderr?.on("data", (d: Buffer) => { bootLog += d.toString(); });
}

async function opsCall(inst: HarperInstance, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(inst.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops call failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}

async function healthDetail(inst: HarperInstance): Promise<any> {
  const res = await fetch(`${inst.httpURL}/HealthDetail`, { headers: { Authorization: authHeader } });
  if (!res.ok) return null;
  return res.json();
}

async function findMigration(inst: HarperInstance): Promise<any> {
  const detail = await healthDetail(inst);
  return detail?.migrations?.migrations?.find((m: any) => m.id === SYNTHETIC_MIGRATION_ID);
}

/**
 * Failure-path self-diagnostics: the FULL migrations status block (every
 * registered migration + cycle phase — not just the one entry, since "stuck
 * in checking" means the interesting migration is a DIFFERENT one running
 * ahead of it), the on-disk migration state store, and the boot-log tail.
 */
async function diagnose(inst: HarperInstance): Promise<string> {
  let migrationsBlock = "(HealthDetail unavailable)";
  try {
    const detail = await healthDetail(inst);
    migrationsBlock = JSON.stringify(detail?.migrations ?? null, null, 2);
  } catch (err: any) {
    migrationsBlock = `(HealthDetail threw: ${err?.message ?? String(err)})`;
  }
  let stateStore = "(state file unreadable/absent)";
  try {
    stateStore = readFileSync(join(installDir, ".flair", "data", ".migrations", "state.json"), "utf-8");
  } catch { /* keep placeholder */ }
  const logTail = bootLog.length > 4000 ? `…(truncated)…\n${bootLog.slice(-4000)}` : bootLog;
  return [
    "── DIAGNOSTICS ──",
    `migrations status block:\n${migrationsBlock}`,
    `migration state store (<dataDir>/.migrations/state.json):\n${stateStore}`,
    `boot-log tail:\n${logTail || "(no output captured)"}`,
  ].join("\n\n");
}

describe("zero-touch migrations — resume after a mid-migration process kill (real Harper)", () => {
  beforeAll(async () => {
    process.env.FLAIR_ENABLE_TEST_MIGRATIONS = "1";
    process.env.FLAIR_MIGRATION_TEST_BATCH_DELAY_MS = String(TEST_BATCH_DELAY_MS);
    process.env.FLAIR_EMBEDDING_MODEL = PINNED_EMBEDDING_MODEL;

    const first = await startHarper();
    installDir = first.installDir;
    authHeader = "Basic " + Buffer.from(`${first.admin.username}:${first.admin.password}`).toString("base64");

    const records = Array.from({ length: ROW_COUNT }, (_, i) => ({
      id: `resume-seed-${i}`,
      agentId: RESERVED_TEST_AGENT_ID,
      content: `resume row ${i}`,
      source: "not-yet",
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: PINNED_EMBEDDING_STAMP, // matches getModelId() in the spawned server — invisible to embedding-stamp
      createdAt: new Date().toISOString(),
    }));
    // Single bulk insert — ops API accepts multiple records per call. (The
    // seeding boot's own migration cycle already ran against an EMPTY
    // corpus and found nothing pending, so these rows sit untouched.)
    await opsCall(first, { operation: "insert", database: "flair", table: "Memory", records });

    // Boot-keyed: seeding into an already-booted instance doesn't retrigger
    // its (already-fired) cycle — stop and restart so a FRESH boot discovers
    // the seeded rows. THIS restart is "boot #1" for the migration's
    // purposes; the test then kills and restarts it again (boot #2) mid-run.
    await stopHarper(first, { keepInstallDir: true });
  }, 180_000);

  afterAll(async () => {
    delete process.env.FLAIR_ENABLE_TEST_MIGRATIONS;
    delete process.env.FLAIR_MIGRATION_TEST_BATCH_DELAY_MS;
    delete process.env.FLAIR_EMBEDDING_MODEL;
    if (harper) await stopHarper(harper).catch(() => {});
    await rm(installDir, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
  });

  test("kills mid-migration, restarts against the same data dir, and the migration resumes to completion with every row correctly stamped", async () => {
    harper = await startHarper({ installDir });
    captureBootLog(harper);

    // ── Phase 1: wait for the migration to REACH "running" (generous
    // deadline — the deferred start can take tens of seconds on a slow
    // shared CI runner; see the module doc). With embedding-stamp isolated
    // (pinned model), the synthetic migration is the ONLY candidate, so it
    // starts right after the shared pre-hash. ──
    const runningDeadline = Date.now() + 120_000;
    for (;;) {
      const mig = await findMigration(harper);
      if (mig?.state === "running") break;
      if (mig?.state === "completed") {
        // Too-fast guard: never silently pass without exercising the kill.
        throw new Error(
          `migration completed before it was ever observed running — widen FLAIR_MIGRATION_TEST_BATCH_DELAY_MS (currently ${TEST_BATCH_DELAY_MS}ms) or increase ROW_COUNT\n${await diagnose(harper)}`,
        );
      }
      if (mig?.state === "halted" || mig?.state === "failed") {
        throw new Error(`migration ${mig.state} before running: ${mig.reason}\n${await diagnose(harper)}`);
      }
      if (Date.now() >= runningDeadline) {
        throw new Error(`migration never reached "running" within 120s (last observed: ${JSON.stringify(mig)})\n${await diagnose(harper)}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    // ── Phase 2: catch it mid-flight (rowsDone > 0 AND rowsRemaining > 0).
    // With the widened batch delay each mid-flight window is ~2.5s, so
    // 100ms polls land inside one deterministically, not probabilistically. ──
    const midFlightDeadline = Date.now() + 60_000;
    let killedAt: { rowsDone: number; rowsRemaining: number } | null = null;
    for (;;) {
      const mig = await findMigration(harper);
      if (mig && mig.state === "running" && mig.rowsDone > 0 && mig.rowsRemaining > 0) {
        killedAt = { rowsDone: mig.rowsDone, rowsRemaining: mig.rowsRemaining };
        break;
      }
      if (mig?.state === "completed") {
        throw new Error(
          `migration completed before a mid-flight state was observed — widen FLAIR_MIGRATION_TEST_BATCH_DELAY_MS (currently ${TEST_BATCH_DELAY_MS}ms) or increase ROW_COUNT\n${await diagnose(harper)}`,
        );
      }
      if (mig?.state === "halted" || mig?.state === "failed") {
        throw new Error(`migration ${mig.state} mid-run: ${mig.reason}\n${await diagnose(harper)}`);
      }
      if (Date.now() >= midFlightDeadline) {
        throw new Error(`never observed a mid-flight state within 60s of "running" (last observed: ${JSON.stringify(mig)})\n${await diagnose(harper)}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(killedAt).not.toBeNull();

    // ── The real kill — SIGTERM via stopHarper, keeping the data dir. The
    // widened throttle guarantees ≥2.5s of remaining work at this point, so
    // the process dies genuinely mid-migration. ──
    await stopHarper(harper, { keepInstallDir: true });

    // ── Restart fresh against the SAME (partially-migrated) data. ──
    harper = await startHarper({ installDir });
    captureBootLog(harper);

    const completeDeadline = Date.now() + 120_000;
    let finalMig: any = null;
    for (;;) {
      finalMig = await findMigration(harper);
      if (finalMig?.state === "completed") break;
      if (finalMig?.state === "halted" || finalMig?.state === "failed") {
        throw new Error(`migration ${finalMig.state} after resume: ${finalMig.reason}\n${await diagnose(harper)}`);
      }
      if (Date.now() >= completeDeadline) {
        throw new Error(`migration did not complete within 120s of the resume boot (last observed: ${JSON.stringify(finalMig)})\n${await diagnose(harper)}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(finalMig?.state).toBe("completed");
    expect(finalMig?.rowsRemaining).toBe(0);
    // The resumed cycle only needed to process what was left — proves it
    // picked up from the marker state rather than starting over from zero.
    // (killedAt.rowsRemaining is an upper bound on the resumed work: at
    // most another full batch may have landed between our mid-flight
    // observation and the SIGTERM taking effect, which only SHRINKS what's
    // left for the resume.)
    if (killedAt) {
      expect(finalMig.rowsDone).toBeLessThanOrEqual(killedAt.rowsRemaining);
    }

    // Ground truth: every single row, across both boots, ended up stamped —
    // no row lost, none left behind — AND the migration-isolation invariant
    // held: embeddingModel is still the pinned value on every row, proving
    // embedding-stamp never contended with the migration under test.
    const rows = await opsCall(harper, {
      operation: "search_by_value",
      database: "flair",
      table: "Memory",
      search_attribute: "agentId",
      search_value: RESERVED_TEST_AGENT_ID,
      get_attributes: ["id", "source", "content", "embeddingModel"],
    });
    const list = Array.isArray(rows) ? rows : [rows];
    expect(list).toHaveLength(ROW_COUNT);
    for (const row of list) {
      expect(row.source).toBe(SYNTHETIC_TARGET_MARKER);
      expect(row.embeddingModel).toBe(PINNED_EMBEDDING_STAMP);
    }
  }, 400_000);
});
