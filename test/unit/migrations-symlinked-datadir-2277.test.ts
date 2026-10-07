import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MIGRATION_DATA_DIR_ENV,
  MIGRATIONS_SUBDIR,
  probeMigrationDataDir,
} from "../../resources/migrations/data-dir.ts";
let root: string;
/** The real directory the configured path is a symlink to. */
let realDir: string;
/** The configured path itself: a symlink to `realDir`. */
let linkDir: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "flair-2277-symlinked-datadir-")));
  realDir = join(root, "real-data");
  mkdirSync(realDir);
  linkDir = join(root, "configured-data");
  symlinkSync(realDir, linkDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function resolveInChild(env: Record<string, string>): {
  dataDir: string | null;
  tried: Array<{ dir: string; ok: boolean; reason?: string }>;
} {
  const moduleUrl = pathToFileURL(
    join(import.meta.dir, "../../resources/migrations/data-dir.ts"),
  ).href;
  const script = [
    `import { resolveWritableMigrationDataDir } from ${JSON.stringify(moduleUrl)};`,
    `const r = resolveWritableMigrationDataDir(${JSON.stringify(env)});`,
    `console.log(JSON.stringify({ dataDir: r.dataDir, tried: r.tried }));`,
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

it("distinguishes a link to a regular file from a directory", () => {
  const file = join(root, "target-file");
  const link = join(root, "file-link");
  writeFileSync(file, "x");
  symlinkSync(file, link);
  const probe = probeMigrationDataDir(link);
  expect(probe.ok).toBe(false);
  expect(probe.reason).toContain(`a regular file at ${file}`);
  expect(probe.reason).toContain("replace it with a writable directory");
  expect(probe.reason).not.toContain("move the directory");
  expect(probe.reason).not.toContain(MIGRATION_DATA_DIR_ENV);
});

it("does not offer the data-directory override for a linked .migrations child", () => {
  symlinkSync(realDir, join(root, MIGRATIONS_SUBDIR));
  expect(probeMigrationDataDir(root).reason).not.toContain(MIGRATION_DATA_DIR_ENV);
});

it("selects a usable fallback after rejecting a linked data directory", () => {
  const { dataDir, tried } = resolveInChild({ [MIGRATION_DATA_DIR_ENV]: linkDir, ROOTPATH: realDir });
  expect(dataDir).toBe(realDir);
  expect(tried[0]).toMatchObject({ dir: linkDir, ok: false });
  expect(tried.at(-1)).toMatchObject({ dir: realDir, ok: true });
});
