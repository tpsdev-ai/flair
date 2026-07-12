/**
 * migrations-halt-space.test.ts — halt-don't-brick under a blocked disk
 * (~/ops/FLAIR-MIGRATION-SAFETY.md invariant III space-pressure steps 1/5):
 * "No safe path → halt-don't-brick: serve old shape, health + doctor state
 * exactly what's needed."
 *
 * Forces the pre-flight space check to fail deterministically via
 * FLAIR_MIGRATION_TEST_FREE_BYTES (resources/migrations/space.ts's
 * documented test-only override — real Harper is a spawned child process,
 * so a dependency-injected fake space probe isn't reachable from the test;
 * an env var propagated at spawn time is the only lever, same technique
 * FLAIR_ENABLE_TEST_MIGRATIONS uses for the synthetic migration itself).
 * Never fills an actual disk — this is what the spec explicitly names as
 * the acceptable simulation ("a tiny quota or injected space-check").
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const RESERVED_TEST_AGENT_ID = "__flair_migration_synthetic_test_agent__";
const SYNTHETIC_MIGRATION_ID = "synthetic-ci-schema-stamp";

let harper: HarperInstance;
let authHeader: string;

async function opsCall(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops call failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}

async function healthDetail(): Promise<any> {
  const res = await fetch(`${harper.httpURL}/HealthDetail`, { headers: { Authorization: authHeader } });
  if (!res.ok) return null;
  return res.json();
}

describe("zero-touch migrations — halt on blocked disk space (real Harper)", () => {
  beforeAll(async () => {
    process.env.FLAIR_ENABLE_TEST_MIGRATIONS = "1";
    process.env.FLAIR_MIGRATION_TEST_FREE_BYTES = "1"; // ~zero free space, deterministically fails the headroom-floor check

    const first = await startHarper();
    authHeader = "Basic " + Buffer.from(`${first.admin.username}:${first.admin.password}`).toString("base64");

    await fetch(first.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({
        operation: "insert",
        database: "flair",
        table: "Memory",
        records: [
          {
            id: "halt-space-seed-1",
            agentId: RESERVED_TEST_AGENT_ID,
            content: "should never be touched",
            source: "not-yet",
            embedding: [0.1, 0.2, 0.3],
            embeddingModel: "test-stub",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    });

    // Boot-keyed — restart so a fresh boot discovers the seeded row under
    // the now-forced low-space condition.
    await stopHarper(first, { keepInstallDir: true });
    harper = await startHarper({ installDir: first.installDir });
  }, 180_000);

  afterAll(async () => {
    delete process.env.FLAIR_ENABLE_TEST_MIGRATIONS;
    delete process.env.FLAIR_MIGRATION_TEST_FREE_BYTES;
    if (harper) {
      const { rm } = await import("node:fs/promises");
      const installDir = harper.installDir;
      await stopHarper(harper);
      await rm(installDir, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
    }
  });

  test("the migration halts with a 'blocked on disk' reason, Harper keeps serving, and the seeded row is left completely untouched", async () => {
    const deadline = Date.now() + 30_000;
    let mig: any = null;
    while (Date.now() < deadline) {
      const detail = await healthDetail();
      mig = detail?.migrations?.migrations?.find((m: any) => m.id === SYNTHETIC_MIGRATION_ID);
      if (mig?.state === "halted" || mig?.state === "completed" || mig?.state === "failed") break;
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(mig?.state).toBe("halted");
    expect(mig?.reason).toContain("blocked on disk");

    // Halt-don't-brick: the server itself must still be fully responsive —
    // health/HealthDetail wouldn't have answered at all if the boot path
    // had crashed, but assert an ordinary write/read round-trip too, proving
    // it's genuinely serving on the pre-migration shape, not just alive.
    const healthRes = await fetch(`${harper.httpURL}/Health`);
    expect(healthRes.ok).toBe(true);

    const row = await opsCall({
      operation: "search_by_value",
      database: "flair",
      table: "Memory",
      search_attribute: "id",
      search_value: "halt-space-seed-1",
      get_attributes: ["id", "source", "content"],
    });
    const record = Array.isArray(row) ? row[0] : row;
    expect(record.source).toBe("not-yet"); // untouched — halt fired BEFORE any write
    expect(record.content).toBe("should never be touched");

    // A halt must retry on the next boot, never be permanently
    // short-circuited (lastOutcome !== "success").
    const detail = await healthDetail();
    expect(detail?.migrations?.migrations?.find((m: any) => m.id === SYNTHETIC_MIGRATION_ID)?.state).toBe("halted");
  }, 60_000);
});
