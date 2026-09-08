/**
 * upgrade-exec-path.test.ts — flair#1109 (b)
 *
 * `flair upgrade` must say so when the running exec path is not the
 * npm-global install, instead of reporting the global package as "the"
 * install. Detection only — no in-place tarball-swap lane.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findFlairPackageDir,
  readFlairPackageAt,
  sameInstallPath,
  extractPathHints,
  resolveServingFlairPackage,
  resolveNpmGlobalFlairPackage,
  classifyExecPathVsNpmGlobal,
  formatExecPathMismatchWarning,
  collectUpgradeExecPathWarning,
  defaultReadProcessCwd,
  defaultReadProcessCmdline,
  type FlairPackageLocation,
} from "../../src/lib/upgrade-exec-path.js";
import { npmGlobalFlairPackageDir } from "../../src/install/global-bin-path.js";

function freshTmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "flair-exec-path-")));
}

function writeFlairPackage(dir: string, version: string, name = "@tpsdev-ai/flair"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
}

describe("findFlairPackageDir", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = freshTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("finds the package at the directory itself", () => {
    writeFlairPackage(tmp, "0.36.0");
    expect(findFlairPackageDir(tmp)).toEqual({ dir: tmp, version: "0.36.0" });
  });

  test("walks up from a harper bin under node_modules", () => {
    writeFlairPackage(tmp, "0.36.0");
    const harperBin = join(tmp, "node_modules", "harper", "bin", "harper");
    mkdirSync(join(tmp, "node_modules", "harper", "bin"), { recursive: true });
    writeFileSync(harperBin, "#!/usr/bin/env node\n");
    writeFileSync(
      join(tmp, "node_modules", "harper", "package.json"),
      JSON.stringify({ name: "harper", version: "5.2.0" }),
    );
    expect(findFlairPackageDir(harperBin)).toEqual({ dir: tmp, version: "0.36.0" });
  });

  test("walks up from dist/cli.js", () => {
    writeFlairPackage(tmp, "0.28.0");
    const cli = join(tmp, "dist", "cli.js");
    mkdirSync(join(tmp, "dist"), { recursive: true });
    writeFileSync(cli, "");
    expect(findFlairPackageDir(cli)).toEqual({ dir: tmp, version: "0.28.0" });
  });

  test("ignores an intermediate package.json that is not @tpsdev-ai/flair", () => {
    writeFlairPackage(tmp, "0.36.0");
    const nested = join(tmp, "node_modules", "harper");
    writeFlairPackage(nested, "5.2.0", "harper");
    expect(findFlairPackageDir(nested)).toEqual({ dir: tmp, version: "0.36.0" });
  });

  test("returns null when no flair package is on the walk", () => {
    mkdirSync(join(tmp, "data"), { recursive: true });
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "not-flair", version: "1.0.0" }));
    expect(findFlairPackageDir(join(tmp, "data"))).toBeNull();
  });
});

describe("readFlairPackageAt", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = freshTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns null for a different package name", () => {
    writeFlairPackage(tmp, "1.0.0", "@tpsdev-ai/flair-mcp");
    expect(readFlairPackageAt(tmp)).toBeNull();
  });

  test("returns null when package.json is missing", () => {
    expect(readFlairPackageAt(tmp)).toBeNull();
  });
});

describe("sameInstallPath", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = freshTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("trailing slash does not create a mismatch", () => {
    expect(sameInstallPath(tmp, `${tmp}/`)).toBe(true);
  });

  test("symlink and its target are the same install", () => {
    const real = join(tmp, "real");
    const link = join(tmp, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    expect(sameInstallPath(link, real)).toBe(true);
  });

  test("distinct directories are not the same install", () => {
    const a = join(tmp, "a");
    const b = join(tmp, "b");
    mkdirSync(a);
    mkdirSync(b);
    expect(sameInstallPath(a, b)).toBe(false);
  });
});

describe("extractPathHints", () => {
  test("keeps absolute paths and drops flags and bare words", () => {
    expect(
      extractPathHints("/usr/bin/node /opt/flair/node_modules/harper/bin/harper run ."),
    ).toEqual([
      "/usr/bin/node",
      "/opt/flair/node_modules/harper/bin/harper",
    ]);
  });

  test("splits a /proc cmdline (null-separated)", () => {
    const raw = ["/usr/bin/node", "/opt/spoke/node_modules/harper/bin/harper", "run", "."].join("\0");
    expect(extractPathHints(raw)).toEqual([
      "/usr/bin/node",
      "/opt/spoke/node_modules/harper/bin/harper",
    ]);
  });

  test("keeps a relative node_modules path", () => {
    expect(extractPathHints("node node_modules/harper/bin/harper run .")).toEqual([
      "node_modules/harper/bin/harper",
    ]);
  });
});

describe("resolveServingFlairPackage", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = freshTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("prefers cwd when it is the package root", () => {
    writeFlairPackage(tmp, "0.36.0");
    const found = resolveServingFlairPackage(4242, {
      readCwd: () => tmp,
      readCmdline: () => "/usr/bin/node",
    });
    expect(found).toEqual({ dir: tmp, version: "0.36.0" });
  });

  test("falls back to the harper bin on the command line when cwd is a data dir", () => {
    const tree = join(tmp, "tree");
    const data = join(tmp, "data");
    writeFlairPackage(tree, "0.36.0");
    mkdirSync(data);
    const harperBin = join(tree, "node_modules", "harper", "bin", "harper");
    mkdirSync(join(tree, "node_modules", "harper", "bin"), { recursive: true });
    writeFileSync(harperBin, "");
    const found = resolveServingFlairPackage(4242, {
      readCwd: () => data,
      readCmdline: () => `/usr/bin/node ${harperBin} run .`,
    });
    expect(found).toEqual({ dir: tree, version: "0.36.0" });
  });

  test("returns null when neither hint is a flair package", () => {
    const data = join(tmp, "data");
    mkdirSync(data);
    expect(
      resolveServingFlairPackage(4242, {
        readCwd: () => data,
        readCmdline: () => "/usr/bin/node harper run .",
      }),
    ).toBeNull();
  });

  test("a throwing reader does not fail the probe", () => {
    expect(
      resolveServingFlairPackage(4242, {
        readCwd: () => { throw new Error("boom"); },
        readCmdline: () => { throw new Error("boom"); },
      }),
    ).toBeNull();
  });
});

describe("resolveNpmGlobalFlairPackage", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = freshTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("reads the package under a posix prefix", () => {
    const pkgDir = npmGlobalFlairPackageDir(tmp, "linux");
    writeFlairPackage(pkgDir, "0.28.0");
    expect(resolveNpmGlobalFlairPackage(tmp, "linux")).toEqual({
      dir: pkgDir,
      version: "0.28.0",
    });
  });

  test("returns null when the prefix has no flair package", () => {
    expect(resolveNpmGlobalFlairPackage(tmp, "linux")).toBeNull();
  });

  test("returns null for an empty prefix", () => {
    expect(resolveNpmGlobalFlairPackage("", "linux")).toBeNull();
    expect(resolveNpmGlobalFlairPackage(null, "linux")).toBeNull();
  });
});

describe("classifyExecPathVsNpmGlobal", () => {
  const serving: FlairPackageLocation = { dir: "/opt/flair-spoke", version: "0.36.0" };
  const global: FlairPackageLocation = {
    dir: "/home/u/.npm-global/lib/node_modules/@tpsdev-ai/flair",
    version: "0.28.0",
  };
  const cliGlobal: FlairPackageLocation = { dir: global.dir, version: "0.28.0" };

  test("the incident: serving tree ≠ stale npm-global relic", () => {
    const check = classifyExecPathVsNpmGlobal({ serving, cli: cliGlobal, global, prefixKnown: true });
    expect(check.kind).toBe("mismatch");
    if (check.kind !== "mismatch") return;
    expect(check.source).toBe("serving-instance");
    expect(check.runningPath).toBe(serving.dir);
    expect(check.runningVersion).toBe("0.36.0");
    expect(check.globalPath).toBe(global.dir);
    expect(check.globalVersion).toBe("0.28.0");
  });

  test("serving tree matches the npm-global install — no mismatch even if CLI differs", () => {
    const check = classifyExecPathVsNpmGlobal({
      serving: global,
      cli: serving,
      global,
      prefixKnown: true,
    });
    expect(check.kind).toBe("match");
    if (check.kind !== "match") return;
    expect(check.source).toBe("serving-instance");
  });

  test("no serving pid: this CLI is not the npm-global install", () => {
    const check = classifyExecPathVsNpmGlobal({ serving: null, cli: serving, global, prefixKnown: true });
    expect(check.kind).toBe("mismatch");
    if (check.kind !== "mismatch") return;
    expect(check.source).toBe("this-cli");
    expect(check.runningPath).toBe(serving.dir);
  });

  test("no serving pid: this CLI IS the npm-global install", () => {
    expect(classifyExecPathVsNpmGlobal({ serving: null, cli: global, global, prefixKnown: true }).kind).toBe("match");
  });

  test("known prefix with no npm-global package is a mismatch", () => {
    const check = classifyExecPathVsNpmGlobal({ serving, cli: serving, global: null, prefixKnown: true });
    expect(check.kind).toBe("mismatch");
    if (check.kind !== "mismatch") return;
    expect(check.globalPath).toBeNull();
    expect(check.source).toBe("serving-instance");
  });

  test("unknown prefix (failed npm prefix -g) is unknown, not a mismatch", () => {
    expect(classifyExecPathVsNpmGlobal({ serving, cli: serving, global: null, prefixKnown: false }).kind).toBe("unknown");
    expect(classifyExecPathVsNpmGlobal({ serving, cli: serving, global, prefixKnown: false }).kind).toBe("unknown");
  });

  test("no running path at all is unknown, not a warning", () => {
    expect(classifyExecPathVsNpmGlobal({ serving: null, cli: null, global, prefixKnown: true }).kind).toBe("unknown");
  });
});

describe("formatExecPathMismatchWarning", () => {
  test("names both paths and versions and does not propose a tarball-swap lane", () => {
    const text = formatExecPathMismatchWarning({
      kind: "mismatch",
      source: "serving-instance",
      runningPath: "/opt/flair-spoke",
      runningVersion: "0.36.0",
      globalPath: "/home/u/.npm-global/lib/node_modules/@tpsdev-ai/flair",
      globalVersion: "0.28.0",
    });
    expect(text).toContain("The running instance's exec path is not the npm-global install.");
    expect(text).toContain("Running:  /opt/flair-spoke  (0.36.0)");
    expect(text).toContain("npm-global: /home/u/.npm-global/lib/node_modules/@tpsdev-ai/flair  (0.28.0)");
    expect(text).toContain("`flair upgrade` only upgrades the npm-global packages");
    expect(text).toContain("The tree serving traffic is unchanged");
    expect(text?.toLowerCase()).not.toMatch(/tarball|tar-swap|in-place|npm pack/);
  });

  test("CLI-source wording when no serving instance was resolved", () => {
    const text = formatExecPathMismatchWarning({
      kind: "mismatch",
      source: "this-cli",
      runningPath: "/opt/flair-spoke",
      runningVersion: "0.36.0",
      globalPath: "/usr/lib/node_modules/@tpsdev-ai/flair",
      globalVersion: "0.28.0",
    });
    expect(text).toContain("This CLI's exec path is not the npm-global install.");
    expect(text).toContain("This CLI:  /opt/flair-spoke  (0.36.0)");
  });

  test("says when the npm-global package is absent", () => {
    const text = formatExecPathMismatchWarning({
      kind: "mismatch",
      source: "serving-instance",
      runningPath: "/opt/flair-spoke",
      runningVersion: "0.36.0",
      globalPath: null,
      globalVersion: null,
    });
    expect(text).toContain("npm-global: not installed");
    expect(text).not.toContain("(null)");
  });

  test("match and unknown print nothing", () => {
    expect(formatExecPathMismatchWarning({
      kind: "match",
      runningPath: "/x",
      globalPath: "/x",
      source: "this-cli",
    })).toBeNull();
    expect(formatExecPathMismatchWarning({ kind: "unknown" })).toBeNull();
  });
});

describe("collectUpgradeExecPathWarning", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = freshTmp();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("the incident: PATH CLI is the relic; the serving tree is a different extract", () => {
    const spoke = join(tmp, "spoke");
    const prefix = join(tmp, "prefix");
    writeFlairPackage(spoke, "0.36.0");
    writeFlairPackage(npmGlobalFlairPackageDir(prefix, "linux"), "0.28.0");
    const warning = collectUpgradeExecPathWarning({
      servingPid: 99,
      cliPackageDir: npmGlobalFlairPackageDir(prefix, "linux"),
      npmGlobalPrefix: prefix,
      platform: "linux",
      hooks: {
        readCwd: () => spoke,
        readCmdline: () => null,
      },
    });
    expect(warning).toContain("The running instance's exec path is not the npm-global install.");
    expect(warning).toContain(spoke);
    expect(warning).toContain("(0.36.0)");
    expect(warning).toContain("(0.28.0)");
    expect(warning).toContain("The tree serving traffic is unchanged");
  });

  test("happy path: serving tree IS the npm-global install — silent", () => {
    const prefix = join(tmp, "prefix");
    const globalDir = npmGlobalFlairPackageDir(prefix, "linux");
    writeFlairPackage(globalDir, "0.40.0");
    const warning = collectUpgradeExecPathWarning({
      servingPid: 99,
      cliPackageDir: globalDir,
      npmGlobalPrefix: prefix,
      platform: "linux",
      hooks: {
        readCwd: () => globalDir,
        readCmdline: () => null,
      },
    });
    expect(warning).toBeNull();
  });

  test("no pid and this CLI is the global install — silent", () => {
    const prefix = join(tmp, "prefix");
    const globalDir = npmGlobalFlairPackageDir(prefix, "linux");
    writeFlairPackage(globalDir, "0.40.0");
    expect(collectUpgradeExecPathWarning({
      servingPid: null,
      cliPackageDir: globalDir,
      npmGlobalPrefix: prefix,
      platform: "linux",
    })).toBeNull();
  });

  test("must never throw when readers blow up", () => {
    expect(collectUpgradeExecPathWarning({
      servingPid: 1,
      cliPackageDir: "/no/such/flair/tree",
      npmGlobalPrefix: null,
      hooks: {
        readCwd: () => { throw new Error("cwd"); },
        readCmdline: () => { throw new Error("cmd"); },
      },
    })).toBeNull();
  });

  test("missing npmGlobalPrefix degrades to unknown — no warning", () => {
    const spoke = join(tmp, "spoke");
    writeFlairPackage(spoke, "0.36.0");
    expect(collectUpgradeExecPathWarning({
      servingPid: 99,
      cliPackageDir: spoke,
      npmGlobalPrefix: null,
      platform: "linux",
      hooks: { readCwd: () => spoke, readCmdline: () => null },
    })).toBeNull();
    expect(collectUpgradeExecPathWarning({
      servingPid: 99,
      cliPackageDir: spoke,
      npmGlobalPrefix: "   ",
      platform: "linux",
      hooks: { readCwd: () => spoke, readCmdline: () => null },
    })).toBeNull();
  });

  test("known prefix with no flair package still warns", () => {
    const spoke = join(tmp, "spoke");
    const prefix = join(tmp, "empty-prefix");
    writeFlairPackage(spoke, "0.36.0");
    mkdirSync(prefix, { recursive: true });
    const warning = collectUpgradeExecPathWarning({
      servingPid: 99,
      cliPackageDir: spoke,
      npmGlobalPrefix: prefix,
      platform: "linux",
      hooks: { readCwd: () => spoke, readCmdline: () => null },
    });
    expect(warning).toContain("The running instance's exec path is not the npm-global install.");
    expect(warning).toContain("npm-global: not installed");
  });
});

describe("default process readers", () => {
  test("invalid pids return null without throwing", () => {
    expect(defaultReadProcessCwd(0)).toBeNull();
    expect(defaultReadProcessCwd(-1)).toBeNull();
    expect(defaultReadProcessCmdline(0)).toBeNull();
  });

  test("a nonexistent pid returns null", () => {
    expect(defaultReadProcessCwd(999_999_999)).toBeNull();
    expect(defaultReadProcessCmdline(999_999_999)).toBeNull();
  });

  test("this process's cwd is readable on linux", () => {
    if (process.platform !== "linux") return;
    const cwd = defaultReadProcessCwd(process.pid);
    expect(cwd).toBeTruthy();
    expect(cwd!.startsWith("/")).toBe(true);
  });
});
