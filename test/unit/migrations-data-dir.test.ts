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
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
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
  for (const d of ["ro", "ro2", "no-search"]) {
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

  it("refuses a candidate that does not exist, and does not create it", () => {
    const absent = join(root, "absent");

    const p = probeMigrationDataDir(absent);

    expect(p.ok).toBe(false);
    expect(p.reason).toContain("refusing to create it");
    expect(existsSync(absent)).toBe(false);
  });

  it("refuses a candidate that is a file, not a directory", () => {
    const file = join(root, "a-file");
    writeFileSync(file, "x");

    const p = probeMigrationDataDir(file);

    expect(p.ok).toBe(false);
    expect(p.reason).toBe("not a directory");
  });

  it("refuses a candidate when lstat fails with EACCES, without creating it", () => {
    const candidate = join(root, "no-search", "instance");
    const realLstat = fs.lstatSync;
    const denied = spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      if (args[0] === candidate) {
        throw Object.assign(new Error("EACCES: permission denied, lstat"), { code: "EACCES" });
      }
      return realLstat(...args);
    }) as typeof fs.lstatSync);
    try {
      const p = probeMigrationDataDir(candidate);
      expect(denied).toHaveBeenCalled();
      expect(p.ok).toBe(false);
      expect(p.reason).toContain("EACCES");
      expect(p.reason).toContain("cannot confirm the candidate is an existing directory");
      expect(existsSync(candidate)).toBe(false);
    } finally {
      denied.mockRestore();
    }
  });

  it("does not recreate a candidate removed between lstat and mkdir", () => {
    const candidate = join(root, "vanished");
    mkdirSync(candidate);
    const realMkdir = fs.mkdirSync;
    const race = spyOn(fs, "mkdirSync").mockImplementation((...args: Parameters<typeof fs.mkdirSync>) => {
      if (args[0] === join(candidate, MIGRATIONS_SUBDIR)) rmSync(candidate, { recursive: true });
      return realMkdir(...args);
    });
    try {
      const p = probeMigrationDataDir(candidate);
      expect(race).toHaveBeenCalled();
      expect(p.ok).toBe(false);
      expect(p.reason).toContain("ENOENT");
      expect(existsSync(candidate)).toBe(false);
    } finally {
      race.mockRestore();
    }
  });

  it.each(["", "/"])("refuses a symlink candidate without writing through it (suffix=%s)", (suffix) => {
    const candidate = join(root, "linked");
    const target = join(root, "target");
    mkdirSync(target);
    symlinkSync(target, candidate);
    expect(probeMigrationDataDir(candidate + suffix)).toMatchObject({ ok: false });
    expect(existsSync(join(target, MIGRATIONS_SUBDIR))).toBe(false);
  });

  it("refuses a symlink .migrations child", () => {
    const target = join(root, "target");
    mkdirSync(target);
    symlinkSync(target, join(root, MIGRATIONS_SUBDIR));
    expect(probeMigrationDataDir(root)).toMatchObject({ ok: false });
  });

  it("accepts an existing .migrations directory", () => {
    mkdirSync(join(root, MIGRATIONS_SUBDIR));
    expect(probeMigrationDataDir(root).ok).toBe(true);
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

  it("picks an existing ROOTPATH candidate when ~/.flair/data is absent, and leaves it absent", () => {
    const home = join(root, "home");
    const instance = join(root, "instance-x");
    mkdirSync(home, { recursive: true });
    mkdirSync(instance, { recursive: true });

    // bun resolves os.homedir() once at process start, so HOME must be set
    // in a child's environment, not on this process.
    const moduleUrl = pathToFileURL(join(import.meta.dir, "../../resources/migrations/data-dir.ts")).href;
    const script = [
      `import { resolveWritableMigrationDataDir } from ${JSON.stringify(moduleUrl)};`,
      `const r = resolveWritableMigrationDataDir({ ROOTPATH: ${JSON.stringify(instance)} });`,
      `console.log(JSON.stringify({ dataDir: r.dataDir, first: r.tried[0] }));`,
    ].join("\n");
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, HOME: home },
    });
    expect(child.exitCode).toBe(0);
    const out = JSON.parse(child.stdout.toString().trim()) as {
      dataDir: string | null;
      first: { dir: string; ok: boolean };
    };

    // ~/.flair/data does not exist, so the absent candidate is refused
    // (and NOT created) and the instance's own root wins.
    expect(out.first).toMatchObject({ dir: join(home, ".flair", "data"), ok: false });
    expect(out.dataDir).toBe(instance);
    expect(existsSync(join(home, ".flair", "data"))).toBe(false);
  });

  it.each([true, false])("selects the default ahead of ROOTPATH only when usable (usable=%s)", (usable) => {
    const home = join(root, "home");
    const defaultDir = join(home, ".flair", "data");
    const instance = join(root, "instance-x");
    mkdirSync(defaultDir, { recursive: true });
    mkdirSync(instance);
    if (!usable) writeFileSync(join(defaultDir, MIGRATIONS_SUBDIR), "blocked");
    const moduleUrl = pathToFileURL(join(import.meta.dir, "../../resources/migrations/data-dir.ts")).href;
    const script = `import { resolveWritableMigrationDataDir } from ${JSON.stringify(moduleUrl)};
console.log(JSON.stringify(resolveWritableMigrationDataDir({ ROOTPATH: ${JSON.stringify(instance)} })));`;
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      env: { ...process.env, HOME: home },
    });
    expect(child.exitCode).toBe(0);
    const out = JSON.parse(child.stdout.toString().trim());
    expect(out.dataDir).toBe(usable ? defaultDir : instance);
    expect(out.tried[0]).toMatchObject({ dir: defaultDir, ok: usable });
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
