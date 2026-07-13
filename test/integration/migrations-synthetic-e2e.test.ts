/**
 * migrations-synthetic-e2e.test.ts — end-to-end coverage of the zero-touch
 * migration runner against a REAL ephemeral Harper (flair#695). Exercises the
 * FULL boot-keyed path: process boot → resources/migration-boot.ts's
 * setImmediate trigger → shared async pre-hash → the synthetic CI-only
 * migration's own pre-flight ladder → risk-scoped snapshot → throttled
 * batches with per-row markers → completion gate (schema-additive:
 * count+full-envelope) → post-hash → ledger OrgEvent → state-file write →
 * snapshot prune.
 *
 * The synthetic migration only ever registers because
 * FLAIR_ENABLE_TEST_MIGRATIONS=1 is set BEFORE startHarper() spawns the
 * child process (harper-lifecycle.ts's baseEnv spreads the parent process's
 * env, so this propagates through) — proving the same opt-in gate
 * test/unit/migrations-synthetic.test.ts checks in isolation actually wires
 * up correctly end-to-end.
 *
 * Seeded rows carry a STUB embedding/embeddingModel up front so
 * Memory.put()'s regen branch never fires when the migration's own writes
 * touch them (`{...existing, source: MARKER}` — embedding already present)
 * — keeps this test fast and deterministic, independent of the local
 * embeddings model. (The embeddings REGEN path itself is covered by
 * test/integration/migrations-embedding-stamp-e2e.test.ts.)
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const RESERVED_TEST_AGENT_ID = "__flair_migration_synthetic_test_agent__";
const SYNTHETIC_TARGET_MARKER = "synthetic-ci-schema-stamp-done";
const SYNTHETIC_MIGRATION_ID = "synthetic-ci-schema-stamp";

const SEED_IDS = Array.from({ length: 8 }, (_, i) => `synthetic-seed-${i}`);

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

async function fetchMemoryRow(id: string): Promise<any> {
  const rows = await opsCall({
    operation: "search_by_value",
    database: "flair",
    table: "Memory",
    search_attribute: "id",
    search_value: id,
    get_attributes: ["*"],
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

describe("zero-touch migrations — synthetic CI variant end-to-end (real Harper)", () => {
  // Boot-keyed means exactly that: the runner checks for pending work ONCE
  // per boot (resources/migration-boot.ts fires a single cycle via
  // setImmediate, never a continuous watcher). Seeding rows into an
  // ALREADY-booted instance and expecting that SAME already-fired cycle to
  // notice them would be testing a live-watch behavior this design
  // deliberately doesn't have. So: boot once just to get ops-API access,
  // seed the rows, then STOP and RESTART Harper against the same data dir
  // — the second boot's cycle is the one that discovers and processes the
  // seeded rows, which is also exactly the real-world shape (write data,
  // then a later restart/upgrade is what runs the migration).
  beforeAll(async () => {
    process.env.FLAIR_ENABLE_TEST_MIGRATIONS = "1";
    const first = await startHarper();
    authHeader = "Basic " + Buffer.from(`${first.admin.username}:${first.admin.password}`).toString("base64");
    harper = first;

    for (const id of SEED_IDS) {
      await opsCall({
        operation: "insert",
        database: "flair",
        table: "Memory",
        records: [
          {
            id,
            agentId: RESERVED_TEST_AGENT_ID,
            content: `synthetic row ${id}`,
            source: "not-yet",
            embedding: [0.1, 0.2, 0.3],
            embeddingModel: "test-stub", // present — skips Memory.put()'s regen branch when the migration touches this row
            createdAt: new Date().toISOString(),
          },
        ],
      });
    }

    await stopHarper(first, { keepInstallDir: true });
    harper = await startHarper({ installDir: first.installDir });
  }, 180_000);

  afterAll(async () => {
    delete process.env.FLAIR_ENABLE_TEST_MIGRATIONS;
    if (harper) {
      const { rm } = await import("node:fs/promises");
      const installDir = harper.installDir;
      await stopHarper(harper); // ownsInstallDir is false for the reused-dir boot — won't remove it
      await rm(installDir, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
    }
  });

  test("the synthetic migration runs to completion: health reports completed, every seeded row stamped", async () => {
    const deadline = Date.now() + 60_000;
    let lastMig: any = null;
    while (Date.now() < deadline) {
      const detail = await healthDetail();
      lastMig = detail?.migrations?.migrations?.find((m: any) => m.id === SYNTHETIC_MIGRATION_ID);
      if (lastMig?.state === "completed") break;
      if (lastMig?.state === "halted" || lastMig?.state === "failed") {
        throw new Error(`migration ${lastMig.state}: ${lastMig.reason}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    expect(lastMig).toBeTruthy();
    expect(lastMig.state).toBe("completed");
    expect(lastMig.rowsRemaining).toBe(0);
    expect(lastMig.rowsDone).toBeGreaterThanOrEqual(SEED_IDS.length);

    for (const id of SEED_IDS) {
      const row = await fetchMemoryRow(id);
      expect(row.source).toBe(SYNTHETIC_TARGET_MARKER);
      expect(row.content).toBe(`synthetic row ${id}`); // untouched — proves the migration only stamped `source`
    }
  }, 90_000);

  test("a ledger OrgEvent was written for the migration and is structurally clean (no memory ids/content)", async () => {
    const rows = await opsCall({
      operation: "search_by_value",
      database: "flair",
      table: "OrgEvent",
      search_attribute: "refId",
      search_value: SYNTHETIC_MIGRATION_ID,
      get_attributes: ["*"],
    });
    const list = Array.isArray(rows) ? rows : [rows];
    expect(list.length).toBeGreaterThan(0);

    const evt = list[list.length - 1];
    expect(evt.kind).toBe("migration");
    expect(evt.authorId).toBe("flair-migrations");
    expect(typeof evt.summary).toBe("string");

    const detail = JSON.parse(evt.detail);
    expect(detail.migrationId).toBe(SYNTHETIC_MIGRATION_ID);
    expect(detail.outcome).toBe("success");
    expect(detail.scope).toBe("full");
    expect(typeof detail.hashEnvelopeMatch).toBe("boolean"); // schema-additive gate — full envelope IS checked
    expect(Object.keys(detail).sort()).toEqual(
      ["migrationId", "initiator", "fromVersion", "toVersion", "scope", "startedAt", "endedAt", "outcome", "rowsProcessed", "rowsRemaining", "hashEnvelopeMatch"].sort(),
    );

    // Never a seeded memory id or its content string anywhere in the ledger.
    const raw = JSON.stringify(evt);
    for (const id of SEED_IDS) expect(raw).not.toContain(id);
    expect(raw).not.toContain("synthetic row");
  });

  test("a risk-scoped (schema+metadata) snapshot was created at 0700 under <dataDir>/.migrations/snapshots/, then pruned to the retention policy", async () => {
    // harper-lifecycle.ts sets HOME=installDir for the spawned process, and
    // resources/migration-boot.ts's dataDir resolution is `HDB_ROOT ??
    // homedir()/.flair/data` (same convention resources/health.ts already
    // uses) — with HDB_ROOT unset here (as in every real deployment too;
    // grep confirms src/cli.ts never sets it), that's <installDir>/.flair/data.
    const snapshotRoot = join(harper.installDir, ".flair", "data", ".migrations", "snapshots");
    expect(existsSync(snapshotRoot)).toBe(true);

    const entries = readdirSync(snapshotRoot).filter((e) => e.startsWith(SYNTHETIC_MIGRATION_ID));
    // Retention (keep-last-3 / 30-day) auto-prunes on success — with exactly
    // one successful cycle here, the one snapshot this run created should
    // still exist (it's both the most recent AND well under 30 days old).
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const dir = join(snapshotRoot, entries[0]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    const manifestPath = join(dir, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(await Bun.file(manifestPath).text());
    expect(manifest.scope).toBe("schema+metadata");
    expect(manifest.migrationId).toBe(SYNTHETIC_MIGRATION_ID);

    // schema+metadata scope: a schema.json sits alongside the manifest —
    // never a data dump of the seeded rows' content.
    const schemaPath = join(dir, "schema.json");
    if (existsSync(schemaPath)) {
      const schemaText = await Bun.file(schemaPath).text();
      expect(schemaText).not.toContain("synthetic row");
    }
  });

  test("the on-disk migration state file records success at the running version (the detect() short-circuit marker)", async () => {
    const statePath = join(harper.installDir, ".flair", "data", ".migrations", "state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(await Bun.file(statePath).text());
    expect(state[SYNTHETIC_MIGRATION_ID].lastOutcome).toBe("success");
    expect(typeof state[SYNTHETIC_MIGRATION_ID].completedAtVersion).toBe("string");
  });
});
