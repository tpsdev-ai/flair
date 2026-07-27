/**
 * migrations-data-dir.test.ts — resources/migrations/data-dir.ts (flair#812).
 *
 * The defect this covers is a SILENT one, so the tests are written against
 * the two things that actually went wrong in production and could not be
 * seen from outside:
 *
 *   1. The dir resolution depended on `HDB_ROOT`, an env var nothing sets —
 *      so it was unconditionally `~/.flair/data` no matter where the
 *      instance's real root was, and on a provisioned shape whose homedir
 *      isn't writable there was no fallback at all.
 *   2. An unusable dir produced NO signal: the runner's first act
 *      (`acquireMigrationLock` → `mkdirSync`) threw, the runner turned that
 *      into a `{ ran: false, reason }` return value, and the boot path
 *      discarded it.
 *
 * So: resolution must fall through to a usable candidate, and total failure
 * must be REPORTED with the paths tried and a remedy — never a bare false.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  MIGRATION_DATA_DIR_ENV,
  MIGRATIONS_SUBDIR,
  deployedComponentRootPath,
  describeUnresolvableDataDir,
  migrationDataDirCandidates,
  probeMigrationDataDir,
  resolveMigrationDataDirForRead,
  resolveWritableMigrationDataDir,
} from "../../resources/migrations/data-dir.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flair-migration-datadir-test-"));
});

afterEach(() => {
  // Re-open anything the tests locked down so rm can recurse into it.
  for (const d of ["ro", "ro2"]) {
    const p = join(root, d);
    if (existsSync(p)) {
      try { chmodSync(p, 0o700); } catch { /* best effort */ }
    }
  }
  rmSync(root, { recursive: true, force: true });
});

describe("migrationDataDirCandidates", () => {
  it("puts the explicit override first, then HDB_ROOT, then ~/.flair/data, then ROOTPATH", () => {
    const candidates = migrationDataDirCandidates({
      [MIGRATION_DATA_DIR_ENV]: "/override",
      HDB_ROOT: "/legacy",
      ROOTPATH: "/harper-root",
    } as NodeJS.ProcessEnv);

    expect(candidates.slice(0, 4)).toEqual([
      "/override",
      "/legacy",
      join(homedir(), ".flair", "data"),
      "/harper-root",
    ]);
  });

  it("still offers ROOTPATH when HDB_ROOT is unset — the production case, since nothing ever sets HDB_ROOT", () => {
    // This is the whole bug in one assertion: before flair#812 the resolution
    // was `HDB_ROOT ?? homedir()/.flair/data`, so with HDB_ROOT unset (i.e.
    // always) Harper's REAL root path was never even a candidate.
    const candidates = migrationDataDirCandidates({ ROOTPATH: "/harper-root" } as NodeJS.ProcessEnv);
    expect(candidates).toContain("/harper-root");
    expect(candidates.indexOf(join(homedir(), ".flair", "data"))).toBeLessThan(
      candidates.indexOf("/harper-root"),
    );
  });

  it("ignores empty/whitespace env values and never repeats a path", () => {
    const candidates = migrationDataDirCandidates({
      [MIGRATION_DATA_DIR_ENV]: "   ",
      HDB_ROOT: "/same",
      ROOTPATH: "/same",
    } as NodeJS.ProcessEnv);
    expect(candidates.filter((c) => c === "/same")).toHaveLength(1);
    expect(candidates).not.toContain("   ");
  });
});

describe("deployedComponentRootPath", () => {
  it("infers the Harper root from a deployed-component layout", () => {
    const url = pathToFileURL(
      "/opt/harper/components/flair/dist/resources/migrations/data-dir.js",
    ).href;
    expect(deployedComponentRootPath(url)).toBe("/opt/harper");
  });

  it("returns null for a source checkout / npm install layout (never a guessed parent)", () => {
    const url = pathToFileURL(
      "/home/dev/src/flair/dist/resources/migrations/data-dir.js",
    ).href;
    expect(deployedComponentRootPath(url)).toBeNull();
  });
});

describe("probeMigrationDataDir", () => {
  it("creates <dir>/.migrations at 0700 and reports ok", () => {
    const probe = probeMigrationDataDir(root);
    expect(probe.ok).toBe(true);
    const owned = join(root, MIGRATIONS_SUBDIR);
    expect(existsSync(owned)).toBe(true);
    expect(statSync(owned).mode & 0o777).toBe(0o700);
  });

  it("reports the errno-bearing reason when the dir cannot be created", () => {
    const ro = join(root, "ro");
    mkdirSync(ro, { recursive: true });
    chmodSync(ro, 0o500); // r-x: mkdir inside must fail

    const probe = probeMigrationDataDir(ro);
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain("EACCES");
    expect(probe.reason).toContain(MIGRATIONS_SUBDIR);
  });
});

describe("resolveWritableMigrationDataDir", () => {
  it("falls through an unusable candidate to the next usable one", () => {
    const ro = join(root, "ro");
    const good = join(root, "good");
    mkdirSync(ro, { recursive: true });
    mkdirSync(good, { recursive: true });
    chmodSync(ro, 0o500);

    const resolved = resolveWritableMigrationDataDir({
      [MIGRATION_DATA_DIR_ENV]: ro,
      HDB_ROOT: good,
    } as NodeJS.ProcessEnv);

    expect(resolved.dataDir).toBe(good);
    expect(resolved.tried[0]).toMatchObject({ dir: ro, ok: false });
    expect(resolved.tried.at(-1)).toMatchObject({ dir: good, ok: true });
  });

  it("stops at the first usable candidate without probing later ones", () => {
    const good = join(root, "good");
    mkdirSync(good, { recursive: true });

    const resolved = resolveWritableMigrationDataDir({
      [MIGRATION_DATA_DIR_ENV]: good,
      HDB_ROOT: join(root, "never-touched"),
    } as NodeJS.ProcessEnv);

    expect(resolved.dataDir).toBe(good);
    expect(resolved.tried).toHaveLength(1);
    expect(existsSync(join(root, "never-touched"))).toBe(false);
  });
});

describe("describeUnresolvableDataDir", () => {
  it("names every path tried, why each failed, and the remedy", () => {
    const message = describeUnresolvableDataDir([
      { dir: "/a", ok: false, reason: "EACCES: permission denied, mkdir '/a/.migrations'" },
      { dir: "/b", ok: false, reason: "EROFS: read-only file system, mkdir '/b/.migrations'" },
    ]);

    // Actor + state + remedy — an operator must be able to act on this at
    // 3am without reading the source.
    expect(message).toContain("/a");
    expect(message).toContain("EACCES");
    expect(message).toContain("/b");
    expect(message).toContain("EROFS");
    expect(message).toContain(MIGRATION_DATA_DIR_ENV);
  });
});

describe("resolveMigrationDataDirForRead", () => {
  it("never creates anything (it backs a GET /HealthDetail)", () => {
    const fresh = join(root, "fresh");
    mkdirSync(fresh, { recursive: true });

    resolveMigrationDataDirForRead({ [MIGRATION_DATA_DIR_ENV]: fresh } as NodeJS.ProcessEnv);

    expect(existsSync(join(fresh, MIGRATIONS_SUBDIR))).toBe(false);
  });

  it("prefers whichever candidate already carries a .migrations dir — i.e. the one a boot actually chose", () => {
    const first = join(root, "first");
    const chosen = join(root, "chosen");
    mkdirSync(first, { recursive: true });
    mkdirSync(join(chosen, MIGRATIONS_SUBDIR), { recursive: true });
    writeFileSync(join(chosen, MIGRATIONS_SUBDIR, "state.json"), "{}");

    const dir = resolveMigrationDataDirForRead({
      [MIGRATION_DATA_DIR_ENV]: first,
      HDB_ROOT: chosen,
    } as NodeJS.ProcessEnv);

    expect(dir).toBe(chosen);
  });
});
