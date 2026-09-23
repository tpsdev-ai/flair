/**
 * Home-derived paths follow the platform rule, in the SAME process (flair#1858).
 *
 * Every subsystem that computes a `~` path must agree on where home is:
 * `resolveHome()` (win32 → `USERPROFILE`, elsewhere → `HOME`, both falling back
 * to `homedir()`), resolved at CALL time. These tests stub `process.platform`, so
 * both branches run on any host, and every home is a fixture under the OS temp
 * dir — a real home is never touched.
 *
 * The last test is the point of the change: a `HOME` set AFTER the module was
 * imported (which `os.homedir()`, cached at process start, would ignore) is
 * followed by doctor's config resolver AND by the writers' path helpers, so they
 * cannot disagree.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveHome } from "../../src/lib/home.ts";
import { flairBackupOutputPath, flairConfigPath, flairDataDir } from "../../src/lib/flair-paths.ts";
import { flairConfigYamlCandidates } from "../../src/lib/doctor-config-path.ts";
import { purgeFlairInstall } from "../../src/lib/uninstall-purge.ts";

const dirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const savedHome = process.env.HOME;
const savedProfile = process.env.USERPROFILE;
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function withPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return body();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

describe("data dir, config.yaml and backup output follow the platform rule (flair#1858)", () => {
  test("win32: USERPROFILE wins over HOME", () => {
    const profile = scratch("flair-1858-win-profile-");
    const elsewhere = scratch("flair-1858-win-elsewhere-");
    process.env.HOME = elsewhere;
    process.env.USERPROFILE = profile;

    withPlatform("win32", () => {
      expect(flairDataDir()).toBe(join(profile, ".flair", "data"));
      expect(flairConfigPath()).toBe(join(profile, ".flair", "config.yaml"));
      expect(flairBackupOutputPath("2026-01-01T00-00-00")).toBe(
        join(profile, ".flair", "backups", "flair-backup-2026-01-01T00-00-00.json"),
      );
      // Nothing is computed under the wrong HOME.
      expect(existsSync(join(elsewhere, ".flair"))).toBe(false);
    });
  });

  test("win32: config.yml is used when only it exists under the resolved home", () => {
    const profile = scratch("flair-1858-win-yml-");
    mkdirSync(join(profile, ".flair"), { recursive: true });
    writeFileSync(join(profile, ".flair", "config.yml"), "port: 1\n");
    process.env.HOME = scratch("flair-1858-win-yml-wrong-");
    process.env.USERPROFILE = profile;

    withPlatform("win32", () => {
      expect(flairConfigPath()).toBe(join(profile, ".flair", "config.yml"));
    });
  });

  test("posix: HOME wins, and a later HOME change is followed", () => {
    const first = scratch("flair-1858-posix-a-");
    const second = scratch("flair-1858-posix-b-");
    process.env.USERPROFILE = "/must/be/ignored/on/posix";

    withPlatform("linux", () => {
      process.env.HOME = first;
      expect(flairDataDir()).toBe(join(first, ".flair", "data"));
      expect(flairConfigPath()).toBe(join(first, ".flair", "config.yaml"));
      process.env.HOME = second;
      expect(flairDataDir()).toBe(join(second, ".flair", "data"));
      expect(flairConfigPath()).toBe(join(second, ".flair", "config.yaml"));
    });
  });

  test("an explicit home override wins on both platforms", () => {
    const explicit = scratch("flair-1858-explicit-");
    process.env.HOME = scratch("flair-1858-explicit-wrong-");
    for (const platform of ["linux", "win32"] as const) {
      withPlatform(platform, () => {
        expect(flairDataDir(explicit)).toBe(join(explicit, ".flair", "data"));
        expect(flairConfigPath(explicit)).toBe(join(explicit, ".flair", "config.yaml"));
      });
    }
  });
});

describe("uninstall purge resolves home the same way (flair#1858)", () => {
  test("win32: purge sweeps USERPROFILE, not HOME", () => {
    const profile = scratch("flair-1858-purge-win-profile-");
    const elsewhere = scratch("flair-1858-purge-win-elsewhere-");
    mkdirSync(join(profile, ".flair", "data"), { recursive: true });
    writeFileSync(join(profile, ".flair", "data", "stale.txt"), "x\n");
    mkdirSync(join(elsewhere, ".flair", "data"), { recursive: true });
    writeFileSync(join(elsewhere, ".flair", "data", "keep.txt"), "x\n");
    process.env.HOME = elsewhere;
    process.env.USERPROFILE = profile;

    const result = withPlatform("win32", () => purgeFlairInstall({ skipSchedulerUnload: true }));
    // `removed` is home-relativised ("~/.flair"), so the platform rule is proven
    // on the filesystem: the profile home is swept, the wrong HOME is untouched.
    expect(result.removed.length).toBeGreaterThan(0);
    expect(existsSync(join(profile, ".flair"))).toBe(false);
    expect(existsSync(join(elsewhere, ".flair", "data", "keep.txt"))).toBe(true);
  });

  test("posix: purge sweeps HOME", () => {
    const home = scratch("flair-1858-purge-posix-");
    mkdirSync(join(home, ".flair", "data"), { recursive: true });
    writeFileSync(join(home, ".flair", "data", "stale.txt"), "x\n");
    process.env.HOME = home;
    process.env.USERPROFILE = "/must/be/ignored/on/posix";

    const result = withPlatform("linux", () => purgeFlairInstall({ skipSchedulerUnload: true }));
    expect(result.removed.length).toBeGreaterThan(0);
    expect(existsSync(join(home, ".flair"))).toBe(false);
  });
});

describe("a HOME set after import is followed by doctor and the writers alike (flair#1858)", () => {
  test("doctor's config resolver and the writers' helpers name the same late home", () => {
    const late = scratch("flair-1858-late-");
    // Set AFTER the modules were imported: os.homedir() (cached at process start)
    // would still name the real home; resolveHome() must follow this.
    process.env.HOME = late;
    process.env.USERPROFILE = late;

    expect(resolveHome()).toBe(late);
    const writersConfig = flairConfigPath();
    const doctorHomeCandidate = flairConfigYamlCandidates({ cwd: late }).find((p) =>
      p.startsWith(join(late, ".flair")),
    );
    expect(writersConfig).toBe(join(late, ".flair", "config.yaml"));
    expect(doctorHomeCandidate).toBe(writersConfig);
    expect(flairDataDir()).toBe(join(late, ".flair", "data"));
  });
});
