/**
 * migrations-symlinked-datadir-2277.test.ts — flair#2277.
 *
 * Since #2234 a symlinked migration data directory is refused at boot, but the
 * refusal read "not a directory" / ".migrations is not a directory": it named
 * neither the path it was configured at nor the path it resolved to, and gave
 * no remedy. This pins the replacement — one refusal naming the configured
 * path, the real path it resolves to, why a symlink is refused, and the remedy
 * — carried by all three surfaces an operator meets it on:
 *
 *   - boot: `describeUnresolvableDataDir`, which resources/migration-boot.ts
 *     logs (with the `[flair-migrations]` marker);
 *   - migration: the failed per-migration `reason` and `lastCycleError` in
 *     /HealthDetail;
 *   - doctor: `flair doctor` renders those two fields verbatim (the "Last
 *     migration cycle did not complete: …" line and the per-migration line —
 *     src/commands/doctor.ts, fetchAndRenderMigrations).
 *
 * The refusal itself is kept: a symlink can be re-pointed between the check and
 * the write, and Node offers no openat-style handle to pin it. No symlink
 * support is added.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MIGRATION_DATA_DIR_ENV,
  MIGRATIONS_SUBDIR,
  describeUnresolvableDataDir,
  probeMigrationDataDir,
} from "../../resources/migrations/data-dir.ts";
import {
  _resetProgressForTests,
  markIdleMigrationsFailed,
  seedIdleProgress,
  setCyclePhase,
} from "../../resources/migrations/progress.ts";
import { getMigrationStatusSnapshot } from "../../resources/migrations/status.ts";

let root: string;
/** The real directory the configured path is a symlink to. */
let realDir: string;
/** The configured path itself: a symlink to `realDir`. */
let linkDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flair-2277-symlinked-datadir-"));
  realDir = join(root, "real-data");
  mkdirSync(realDir);
  linkDir = join(root, "configured-data");
  symlinkSync(realDir, linkDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Runs the boot resolver in a child whose HOME is empty, so
 * `homedir()/.flair/data` (a candidate between the override and ROOTPATH) is
 * absent — otherwise a present default on the test host would resolve and
 * hide the refusal. bun reads HOME once at process start, so this must be a
 * child, not an env assignment in-process.
 */
function resolveAtBoot(env: Record<string, string>): {
  dataDir: string | null;
  tried: Array<{ dir: string; ok: boolean; reason?: string }>;
  message: string;
} {
  const moduleUrl = pathToFileURL(
    join(import.meta.dir, "../../resources/migrations/data-dir.ts"),
  ).href;
  const script = [
    `import { resolveWritableMigrationDataDir, describeUnresolvableDataDir } from ${JSON.stringify(moduleUrl)};`,
    `const r = resolveWritableMigrationDataDir(${JSON.stringify(env)});`,
    `console.log(JSON.stringify({ dataDir: r.dataDir, tried: r.tried, message: describeUnresolvableDataDir(r.tried) }));`,
  ].join("\n");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, HOME: home },
    timeout: 15_000,
  });
  if (child.exitCode !== 0) throw new Error(`child failed: ${child.stderr.toString()}`);
  return JSON.parse(child.stdout.toString().trim());
}

describe("probeMigrationDataDir — a symlinked candidate (flair#2277)", () => {
  it("refuses it, naming the configured path, the path it resolves to, why, and the remedy", () => {
    const probe = probeMigrationDataDir(linkDir);

    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain(linkDir); // the configured path
    expect(probe.reason).toContain(realDir); // the real path it resolves to
    expect(probe.reason).toContain("symbolic link to");
    expect(probe.reason).toContain("re-pointed after this check"); // why it is refused
    expect(probe.reason).toContain("stop Flair"); // the remedy
    expect(probe.reason).toContain(MIGRATION_DATA_DIR_ENV);
    // The refusal is a refusal: nothing was created through the link.
    expect(existsSync(join(realDir, MIGRATIONS_SUBDIR))).toBe(false);
  });

  it("refuses a symlinked .migrations child the same way", () => {
    const owned = join(root, MIGRATIONS_SUBDIR);
    symlinkSync(realDir, owned);

    const probe = probeMigrationDataDir(root);

    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain(owned);
    expect(probe.reason).toContain(realDir);
    expect(probe.reason).toContain("stop Flair");
  });

  it("refuses a dangling symlink without a directory to move, naming the link and a remedy", () => {
    const dangling = join(root, "dangling");
    symlinkSync(join(root, "does-not-exist"), dangling);

    const probe = probeMigrationDataDir(dangling);

    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain(dangling);
    expect(probe.reason).toContain("cannot be resolved");
    expect(probe.reason).toContain("stop Flair");
    // Its target does not exist, so the remedy never names a directory to move.
    expect(probe.reason).not.toContain("move the directory at");
  });

  it("still reports a plain file and an absent candidate with their own (non-symlink) reasons", () => {
    const file = join(root, "a-file");
    writeFileSync(file, "x");
    expect(probeMigrationDataDir(file).reason).toBe("not a directory");
    expect(probeMigrationDataDir(join(root, "absent")).reason).toContain("refusing to create it");
  });
});

describe("boot path — the refusal migration-boot.ts logs (flair#2277)", () => {
  it("names both paths and the remedy, and resolves to no data directory", () => {
    const { dataDir, tried, message } = resolveAtBoot({
      [MIGRATION_DATA_DIR_ENV]: linkDir,
      ROOTPATH: linkDir,
    });

    expect(dataDir).toBeNull();
    expect(tried[0]).toMatchObject({ dir: linkDir, ok: false });
    expect(tried[0].reason).toContain(realDir);
    expect(message).toContain(linkDir);
    expect(message).toContain(realDir);
    expect(message).toContain("stop Flair");
  });
});

describe("migration path — what /HealthDetail reports (flair#2277)", () => {
  it("carries the same refusal as the failed per-migration reason and lastCycleError", () => {
    // Exactly what resources/migration-boot.ts's reportBootFailure does with
    // describeUnresolvableDataDir(resolved.tried).
    const refusal = describeUnresolvableDataDir([probeMigrationDataDir(linkDir)]);
    _resetProgressForTests();
    seedIdleProgress(["embedding-stamp"]);
    setCyclePhase("done", refusal);
    markIdleMigrationsFailed(["embedding-stamp"], refusal);

    const snapshot = getMigrationStatusSnapshot(linkDir);

    expect(snapshot.lastCycleError).toBe(refusal);
    const failed = snapshot.migrations.find((m) => m.id === "embedding-stamp");
    expect(failed?.state).toBe("failed");
    expect(failed?.reason).toBe(refusal);
    expect(failed?.reason).toContain(linkDir);
    expect(failed?.reason).toContain(realDir);
    expect(failed?.reason).toContain("stop Flair");
  });
});

describe("doctor path — the Migrations fields doctor renders (flair#2277)", () => {
  it("the lastCycleError and failed-migration values doctor prints name both paths and the remedy", () => {
    const refusal = describeUnresolvableDataDir([probeMigrationDataDir(linkDir)]);
    _resetProgressForTests();
    seedIdleProgress(["embedding-stamp"]);
    setCyclePhase("done", refusal);
    markIdleMigrationsFailed(["embedding-stamp"], refusal);

    const snapshot = getMigrationStatusSnapshot(linkDir);
    // doctor renders `Last migration cycle did not complete: ${lastCycleError}`
    // and, per migration, `${id}: ${state} — ${reason}`.
    const rendered = [
      `Last migration cycle did not complete: ${snapshot.lastCycleError}`,
      ...snapshot.migrations.map((m) => `${m.id}: ${m.state} — ${m.reason ?? ""}`),
    ];

    for (const line of rendered) {
      expect(line).toContain(linkDir);
      expect(line).toContain(realDir);
      expect(line).toContain("stop Flair");
    }
  });
});
