/**
 * migrations-resume-after-kill.test.ts — proves crash-resume (invariant IV:
 * "Idempotent, resumable, observable... crash-resume free" /
 * ~/ops/FLAIR-ZERO-TOUCH-UPGRADE.md: "ENOSPC/crash mid-run = clean halt,
 * auto-resume next boot").
 *
 * Seeds rows spanning multiple batches, starts Harper, waits for the
 * migration to genuinely be mid-flight, SIGTERMs the Harper process (real
 * kill, not a simulated stop), restarts a FRESH Harper process against the
 * SAME data directory (harper-lifecycle.ts's documented installDir-reuse
 * pattern, the same mechanism the downgrade-compat tests use), and asserts
 * the new boot resumes and completes — no row lost, none double-processed
 * in a way that corrupts data (per-row marker semantics make a re-touch
 * idempotent by construction).
 *
 * DETERMINISM (fix for a real CI failure, 2026-07-12): the original version
 * used ONE 30s window with fast polls to catch the migration mid-flight.
 * Two structural problems on a slow shared runner: (1) the runner's start
 * is deliberately DEFERRED (tables-ready wait + embeddings-engine settle +
 * the shared async pre-hash all run before the first batch — see
 * resources/migration-boot.ts and runner.ts), so 30s could expire before
 * the migration even reached "running"; (2) at the default 100ms batch
 * throttle the whole running phase for this corpus is a few hundred ms —
 * catchable only probabilistically between HTTP health polls. Fixed by:
 *   - FLAIR_MIGRATION_TEST_BATCH_DELAY_MS (runner.ts's test-only throttle
 *     override, double-gated on FLAIR_ENABLE_TEST_MIGRATIONS — same pattern
 *     as space.ts's FLAIR_MIGRATION_TEST_FREE_BYTES) widening each batch
 *     delay to 2.5s, so the running phase spans SECONDS and the kill lands
 *     mid-flight deterministically;
 *   - splitting the observation into two phases: first wait for
 *     state=running with a generous 120s deadline (covers the deferred
 *     start on slow runners), THEN catch mid-flight (rowsDone>0 &&
 *     rowsRemaining>0) inside the now-widened running window;
 *   - keeping the too-fast guard: if "completed" is ever observed before a
 *     mid-flight state, the test FAILS loudly telling the maintainer to
 *     widen the knob — it never silently passes without exercising the kill.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const RESERVED_TEST_AGENT_ID = "__flair_migration_synthetic_test_agent__";
const SYNTHETIC_TARGET_MARKER = "synthetic-ci-schema-stamp-done";
const SYNTHETIC_MIGRATION_ID = "synthetic-ci-schema-stamp";
const ROW_COUNT = 140; // 3 batches at the schema-additive batch size (50) — two observable mid-flight windows
const TEST_BATCH_DELAY_MS = 2500; // widens each mid-flight window to ~2.5s (vs the 100ms prod default)

let harper: HarperInstance;
let installDir: string;
let authHeader: string;

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

describe("zero-touch migrations — resume after a mid-migration process kill (real Harper)", () => {
  beforeAll(async () => {
    process.env.FLAIR_ENABLE_TEST_MIGRATIONS = "1";
    process.env.FLAIR_MIGRATION_TEST_BATCH_DELAY_MS = String(TEST_BATCH_DELAY_MS);

    const first = await startHarper();
    installDir = first.installDir;
    authHeader = "Basic " + Buffer.from(`${first.admin.username}:${first.admin.password}`).toString("base64");

    const records = Array.from({ length: ROW_COUNT }, (_, i) => ({
      id: `resume-seed-${i}`,
      agentId: RESERVED_TEST_AGENT_ID,
      content: `resume row ${i}`,
      source: "not-yet",
      embedding: [0.1, 0.2, 0.3],
      embeddingModel: "test-stub",
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
    if (harper) await stopHarper(harper).catch(() => {});
    await rm(installDir, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
  });

  test("kills mid-migration, restarts against the same data dir, and the migration resumes to completion with every row correctly stamped", async () => {
    harper = await startHarper({ installDir });

    // ── Phase 1: wait for the migration to REACH "running" (generous
    // deadline — the deferred start can take tens of seconds on a slow
    // shared CI runner; see the module doc). ──
    const runningDeadline = Date.now() + 120_000;
    for (;;) {
      const mig = await findMigration(harper);
      if (mig?.state === "running") break;
      if (mig?.state === "completed") {
        // Too-fast guard: never silently pass without exercising the kill.
        throw new Error(
          `migration completed before it was ever observed running — widen FLAIR_MIGRATION_TEST_BATCH_DELAY_MS (currently ${TEST_BATCH_DELAY_MS}ms) or increase ROW_COUNT`,
        );
      }
      if (mig?.state === "halted" || mig?.state === "failed") {
        throw new Error(`migration ${mig.state} before running: ${mig.reason}`);
      }
      if (Date.now() >= runningDeadline) {
        throw new Error(`migration never reached "running" within 120s (last observed: ${JSON.stringify(mig)})`);
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
          `migration completed before a mid-flight state was observed — widen FLAIR_MIGRATION_TEST_BATCH_DELAY_MS (currently ${TEST_BATCH_DELAY_MS}ms) or increase ROW_COUNT`,
        );
      }
      if (mig?.state === "halted" || mig?.state === "failed") {
        throw new Error(`migration ${mig.state} mid-run: ${mig.reason}`);
      }
      if (Date.now() >= midFlightDeadline) {
        throw new Error(`never observed a mid-flight state within 60s of "running" (last observed: ${JSON.stringify(mig)})`);
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

    const completeDeadline = Date.now() + 120_000;
    let finalMig: any = null;
    while (Date.now() < completeDeadline) {
      finalMig = await findMigration(harper);
      if (finalMig?.state === "completed") break;
      if (finalMig?.state === "halted" || finalMig?.state === "failed") {
        throw new Error(`migration ${finalMig.state} after resume: ${finalMig.reason}`);
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
    // no row lost, none left behind.
    const rows = await opsCall(harper, {
      operation: "search_by_value",
      database: "flair",
      table: "Memory",
      search_attribute: "agentId",
      search_value: RESERVED_TEST_AGENT_ID,
      get_attributes: ["id", "source", "content"],
    });
    const list = Array.isArray(rows) ? rows : [rows];
    expect(list).toHaveLength(ROW_COUNT);
    for (const row of list) {
      expect(row.source).toBe(SYNTHETIC_TARGET_MARKER);
    }
  }, 400_000);
});
