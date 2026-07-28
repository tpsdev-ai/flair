/**
 * migrations-provisioned-datadir.test.ts — flair#812 regression, at the only
 * level that can actually catch it: a REAL Harper boot on a shape where the
 * historical migration data dir is unusable.
 *
 * ─── What broke, and why unit tests could not see it ──────────────────────
 * `resources/migration-boot.ts` resolved its data dir as
 * `process.env.HDB_ROOT ?? join(homedir(), ".flair", "data")`. `HDB_ROOT` is
 * set by nothing — not Harper (whose own root-path env var is `ROOTPATH`),
 * not flair's spawner — so that was unconditionally `~/.flair/data`. On a
 * default local install that is also the instance's real data dir, so
 * everything worked. On a PROVISIONED install (service-managed spoke,
 * container, Fabric component) `homedir()` belongs to whatever account the
 * process runs as and may not be writable at all.
 *
 * When it wasn't, the failure was TOTALLY SILENT: `runMigrationCycle`'s
 * first act is `acquireMigrationLock`, whose `mkdirSync` threw, the runner
 * caught it and RETURNED `{ ran: false, reason: "lock error: …" }`, and the
 * boot path discarded that value. No log line, no state file, no health
 * signal — and every migration, shipped and future, skipped forever on that
 * instance. `resources/embeddings-boot.ts`, loaded by the same `jsResource`
 * glob, kept working throughout, because it writes no path of its own.
 *
 * ─── How this test reproduces it ─────────────────────────────────────────
 * Boot once (normal, writable HOME), seed rows that need the migration, stop,
 * then REPLACE `<HOME>/.flair` WITH A REGULAR FILE and boot again. That makes
 * `<HOME>/.flair/data/.migrations` uncreatable with `ENOTDIR` — for any user,
 * including root, so this behaves identically on a developer laptop and in a
 * containerised CI lane. Harper itself is untouched (it uses `~/.harperdb`
 * and `ROOTPATH`, never `~/.flair`), so this isolates flair's own resolution.
 *
 * Pre-fix this boot runs no migration at all and writes no state anywhere.
 * Post-fix the resolver falls through to `ROOTPATH` — Harper's real root,
 * writable by definition on a running instance — and the migration completes.
 *
 * Boot-keyed means once per boot, so the rows are seeded on boot 1 and
 * migrated by boot 2's cycle — the same restart-is-what-migrates shape as
 * migrations-synthetic-e2e.test.ts, and the same shape as a real upgrade.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const RESERVED_TEST_AGENT_ID = "__flair_migration_datadir_test_agent__";
const SEED_IDS = Array.from({ length: 4 }, (_, i) => `datadir-seed-${i}`);
// Matches resources/embeddings-provider.ts's getModelId() with the prefix
// gate on, so embedding-stamp sees nothing pending and this test stays
// independent of the local embeddings model.
const CURRENT_MODEL_ID = "nomic-embed-text-v1.5-Q4_K_M+searchprefix";

let harper: HarperInstance;
let authHeader: string;
let blockedFlairDir: string;

async function opsCall(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops call failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}

async function seededRows(): Promise<any[]> {
  const rows = await opsCall({
    operation: "search_by_value",
    database: "flair",
    table: "Memory",
    search_attribute: "agentId",
    search_value: RESERVED_TEST_AGENT_ID,
    get_attributes: ["id", "visibility"],
  });
  return Array.isArray(rows) ? rows : [];
}

describe("zero-touch migrations — provisioned shape whose ~/.flair/data is unusable (flair#812)", () => {
  beforeAll(async () => {
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
            content: `datadir row ${id}`,
            // `permanent` durability derives visibility `shared` (flair#509's
            // rule, mirrored in resources/migrations/visibility-backfill.ts).
            durability: "permanent",
            embedding: [0.1, 0.2, 0.3],
            embeddingModel: CURRENT_MODEL_ID, // already current — embedding-stamp has nothing to do
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    }

    // Every seeded row must start with NO visibility, or this test proves
    // nothing about the backfill.
    const before = await seededRows();
    expect(before).toHaveLength(SEED_IDS.length);
    for (const row of before) expect(row.visibility == null).toBe(true);

    await stopHarper(first, { keepInstallDir: true });

    // ── Make the historical data dir unusable, exactly as a provisioned
    // shape does. A regular file at <HOME>/.flair makes mkdir -p of
    // <HOME>/.flair/data/.migrations fail with ENOTDIR for every user,
    // root included — no chmod games, no root-vs-non-root divergence.
    blockedFlairDir = join(first.installDir, ".flair");
    rmSync(blockedFlairDir, { recursive: true, force: true });
    writeFileSync(blockedFlairDir, "flair#812: this path is deliberately not a directory\n");

    harper = await startHarper({ installDir: first.installDir });
  }, 240_000);

  afterAll(async () => {
    if (harper) {
      const installDir = harper.installDir;
      await stopHarper(harper);
      const { rm } = await import("node:fs/promises");
      await rm(installDir, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
    }
  });

  test("the blocker really is in place — <HOME>/.flair is a file, so the pre-fix data dir is uncreatable", () => {
    expect(existsSync(blockedFlairDir)).toBe(true);
    expect(lstatSync(blockedFlairDir).isFile()).toBe(true);
  });

  test("the boot cycle still runs: migration state is written under ROOTPATH", async () => {
    const statePath = join(harper.installDir, ".migrations", "state.json");
    const deadline = Date.now() + 60_000;
    // Poll for the POSTCONDITION, not a proxy for it. The runner creates
    // state.json before writing into it, so `existsSync` can be true while the
    // file is still empty or a partial object — JSON.parse then throws and the
    // test fails intermittently on a migration that actually succeeded
    // (flair#890). Waiting until it parses AND carries the entry removes the
    // race without weakening the assertions below.
    let state: Record<string, any> | null = null;
    while (Date.now() < deadline) {
      if (existsSync(statePath)) {
        try {
          const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
          if (parsed?.["visibility-backfill"]) {
            state = parsed;
            break;
          }
        } catch {
          // partially-written file — keep waiting rather than failing
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (state === null) {
      throw new Error(
        `no parseable .migrations/state.json carrying a visibility-backfill entry at ${statePath} within 60s`,
      );
    }
    expect(state["visibility-backfill"]?.lastOutcome).toBe("success");
    expect(state["visibility-backfill"]?.rowsProcessed).toBe(SEED_IDS.length);
  }, 90_000);

  test("the migration actually applied — every seeded row now carries an explicit visibility", async () => {
    const deadline = Date.now() + 60_000;
    let rows: any[] = [];
    while (Date.now() < deadline) {
      rows = await seededRows();
      if (rows.length === SEED_IDS.length && rows.every((r) => r.visibility != null)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    expect(rows).toHaveLength(SEED_IDS.length);
    for (const row of rows) expect(row.visibility).toBe("shared");
  }, 90_000);

  test("/HealthDetail proves the cycle ran rather than merely reporting nothing wrong", async () => {
    const res = await fetch(`${harper.httpURL}/HealthDetail`, { headers: { Authorization: authHeader } });
    expect(res.ok).toBe(true);
    const detail: any = await res.json();

    // `idle` would mean the boot trigger never fired at all — the reading
    // that, pre-fix, was indistinguishable from a healthy no-op cycle.
    expect(detail.migrations).toBeTruthy();
    expect(detail.migrations.cyclePhase).not.toBe("idle");
    expect(detail.migrations.lastCycleError ?? null).toBeNull();

    const backfill = detail.migrations.migrations.find((m: any) => m.id === "visibility-backfill");
    expect(backfill?.state).toBe("completed");
  });
});
