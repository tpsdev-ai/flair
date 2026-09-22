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
 * Boot 1 seeds rows, is stopped, then `<HOME>/.flair` is REPLACED WITH A
 * REGULAR FILE and boot 2 runs against the retained store. That makes
 * `<HOME>/.flair/data/.migrations` uncreatable with `ENOTDIR` — for any user,
 * including root, so this behaves identically on a developer laptop and in a
 * containerised CI lane. Harper itself is untouched (it uses `~/.harperdb`
 * and `ROOTPATH`, never `~/.flair`), so this isolates flair's own resolution.
 * Pre-fix boot 2 runs no migration and writes no state anywhere; post-fix the
 * resolver falls through to `ROOTPATH` and the migration completes.
 *
 * ─── flair#1785 slice 2: the seed-only invariant, by composition ──────────
 * Boot 1's premise is "the seeded rows are the ONLY thing that has happened".
 * The null-check precedes shutdown, so it cannot establish that boot 1's OWN
 * migration cycle did not run against the seed — and scheduling is
 * unconditional and arms follow-ups (`resources/migration-boot.ts` →
 * `resources/migrations/recheck.ts`), so no timing stopwatch can either.
 *
 * Boot 1 therefore runs from a PRIVATE COMPONENT COPY whose `jsResource` glob
 * omits `dist/resources/migration-boot.js`
 * (`test/helpers/component-without-migration-boot.ts`): the trigger module
 * never loads, so no cycle is ever scheduled, initial or follow-up. Schemas
 * and every other resource are kept. Boot 2 is the ordinary, unmodified
 * component against the retained store. This is fixture-only composition —
 * nothing under src/ or resources/ changes and production gains no capability
 * (see the bypass fixture below). Guard B (slice 1) stays in front of the
 * `.flair` removal.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startHarper,
  stopHarper,
  awaitMigrationStateFile,
  componentInstallFailureMessage,
  bootLogRefs,
  dumpBootLogs,
  throwIfComponentInstallFailed,
  type HarperInstance,
} from "../helpers/harper-lifecycle";
import { assertSeedOnlyPrecondition } from "../helpers/migration-precondition";
import {
  componentWithoutMigrationBoot,
  OMITTED_TRIGGER_REL,
  type ComposedComponent,
} from "../helpers/component-without-migration-boot";
// The FIRST follow-up recheck delay, imported (not a literal) so the held-alive
// fixture tracks the schedule it is proving boot 1 cannot reach.
import { DEFAULT_STAMP_RECHECK_DELAYS_MS } from "../../resources/migrations/recheck";

const RESERVED_TEST_AGENT_ID = "__flair_migration_datadir_test_agent__";
const SEED_IDS = Array.from({ length: 4 }, (_, i) => `datadir-seed-${i}`);
// The legacy BARE-name stamp (pre embedding-space-guard slice 1). getModelId()
// now returns the ENGINE-QUALIFIED `gguf:<base>+searchprefix`, but a bare stamp
// denotes the SAME space, so embedding-stamp's staleCondition (via
// currentSpaceRawForms) treats a bare row as current and sees nothing pending —
// this seed doubles as the real-Harper proof that today's bare-name corpus is
// NOT re-embedded. Keeps the test independent of the local embeddings model.
const CURRENT_MODEL_ID = "nomic-embed-text-v1.5-Q4_K_M+searchprefix";
const BACKFILL_ENTRY = "visibility-backfill";

let harper: HarperInstance;
// flair#1785 (C): boot 1's instance is kept so BOTH boots' captured Harper logs
// are available to dump on failure, not only boot 2's (the `harper` slot is
// overwritten by boot 2).
let firstHarper: HarperInstance | undefined;
// flair#1785 review B2: boot 2 in its OWN variable, undefined until the second
// startHarper returns.
let secondHarper: HarperInstance | undefined;
let authHeader: string;
let blockedFlairDir: string;
// flair#1785 (B): ms from the seed to boot 1's stop, carried into the guard's
// failure text so the window boot 1 actually had is part of the report.
let seedToStopMs: number | undefined;
// flair#1785 slice 2: the composed boot-1 component copy (cleaned up once boot 1
// is gone; kept as a module var so afterAll can clean it up on any failure path).
let composed: ComposedComponent | undefined;
// Boot 1's /HealthDetail reading, captured before shutdown, proving the composed
// resource set never scheduled a cycle.
let firstCyclePhase: string | undefined;
let firstRegisteredMigrations: number | undefined;

function basicAuth(inst: HarperInstance): string {
  return "Basic " + Buffer.from(`${inst.admin.username}:${inst.admin.password}`).toString("base64");
}

async function opsOn(inst: HarperInstance, auth: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(inst.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops call failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}

async function rowsOn(inst: HarperInstance, auth: string): Promise<any[]> {
  const rows = await opsOn(inst, auth, {
    operation: "search_by_value",
    database: "flair",
    table: "Memory",
    search_attribute: "agentId",
    search_value: RESERVED_TEST_AGENT_ID,
    get_attributes: ["id", "visibility"],
  });
  return Array.isArray(rows) ? rows : [];
}

async function seedOn(inst: HarperInstance, auth: string): Promise<void> {
  for (const id of SEED_IDS) {
    await opsOn(inst, auth, {
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
}

async function detailOn(inst: HarperInstance, auth: string): Promise<any> {
  const res = await fetch(`${inst.httpURL}/HealthDetail`, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`HealthDetail failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * The provisioned shape (flair#812): a REGULAR FILE at `<installDir>/.flair`, so
 * `mkdir -p <HOME>/.flair/data/.migrations` fails with ENOTDIR for every user
 * (root included) and the resolver must fall through to ROOTPATH.
 */
function blockHomeFlairDir(installDir: string): string {
  const blocked = join(installDir, ".flair");
  rmSync(blocked, { recursive: true, force: true });
  writeFileSync(blocked, "flair#812: this path is deliberately not a directory\n");
  return blocked;
}

/**
 * flair#1785 slice 2 — external-service mode (HARPER_HTTP_URL / docker) bypasses
 * LOCAL component selection, so boot 1 could not be run from the composed
 * resource set. Refuse BY NAME rather than silently testing the wrong thing.
 */
function requireLocalComponentSelection(where: string): void {
  if (process.env.HARPER_HTTP_URL) {
    throw new Error(
      `flair#1785 slice 2 (${where}): external-service mode is NOT valid for this fixture — ` +
        `HARPER_HTTP_URL is set, which bypasses local component selection, so boot 1 cannot run the ` +
        `composed resource set. Unset HARPER_HTTP_URL and rerun.`,
    );
  }
}

/** Every `state.json` under `root` whose parsed object carries a backfill entry. */
function findBackfillStateFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    const entries = (() => {
      try {
        return readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
    })();
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name === "state.json") {
        try {
          const parsed = JSON.parse(readFileSync(p, "utf-8"));
          if (parsed && typeof parsed === "object" && parsed[BACKFILL_ENTRY]) found.push(p);
        } catch {
          /* unreadable/partial — not a backfill record */
        }
      }
    }
  };
  if (existsSync(root)) walk(root);
  return found;
}

/** The basename of the composed-boot fixture — the string product code must NOT contain. */
const COMPOSED_FIXTURE_MODULE = "component-without-migration-boot";

/** Source files under `roots` that mention `needle` (skips node_modules/dist/dotdirs). */
function sourceFilesReferencing(needle: string, roots: string[]): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    const entries = (() => {
      try {
        return readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
    })();
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(e.name)) {
        try {
          if (readFileSync(p, "utf-8").includes(needle)) hits.push(p);
        } catch {
          /* unreadable — not a reference we can act on */
        }
      }
    }
  };
  for (const r of roots) walk(r);
  return hits;
}

/** The `*.js` files a jsResource `dist/resources` glob would match. */
function globJsResources(componentRoot: string): string[] {
  try {
    return readdirSync(join(componentRoot, "dist", "resources")).filter((n) => n.endsWith(".js"));
  } catch {
    return [];
  }
}

function repoRoot(): string {
  return join(import.meta.dir, "..", "..");
}

/**
 * flair#1785 (C): dump the boots' captured Harper stdout/stderr (bounded, each
 * prefixed with its ROOTPATH/port). Called only from a failing path.
 *
 * flair#1785 review B2: the boot-2 entry is included ONLY once boot 2 actually
 * exists — a beforeAll failure (the guard, the rmSync, or boot 2's own start)
 * happens while `harper` is still boot 1, and must dump boot 1 ONCE, not a
 * second block labelled "boot 2" carrying boot 1's ROOTPATH/port.
 */
function dumpBothBoots(): void {
  dumpBootLogs(bootLogRefs(firstHarper, secondHarper), { maxLines: 300 });
}

/**
 * flair#1785 (C): run a test body; on ANY failure — a failed assertion, or a
 * waiter timeout — dump both boots' captured logs, then rethrow. Nothing is
 * printed when the body passes, and there is no global afterEach.
 */
async function withBootLogs<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    dumpBothBoots();
    throw err;
  }
}

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
    // flair#1785 (C): a setup failure must still carry both boots' captured
    // logs — beforeAll is the one failing path the per-test wrapper cannot reach.
    try {
      requireLocalComponentSelection("provisioned-datadir fixture");

      // flair#1785 slice 2: boot 1 runs the composed resource set (no trigger).
      composed = componentWithoutMigrationBoot();
      const first = await startHarper({ cwd: composed.dir, harperBinDir: composed.sourceRoot });
      firstHarper = first;
      authHeader = basicAuth(first);
      harper = first;

      // Capture boot 1's cycle reading BEFORE seeding: the composed resource set
      // must never have scheduled a cycle. `cyclePhase: idle` + no registered
      // migrations is the trigger-absent signature (`seedIdleProgress` is only
      // called by the trigger module).
      const firstDetail = await detailOn(first, authHeader);
      firstCyclePhase = firstDetail.migrations?.cyclePhase;
      firstRegisteredMigrations = firstDetail.migrations?.migrations?.length;

      const seedStart = Date.now();
      await seedOn(first, authHeader);

      // Every seeded row must start with NO visibility, or this test proves
      // nothing about the backfill.
      const before = await seededRows();
      expect(before).toHaveLength(SEED_IDS.length);
      for (const row of before) expect(row.visibility == null).toBe(true);

      await stopHarper(first, { keepInstallDir: true });
      seedToStopMs = Date.now() - seedStart;
      // boot 1 is gone — the composed copy has done its job. (afterAll cleans it
      // up again on any earlier failure path; cleanup is idempotent.)
      composed.cleanup();

      // ── flair#1785 (B): assert the seed-only precondition NOW — after boot 1
      // has fully stopped and BEFORE its data dir is removed. Guard B is kept
      // in front of the removal: the composition makes it a fact, not a hope.
      assertSeedOnlyPrecondition({
        statePath: join(first.installDir, ".flair", "data", ".migrations", "state.json"),
        seedToStopMs,
      });

      // ── Make the historical data dir unusable, exactly as a provisioned
      // shape does. A regular file at <HOME>/.flair makes mkdir -p of
      // <HOME>/.flair/data/.migrations fail with ENOTDIR for every user,
      // root included — no chmod games, no root-vs-non-root divergence.
      blockedFlairDir = join(first.installDir, ".flair");
      rmSync(blockedFlairDir, { recursive: true, force: true });
      writeFileSync(blockedFlairDir, "flair#812: this path is deliberately not a directory\n");

      // Boot 2: the ordinary, unmodified component against the retained store.
      harper = await startHarper({ installDir: first.installDir });
      secondHarper = harper;
    } catch (err) {
      // flair#1785 (C): setup failure → dump both boots' captured logs.
      dumpBothBoots();
      throw err;
    }
  }, 240_000);

  afterAll(async () => {
    composed?.cleanup();
    if (harper) {
      const installDir = harper.installDir;
      await stopHarper(harper);
      const { rm } = await import("node:fs/promises");
      await rm(installDir, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
    }
  });

  test("boot 1 ran the composed resource set — the boot-cycle trigger never loaded (flair#1785 slice 2)", () =>
    withBootLogs(() => {
      // `scheduled`/`done` would mean the trigger module loaded and ran; `idle`
      // with no registered migrations is the trigger-absent signature.
      expect(firstCyclePhase).toBe("idle");
      expect(firstRegisteredMigrations).toBe(0);
    }));

  test("the blocker really is in place — <HOME>/.flair is a file, so the pre-fix data dir is uncreatable", () =>
    withBootLogs(() => {
      expect(existsSync(blockedFlairDir)).toBe(true);
      expect(lstatSync(blockedFlairDir).isFile()).toBe(true);
    }));

  test("the boot cycle still runs: migration state is written under ROOTPATH", () => withBootLogs(async () => {
    const statePath = join(harper.installDir, ".migrations", "state.json");
    // Wait for the POSTCONDITION, not a proxy for it. The runner creates
    // state.json before writing into it, so `existsSync` can be true while the
    // file is still empty or a partial object — JSON.parse then throws and the
    // test fails intermittently on a migration that actually succeeded
    // (flair#890). `awaitMigrationStateFile` waits until it parses AND carries
    // the entry, removing the race without weakening the assertions below.
    //
    // flair#1785: it ALSO watches Harper's log. A failed component install
    // means the component never loaded and the cycle never ran — that install
    // failure is the REPORTED failure, named, in seconds, rather than a 60 s
    // "no parseable state.json" timeout that names the wrong thing.
    const state = await awaitMigrationStateFile({
      statePath,
      entry: BACKFILL_ENTRY,
      getLog: () => harper.getLog?.() ?? "",
    });
    expect(state[BACKFILL_ENTRY]?.lastOutcome).toBe("success");
    expect(state[BACKFILL_ENTRY]?.rowsProcessed).toBe(SEED_IDS.length);
  }), 90_000);

  test("the migration actually applied — every seeded row now carries an explicit visibility", () => withBootLogs(async () => {
    const deadline = Date.now() + 60_000;
    let rows: any[] = [];
    while (Date.now() < deadline) {
      // flair#1785: surface a failed component install as the failure, not as
      // rows that mysteriously never gain a visibility.
      const installFailure = componentInstallFailureMessage(harper.getLog?.() ?? "");
      if (installFailure) throw new Error(installFailure);
      rows = await seededRows();
      if (rows.length === SEED_IDS.length && rows.every((r) => r.visibility != null)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    // flair#1785 addendum (same shape as the final rescan the helper's
    // `awaitMigrationStateFile` carries): this loop reads Harper's log only at
    // the START of each iteration, so an install-failure line written during the
    // FINAL sleep is never read. Re-scan once more, before the generic assertion
    // path, so a late-arriving deploy failure is the REPORTED failure rather
    // than rows that mysteriously never gained a visibility.
    throwIfComponentInstallFailed(harper.getLog?.() ?? "");

    expect(rows).toHaveLength(SEED_IDS.length);
    for (const row of rows) expect(row.visibility).toBe("shared");
  }), 90_000);

  test("/HealthDetail proves the cycle ran rather than merely reporting nothing wrong", () => withBootLogs(async () => {
    const res = await fetch(`${harper.httpURL}/HealthDetail`, { headers: { Authorization: authHeader } });
    expect(res.ok).toBe(true);
    const detail: any = await res.json();

    // `idle` would mean the boot trigger never fired at all — the reading
    // that, pre-fix, was indistinguishable from a healthy no-op cycle.
    expect(detail.migrations).toBeTruthy();
    expect(detail.migrations.cyclePhase).not.toBe("idle");
    expect(detail.migrations.lastCycleError ?? null).toBeNull();

    const backfill = detail.migrations.migrations.find((m: any) => m.id === BACKFILL_ENTRY);
    expect(backfill?.state).toBe("completed");
  }));
});

describe("flair#1785 slice 2 — the seed-only precondition holds while boot 1 is held alive past the follow-up schedule", () => {
  test("a composed boot 1 held PAST the first follow-up delay never stamps the seed or writes backfill state; the ordinary boot then migrates", async () => {
    requireLocalComponentSelection("seed-only held-alive fixture");
    const copy = componentWithoutMigrationBoot();
    let first: HarperInstance | undefined;
    let second: HarperInstance | undefined;
    let installDir: string | undefined;
    try {
      first = await startHarper({ cwd: copy.dir, harperBinDir: copy.sourceRoot });
      installDir = first.installDir;
      const auth1 = basicAuth(first);

      await seedOn(first, auth1);
      const before = await rowsOn(first, auth1);
      expect(before).toHaveLength(SEED_IDS.length);
      for (const row of before) expect(row.visibility == null).toBe(true);

      // Hold boot 1 PAST the first follow-up delay — imported from recheck.ts,
      // never a literal — so any cycle the trigger could have scheduled would
      // have fired. (A margin above the delay, since it is armed relative to
      // cycle completion and this boot has no cycle at all.)
      const holdMs = DEFAULT_STAMP_RECHECK_DELAYS_MS[0] + 8_000;
      await new Promise((r) => setTimeout(r, holdMs));

      // The seed is still untouched, and NO backfill state exists anywhere under
      // the install dir (neither the HOME candidate nor ROOTPATH).
      const after = await rowsOn(first, auth1);
      expect(after).toHaveLength(SEED_IDS.length);
      for (const row of after) expect(row.visibility == null).toBe(true);
      expect(findBackfillStateFiles(installDir)).toEqual([]);

      await stopHarper(first, { keepInstallDir: true });
      first = undefined;
      copy.cleanup();

      // The provisioned shape: make the HOME data dir uncreatable so the
      // ordinary boot's migration records under ROOTPATH (as in the #812
      // fixture above). Boot 1 never ran the resolver, so there is no
      // `.flair` to preserve here.
      blockHomeFlairDir(installDir);

      // The ordinary, unmodified component — against the same store — migrates
      // the seed and records it under ROOTPATH.
      second = await startHarper({ installDir });
      const auth2 = basicAuth(second);
      const statePath = join(installDir, ".migrations", "state.json");
      const state = await awaitMigrationStateFile({
        statePath,
        entry: BACKFILL_ENTRY,
        getLog: () => second!.getLog?.() ?? "",
        timeoutMs: 90_000,
      });
      expect(state[BACKFILL_ENTRY]?.rowsProcessed).toBe(SEED_IDS.length);
      const migrated = await rowsOn(second, auth2);
      expect(migrated).toHaveLength(SEED_IDS.length);
      for (const row of migrated) expect(row.visibility).toBe("shared");
    } finally {
      try { if (first) await stopHarper(first); } catch { /* best effort */ }
      try { if (second) await stopHarper(second); } catch { /* best effort */ }
      if (installDir) {
        const { rm } = await import("node:fs/promises");
        await rm(installDir, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
      }
      copy.cleanup();
    }
  }, 300_000);
});

describe("flair#1785 slice 2 — bypass: production cannot reach the composition (the disable is a fixture-side file omission)", () => {
  test("static: nothing under src/ or resources/ references the fixture; the ordinary glob DOES load the trigger (positive control)", () => {
    // (1) The composition is fixture-only: no product source mentions it.
    const hits = sourceFilesReferencing(COMPOSED_FIXTURE_MODULE, [
      join(repoRoot(), "src"),
      join(repoRoot(), "resources"),
    ]);
    expect(hits).toEqual([]);

    // (2) Positive control — the check CAN fire: the ordinary built component's
    // jsResource glob matches the trigger, and the composed copy's does not.
    // Anchored to the real glob in config.yaml, not a paraphrase of it.
    const configYaml = readFileSync(join(repoRoot(), "config.yaml"), "utf-8");
    expect(configYaml).toContain("dist/resources/*.js");
    expect(globJsResources(repoRoot())).toContain("migration-boot.js");

    const copy = componentWithoutMigrationBoot();
    try {
      expect(existsSync(join(copy.dir, OMITTED_TRIGGER_REL))).toBe(false);
      expect(globJsResources(copy.dir)).not.toContain("migration-boot.js");
      // …and the copy still carries the OTHER resources + the schemas.
      expect(globJsResources(copy.dir)).toContain("health.js");
      expect(existsSync(join(copy.dir, "schemas"))).toBe(true);
    } finally {
      copy.cleanup();
    }
  });

  test("dynamic: with every production-input disable attempt set, a seeded row still migrates on the ordinary artifact", async () => {
    requireLocalComponentSelection("bypass fixture");

    // ── Production-reachable disable attempts, all at once. ──
    // env: plausibly-named toggles + the historical HDB_ROOT alias.
    const envSaved: Record<string, string | undefined> = {};
    for (const k of ["FLAIR_MIGRATION_DISABLE", "FLAIR_MIGRATIONS_DISABLED", "FLAIR_MIGRATIONS", "HDB_ROOT"]) {
      envSaved[k] = process.env[k];
    }
    process.env.FLAIR_MIGRATION_DISABLE = "1";
    process.env.FLAIR_MIGRATIONS_DISABLED = "1";
    process.env.FLAIR_MIGRATIONS = "off";
    process.env.HDB_ROOT = "/nonexistent/attempted-disable";

    let first: HarperInstance | undefined;
    let second: HarperInstance | undefined;
    let installDir: string | undefined;
    try {
      // config: a top-level block appended to the instance's own config, the
      // operator-reachable config surface (harperdb-config.yaml at ROOTPATH).
      first = await startHarper({
        appendRootConfigYaml: "flairTestMigrationDisable:\n  enabled: true\n",
      });
      installDir = first.installDir;
      const auth1 = basicAuth(first);

      // The trigger loaded and scheduled a cycle DESPITE the attempts.
      const a = await detailOn(first, auth1);
      expect(a.migrations?.cyclePhase).not.toBe("idle");

      // request: an ops call and a health read are not a disable either.
      await opsOn(first, auth1, { operation: "system_information" });
      await detailOn(first, auth1);

      // Seed pending rows, stop, and boot the ordinary artifact again: it must
      // migrate them and record under ROOTPATH. (If any production input could
      // disable migrations, this is where it would show.)
      await seedOn(first, auth1);
      await stopHarper(first, { keepInstallDir: true });
      first = undefined;

      // Same provisioned shape, so the ordinary boot records under ROOTPATH.
      blockHomeFlairDir(installDir);

      second = await startHarper({ installDir });
      const auth2 = basicAuth(second);
      const state = await awaitMigrationStateFile({
        statePath: join(installDir, ".migrations", "state.json"),
        entry: BACKFILL_ENTRY,
        getLog: () => second!.getLog?.() ?? "",
        timeoutMs: 90_000,
      });
      expect(state[BACKFILL_ENTRY]?.rowsProcessed).toBe(SEED_IDS.length);
      const migrated = await rowsOn(second, auth2);
      for (const row of migrated) expect(row.visibility).toBe("shared");
    } finally {
      for (const [k, v] of Object.entries(envSaved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try { if (first) await stopHarper(first); } catch { /* best effort */ }
      try { if (second) await stopHarper(second); } catch { /* best effort */ }
      if (installDir) {
        const { rm } = await import("node:fs/promises");
        await rm(installDir, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
      }
    }
  }, 300_000);

  test("the composed fixtures refuse external-service mode BY NAME (a check that can fire)", () => {
    const prev = process.env.HARPER_HTTP_URL;
    process.env.HARPER_HTTP_URL = "http://127.0.0.1:1";
    try {
      expect(() => requireLocalComponentSelection("guard unit check")).toThrow(
        /external-service mode is NOT valid for this fixture/,
      );
    } finally {
      if (prev === undefined) delete process.env.HARPER_HTTP_URL;
      else process.env.HARPER_HTTP_URL = prev;
    }
  });
});

/**
 * flair#1785 — the install failure is the REPORTED failure.
 *
 * Forcing Harper's own component install to fail from the harness is not
 * reliable: Harper SKIPS the install whenever the component dir already has
 * `node_modules` (node_modules/harper/dist/components/Application.js), and this
 * lane `bun install`s before the tests, so the install is normally skipped and
 * the CI failure shape is not reachable from here. What IS testable, and what
 * the fix actually changes, is the WAIT: given a boot log that carries Harper's
 * install-failure line, the state waiter must raise that named deploy failure
 * in seconds — not sit on a 60 s absence-of-state timeout that names the wrong
 * thing. The log below is Harper's real output shape; the timeout is the real
 * 60 s, so a regression to the swallow shows up as a ~60 s "no parseable"
 * failure. Mutation-check: drop the `getLog` scan from `awaitMigrationStateFile`
 * and this test fails.
 */
describe("flair#1785 — a failed component install is surfaced as the boot failure", () => {
  test("a forced install failure yields the named deploy error in seconds, never a 60 s absence-of-state timeout", async () => {
    const failingLog = [
      "[harper] Loading application from /repo",
      "error: Failed to install dependencies for flair using npm default. Exit code: 217",
      "[harper] Application flair failed to deploy; continuing to serve /Health",
    ].join("\n");

    const startedAt = Date.now();
    let err: Error | null = null;
    try {
      await awaitMigrationStateFile({
        statePath: join(tmpdir(), "flair-1785-never-written-state.json"),
        entry: BACKFILL_ENTRY,
        getLog: () => failingLog,
        timeoutMs: 60_000,
        pollMs: 20,
      });
    } catch (e) {
      err = e as Error;
    }

    expect(err).not.toBeNull();
    // The deploy error text, the operation, and the status — all named.
    expect(err!.message).toContain(
      "Failed to install dependencies for flair using npm default. Exit code: 217",
    );
    expect(err!.message).toContain("the component did not load");
    // NOT the downstream absence-of-state timeout.
    expect(err!.message).not.toMatch(/no parseable/);
    // Bounded: seconds, though the configured wait is 60 s.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 90_000);
});
