/**
 * migrations-resume-after-kill.test.ts — proves crash-resume (invariant IV:
 * "Idempotent, resumable, observable... crash-resume free" /
 * ~/ops/FLAIR-ZERO-TOUCH-UPGRADE.md: "ENOSPC/crash mid-run = clean halt,
 * auto-resume next boot").
 *
 * Seeds enough rows that the migration genuinely spans multiple 100ms-
 * throttled batches, starts Harper, waits until it has processed SOME but
 * not ALL of them (mid-flight), SIGTERMs the Harper process (real kill, not
 * a simulated stop), restarts a FRESH Harper process against the SAME data
 * directory (mirrors test/helpers/harper-lifecycle.ts's documented
 * installDir-reuse pattern, the same mechanism the downgrade-compat tests
 * use), and asserts the new boot resumes and completes — no row lost, none
 * double-processed in a way that corrupts data (per-row marker semantics
 * make a re-touch idempotent by construction).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const RESERVED_TEST_AGENT_ID = "__flair_migration_synthetic_test_agent__";
const SYNTHETIC_TARGET_MARKER = "synthetic-ci-schema-stamp-done";
const SYNTHETIC_MIGRATION_ID = "synthetic-ci-schema-stamp";
const ROW_COUNT = 140; // > 2 batches at the schema-additive batch size (50) — a real multi-batch, multi-throttle-delay run

let harper: HarperInstance;
let installDir: string;
let authHeader: string;

function opsUrlFor(inst: HarperInstance): string {
  return inst.opsURL;
}

async function opsCall(inst: HarperInstance, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(opsUrlFor(inst), {
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

describe("zero-touch migrations — resume after a mid-migration process kill (real Harper)", () => {
  beforeAll(async () => {
    process.env.FLAIR_ENABLE_TEST_MIGRATIONS = "1";
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
    // Single bulk insert — ops API accepts multiple records per call.
    await opsCall(first, { operation: "insert", database: "flair", table: "Memory", records });

    // Boot-keyed: seeding into an already-booted instance doesn't retrigger
    // its (already-fired) cycle — stop and restart so a FRESH boot discovers
    // the seeded rows. THIS restart is "boot #1" for the migration's
    // purposes; the test then kills and restarts it again (boot #2) mid-run.
    await stopHarper(first, { keepInstallDir: true });
  }, 180_000);

  afterAll(async () => {
    delete process.env.FLAIR_ENABLE_TEST_MIGRATIONS;
    if (harper) await stopHarper(harper).catch(() => {});
    await rm(installDir, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
  });

  test("kills mid-migration, restarts against the same data dir, and the migration resumes to completion with every row correctly stamped", async () => {
    harper = await startHarper({ installDir });

    // Poll rapidly until SOME progress is visible but not yet complete.
    const midFlightDeadline = Date.now() + 30_000;
    let sawMidFlight = false;
    let killedAt: { rowsDone: number; rowsRemaining: number } | null = null;
    while (Date.now() < midFlightDeadline) {
      const detail = await healthDetail(harper);
      const mig = detail?.migrations?.migrations?.find((m: any) => m.id === SYNTHETIC_MIGRATION_ID);
      if (mig && mig.state === "running" && mig.rowsDone > 0 && mig.rowsRemaining > 0) {
        sawMidFlight = true;
        killedAt = { rowsDone: mig.rowsDone, rowsRemaining: mig.rowsRemaining };
        break;
      }
      if (mig?.state === "completed") {
        // Finished before we ever caught it mid-flight — too fast to prove
        // a genuine kill-mid-run this way. Fail loudly rather than
        // silently "passing" a test that never exercised the kill.
        throw new Error("migration completed before a mid-flight state was observed — increase ROW_COUNT or poll faster");
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(sawMidFlight).toBe(true);

    // The real kill — SIGTERM via stopHarper, keeping the data dir.
    await stopHarper(harper, { keepInstallDir: true });

    // Restart fresh against the SAME (partially-migrated) data.
    harper = await startHarper({ installDir });

    const completeDeadline = Date.now() + 60_000;
    let finalMig: any = null;
    while (Date.now() < completeDeadline) {
      const detail = await healthDetail(harper);
      finalMig = detail?.migrations?.migrations?.find((m: any) => m.id === SYNTHETIC_MIGRATION_ID);
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
    if (killedAt) {
      expect(finalMig.rowsDone).toBeLessThanOrEqual(killedAt.rowsRemaining + 5); // small slack for in-flight batch overlap
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
  }, 150_000);
});
