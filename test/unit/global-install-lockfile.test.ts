/**
 * global-install-lockfile.test.ts — flair#1683 regression lane, unit half.
 *
 * `scripts/check-global-install-lockfile.mjs` is the CI gate that would have
 * caught 0.54.1 (a global install that exits 0 but leaves harper with no
 * dependency tree). These tests pin its pure logic and, against a synthetic
 * healthy/broken prefix, the four checks themselves. The end-to-end proof
 * against the real published 0.54.1 tarball lives in the PR body.
 *
 * Hermetic on purpose: the resolver check requires the fs-extra hit to be INSIDE
 * the installed tree, so neither an ambient `node_modules/fs-extra` above
 * os.tmpdir() nor one above the fixture can turn the broken shapes green. The
 * fixtures below pin both directions.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { nodeBin } from "../helpers/node-runtime.ts";
import {
  BUDGET_REL,
  FLAIR_PACKAGE,
  countFlairTree,
  evaluateInstall as evaluateInstallNative,
  hasDamagedLockfileWarning,
  parseAddedCount,
  readMinPackages,
  registryInstallSpec,
  resolveFromLoggingDir,
  treePaths,
} from "../../scripts/check-global-install-lockfile.mjs";

const REPO = join(import.meta.dir, "../..");
function evaluateInstall(options: Parameters<typeof evaluateInstallNative>[0]): ReturnType<typeof evaluateInstallNative> {
  const script = pathToFileURL(join(REPO, "scripts/check-global-install-lockfile.mjs")).href;
  const output = execFileSync(nodeBin(), ["--input-type=module", "-e", `
    import { readFileSync } from 'node:fs';
    import { evaluateInstall } from ${JSON.stringify(script)};
    const runtime = process.versions.bun ? 'bun' : process.versions.node;
    try { console.log(JSON.stringify({ runtime, value: evaluateInstall(JSON.parse(readFileSync(0, 'utf8'))) })); }
    catch (error) { console.log(JSON.stringify({ runtime, error: error.message })); }
  `], { input: JSON.stringify(options), encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
  const result = JSON.parse(output);
  expect(result.runtime).toMatch(/^\d+\.\d+\.\d+/);
  if ("error" in result) throw new Error(result.error);
  return result.value;
}
/** The reviewed floor, read the same way CI reads it. */
const MIN = readMinPackages(REPO);

/**
 * The fixtures below are shaped for the resolve/entrypoint checks and the graph
 * count, not for the weight floor: they carry a handful of packages. Passing
 * this floor keeps the floor out of those assertions; the floor itself is
 * tested separately.
 */
const FIXTURE_FLOOR = 1;

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HEALTHY_LOG = [
  "npm warn deprecated inflight@1.0.6: not supported",
  "",
  "added 543 packages in 9s",
].join("\n");

const BROKEN_LOG = [
  "npm warn reify invalid or damaged lockfile detected",
  "npm warn reify invalid or damaged lockfile detected",
  "",
  "added 50 packages in 10s",
].join("\n");

/** Write `dir/package.json`. */
function writePackage(dir: string, manifest: Record<string, unknown>) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
}

/**
 * A prefix shaped like a real `npm install -g` tree: Flair declaring harper,
 * harper declaring fs-extra in its own bundled `node_modules`, and a working
 * entrypoint.
 */
function healthyPrefix() {
  const prefix = mkdtempSync(join(tmpdir(), "flair-gi-"));
  fixtures.push(prefix);
  const paths = treePaths(prefix);
  writePackage(paths.flair, { name: FLAIR_PACKAGE, version: "0.0.1", dependencies: { harper: "5.3.4" } });
  const harper = join(paths.flair, "node_modules", "harper");
  writePackage(harper, { name: "harper", version: "5.3.4", dependencies: { "fs-extra": "11.3.0" } });
  mkdirSync(paths.harperLoggingDir, { recursive: true });
  const fsExtra = join(harper, "node_modules", "fs-extra");
  writePackage(fsExtra, { name: "fs-extra", version: "11.3.0", main: "index.js" });
  writeFileSync(join(fsExtra, "index.js"), "module.exports = {};\n");
  mkdirSync(dirname(paths.harperJs), { recursive: true });
  writeFileSync(paths.harperJs, 'console.log("5.2.8");\n');
  return { prefix, paths };
}

/** A prefix shaped like 0.54.1's: Flair and harper installed, harper's tree empty. */
function brokenPrefix() {
  const prefix = mkdtempSync(join(tmpdir(), "flair-gi-"));
  fixtures.push(prefix);
  const paths = treePaths(prefix);
  writePackage(paths.flair, { name: FLAIR_PACKAGE, version: "0.54.1", dependencies: { harper: "5.3.1" } });
  writePackage(join(paths.flair, "node_modules", "harper"), { name: "harper", version: "5.3.1" });
  return { prefix, paths };
}

/** Write `count` package directories into a prefix's global node_modules. */
function addPackages(prefix: string, count: number, namePrefix = "pkg") {
  const root = join(prefix, "lib", "node_modules");
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < count; i++) {
    const dir = join(root, `${namePrefix}-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `${namePrefix}-${i}`, version: "1.0.0" }));
  }
}

/**
 * A prefix shaped like harper 5.3.4's: harper's dependencies live in its own
 * bundled `node_modules`, so an npm summary line can count one package where
 * the disk holds four beneath harper (six in the graph with flair and harper).
 */
function bundledPrefix() {
  const prefix = mkdtempSync(join(tmpdir(), "flair-gi-bundled-"));
  fixtures.push(prefix);
  const paths = treePaths(prefix);
  writePackage(paths.flair, { name: FLAIR_PACKAGE, version: "0.0.1", dependencies: { harper: "5.3.4" } });
  const harper = join(paths.flair, "node_modules", "harper");
  const bundled = ["bundled-0", "bundled-1", "bundled-2", "@scope/bundled-scoped"];
  writePackage(harper, {
    name: "harper",
    version: "5.3.4",
    dependencies: Object.fromEntries(bundled.map((name) => [name, "1.0.0"])),
  });
  for (const name of bundled) {
    writePackage(join(harper, "node_modules", name), { name, version: "1.0.0" });
  }
  return { prefix, paths };
}

/**
 * A prefix whose fs-extra resolve lands OUTSIDE the installed tree: the copy sits
 * in an ancestor `node_modules`, exactly the ambient/hoisted shape that must not
 * be accepted as "harper has a dependency tree".
 */
function hoistedPrefix() {
  const root = mkdtempSync(join(tmpdir(), "flair-gi-hoist-"));
  fixtures.push(root);
  const prefix = join(root, "global-prefix");
  const paths = treePaths(prefix);
  writePackage(paths.flair, { name: FLAIR_PACKAGE, version: "0.0.1" });
  mkdirSync(paths.harperLoggingDir, { recursive: true });
  const ambient = join(root, "node_modules", "fs-extra");
  writePackage(ambient, { name: "fs-extra", version: "11.3.0", main: "index.js" });
  writeFileSync(join(ambient, "index.js"), "module.exports = {};\n");
  mkdirSync(dirname(paths.harperJs), { recursive: true });
  writeFileSync(paths.harperJs, 'console.log("5.2.8");\n');
  return { prefix, paths, ambient };
}

describe("check-global-install-lockfile — registry mode (flair#1686)", () => {
  test("builds an exact-version spec, never a dist-tag", () => {
    expect(registryInstallSpec("0.54.2")).toBe(`${FLAIR_PACKAGE}@0.54.2`);
    expect(registryInstallSpec("1.0.0-rc.1")).toBe(`${FLAIR_PACKAGE}@1.0.0-rc.1`);
    // The canary must install the version it was dispatched for, not whatever
    // `latest`/`staged` resolves to; the spec is a pinned version string.
    expect(registryInstallSpec("0.54.2").endsWith("@latest")).toBe(false);
    expect(registryInstallSpec("0.54.2").endsWith("@staged")).toBe(false);
  });

  test("refuses a non-semver input rather than installing an unintended spec", () => {
    expect(() => registryInstallSpec("latest")).toThrow(/semver/);
    expect(() => registryInstallSpec("0.54")).toThrow(/semver/);
    expect(() => registryInstallSpec("@tpsdev-ai/flair@0.54.2")).toThrow(/semver/);
    expect(() => registryInstallSpec("")).toThrow(/semver/);
  });
});

describe("check-global-install-lockfile — parsing", () => {
  test("treePaths points at the flair package inside the global prefix", () => {
    const paths = treePaths("/tmp/prefix");
    expect(paths.flair).toBe("/tmp/prefix/lib/node_modules/@tpsdev-ai/flair");
    expect(paths.globalNodeModules).toBe("/tmp/prefix/lib/node_modules");
    expect(paths.harperJs).toBe(join(paths.flair, "node_modules", "harper", "dist", "bin", "harper.js"));
    expect(paths.harperLoggingDir).toBe(join(paths.flair, "node_modules", "harper", "dist", "utility", "logging"));
  });

  test("parseAddedCount reads npm's summary line", () => {
    expect(parseAddedCount(HEALTHY_LOG)).toBe(543);
    expect(parseAddedCount("added 1 package in 1s")).toBe(1);
    expect(parseAddedCount("up to date, audited 2 packages")).toBeNull();
  });

  test("hasDamagedLockfileWarning catches npm's reify wording", () => {
    expect(hasDamagedLockfileWarning(BROKEN_LOG)).toBe(true);
    expect(hasDamagedLockfileWarning(HEALTHY_LOG)).toBe(false);
  });
});

describe("the reviewed floor (flair#1683)", () => {
  test("lives in .github/install-weight-budget.json, not in the script", () => {
    const budget = JSON.parse(readFileSync(join(REPO, BUDGET_REL), "utf8"));
    expect(Number.isInteger(budget.minPackages)).toBe(true);
    expect(readMinPackages(REPO)).toBe(budget.minPackages);
  });

  // Measured with npm 11.19.1 (the canary pin) on 2026-10-23: this branch at
  // d55695aa → 492; origin/main at 0c24e5ce (harper 5.3.1) → 520. npm 10.9.4
  // measured 492 and 492.
  const HEAD_MEASURED = 492;
  const MAIN_MEASURED = 520;

  test("sits below both measured trees and above the broken shape", () => {
    expect(MIN).toBeLessThan(HEAD_MEASURED);
    expect(MIN).toBeLessThan(MAIN_MEASURED);
    expect(MIN).toBeGreaterThan(50); // 0.54.1's collapsed tree
    expect(MIN).toBeGreaterThan(Math.floor(Math.min(HEAD_MEASURED, MAIN_MEASURED) * 0.9)); // a 10% collapse still trips it
  });

  test("a budget without the field is an error, never a silent zero floor", () => {
    const root = mkdtempSync(join(tmpdir(), "flair-gi-budget-"));
    fixtures.push(root);
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(join(root, BUDGET_REL), JSON.stringify({ maxBytes: 1, maxPackages: 1 }));
    expect(() => readMinPackages(root)).toThrow(/minPackages/);
  });
});

describe("the count follows Flair's dependency graph, not the prefix", () => {
  test("counts bundled copies under the package that declares them", () => {
    const { paths } = bundledPrefix();
    // Flair + harper + 3 bundled + @scope/bundled-scoped.
    expect(countFlairTree(paths.flair, paths.globalNodeModules)).toBe(6);

    // The synthetic npm summary below counts one; the graph holds six. The floor must read the graph.
    const result = evaluateInstall({ status: 0, log: "added 1 package in 2s", paths, minPackages: 6 });
    expect(result.added).toBe(1);
    expect(result.measured).toBe(6);
    expect(result.failures.join("\n")).not.toContain("dependency tree collapsed");
  });

  test("unrelated packages in the prefix are never counted", () => {
    const { prefix, paths } = healthyPrefix();
    addPackages(prefix, 200, "decoy");
    // The decoys are siblings of @tpsdev-ai/flair in lib/node_modules.
    expect(countFlairTree(paths.flair, paths.globalNodeModules)).toBe(3);
  });

  test("a collapsed Flair tree padded with decoy manifests stays below the floor and fails", () => {
    const prefix = mkdtempSync(join(tmpdir(), "flair-gi-collapse-"));
    fixtures.push(prefix);
    const paths = treePaths(prefix);
    writePackage(paths.flair, {
      name: FLAIR_PACKAGE,
      version: "0.0.1",
      dependencies: { "dep-a": "1.0.0", "dep-b": "1.0.0" },
    });
    for (const name of ["dep-a", "dep-b"]) {
      writePackage(join(paths.flair, "node_modules", name), { name, version: "1.0.0" });
    }
    addPackages(prefix, 500, "decoy");

    // 500 manifests sit in the prefix; only Flair and its two dependencies count.
    expect(countFlairTree(paths.flair, paths.globalNodeModules)).toBe(3);
    const result = evaluateInstall({ status: 0, log: HEALTHY_LOG, paths, minPackages: MIN });
    expect(result.measured).toBe(3);
    const joined = result.failures.join("\n");
    expect(joined).toContain("installed Flair tree has 3 packages");
    expect(joined).toContain(`below the ${MIN} floor`);
    expect(joined).toContain("dependency tree collapsed");
  });

  test("a required dependency that does not resolve fails, naming it", () => {
    const { paths } = healthyPrefix();
    writePackage(paths.flair, { name: FLAIR_PACKAGE, version: "0.0.1", dependencies: { "absent-dep": "1.0.0" } });
    expect(() => countFlairTree(paths.flair, paths.globalNodeModules)).toThrow(/absent-dep/);
  });

  test("an absent optional dependency is skipped", () => {
    const { paths } = healthyPrefix();
    writePackage(paths.flair, {
      name: FLAIR_PACKAGE,
      version: "0.0.1",
      dependencies: { harper: "5.3.4" },
      optionalDependencies: { "absent-optional": "1.0.0" },
    });
    expect(countFlairTree(paths.flair, paths.globalNodeModules)).toBe(3);
  });

  test("a package candidate with no manifest fails, naming the path", () => {
    const { paths } = healthyPrefix();
    mkdirSync(join(paths.flair, "node_modules", "dep-a"), { recursive: true });
    writePackage(paths.flair, { name: FLAIR_PACKAGE, version: "0.0.1", dependencies: { "dep-a": "1.0.0" } });
    expect(() => countFlairTree(paths.flair, paths.globalNodeModules)).toThrow(/dep-a.*package\.json/);
  });

  test("a malformed manifest fails, naming the path", () => {
    const { paths } = healthyPrefix();
    const dep = join(paths.flair, "node_modules", "dep-a");
    mkdirSync(dep, { recursive: true });
    writeFileSync(join(dep, "package.json"), "{not json");
    writePackage(paths.flair, { name: FLAIR_PACKAGE, version: "0.0.1", dependencies: { "dep-a": "1.0.0" } });
    expect(() => countFlairTree(paths.flair, paths.globalNodeModules)).toThrow(/cannot parse .*dep-a.*package\.json/);
  });

  test("an unreadable manifest fails for root too, naming the path", () => {
    const { paths } = healthyPrefix();
    const dep = join(paths.flair, "node_modules", "dep-a");
    // A directory where the manifest belongs: readFileSync fails with EISDIR,
    // which root does not bypass (chmod 000 would).
    mkdirSync(join(dep, "package.json"), { recursive: true });
    writePackage(paths.flair, { name: FLAIR_PACKAGE, version: "0.0.1", dependencies: { "dep-a": "1.0.0" } });
    expect(() => countFlairTree(paths.flair, paths.globalNodeModules)).toThrow(/cannot read .*dep-a.*package\.json/);
  });

  test("resolution stops at the install prefix, so an ambient copy is not counted", () => {
    const base = mkdtempSync(join(tmpdir(), "flair-gi-ambient-"));
    fixtures.push(base);
    const paths = treePaths(join(base, "prefix"));
    writePackage(paths.flair, { name: FLAIR_PACKAGE, version: "0.0.1", dependencies: { "ambient-dep": "1.0.0" } });
    writePackage(join(base, "node_modules", "ambient-dep"), { name: "ambient-dep", version: "1.0.0" });
    expect(() => countFlairTree(paths.flair, paths.globalNodeModules)).toThrow(/ambient-dep/);
  });
});

describe("check-global-install-lockfile — the exit status is checked first", () => {
  test("a nonzero npm status fails before the tree is evaluated", () => {
    const { paths } = healthyPrefix();
    const result = evaluateInstall({ status: 254, log: HEALTHY_LOG, paths, minPackages: FIXTURE_FLOOR });
    expect(result.ok).toBe(false);
    expect(result.measured).toBeNull();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("exited with status 254");
  });

  test("a missing npm status fails too", () => {
    const { paths } = healthyPrefix();
    const result = evaluateInstall({ status: undefined, log: HEALTHY_LOG, paths, minPackages: FIXTURE_FLOOR });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain("status none");
  });
});

describe("check-global-install-lockfile — the four checks", () => {
  test("a healthy install passes all four", () => {
    const { paths } = healthyPrefix();
    const result = evaluateInstall({ status: 0, log: HEALTHY_LOG, paths, minPackages: FIXTURE_FLOOR });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.added).toBe(543);
    expect(result.measured).toBe(3);
    expect(result.harper.ok).toBe(true);
    expect(result.harper.version).toBe("5.2.8");
    expect(result.fsExtra.ok).toBe(true);
    expect(result.fsExtra.resolved?.startsWith(paths.flair)).toBe(true);
  });

  test("a 0.54.1-shaped install fails all four, each named", () => {
    const { paths } = brokenPrefix();
    const result = evaluateInstall({ status: 0, log: BROKEN_LOG, paths, minPackages: 5 });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(4);
    const joined = result.failures.join("\n");
    expect(joined).toContain("invalid or damaged lockfile");
    expect(joined).toContain("installed Flair tree has 2 packages");
    expect(joined).toContain("below the 5 floor");
    expect(joined).toContain('npm reported "added 50"');
    expect(joined).toContain("require.resolve('fs-extra')");
    expect(joined).toContain("node harper.js version failed");
  });

  test("a healthy tree with a damaged-lockfile log still fails (the log is evidence)", () => {
    const { paths } = healthyPrefix();
    const result = evaluateInstall({
      status: 0,
      log: `${BROKEN_LOG.split("\n")[0]}\n\nadded 543 packages in 9s`,
      paths,
      minPackages: FIXTURE_FLOOR,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("invalid or damaged lockfile");
  });

  test("with exit status 0, a log without a summary line is information, not a failure", () => {
    const { paths } = healthyPrefix();
    const result = evaluateInstall({ status: 0, log: "npm ERR! something", paths, minPackages: FIXTURE_FLOOR });
    expect(result.added).toBeNull();
    expect(result.measured).toBe(3);
    expect(result.ok).toBe(true);
  });

  test("the package floor is configurable (local probing can tighten it)", () => {
    const { paths } = healthyPrefix();
    expect(evaluateInstall({ status: 0, log: HEALTHY_LOG, paths, minPackages: 1000 }).failures.join("\n")).toContain(
      "installed Flair tree has 3 packages",
    );
  });

  test("an install with no minPackages at all is a programming error, not a free pass", () => {
    const { paths } = healthyPrefix();
    // @ts-expect-error — the floor is required; the reviewed value comes from readMinPackages().
    expect(() => evaluateInstall({ status: 0, log: HEALTHY_LOG, paths })).toThrow(/minPackages/);
  });
});

describe("resolveFromLoggingDir requires the hit to be inside the tree", () => {
  test("a resolvable copy OUTSIDE the installed tree fails, naming the resolver", () => {
    const { paths, ambient } = hoistedPrefix();
    const resolved = resolveFromLoggingDir(paths);
    expect(resolved.ok).toBe(false);
    expect(resolved.resolved?.startsWith(ambient)).toBe(true);
    expect(resolved.error).toContain("outside the installed tree");

    const result = evaluateInstall({ status: 0, log: HEALTHY_LOG, paths, minPackages: FIXTURE_FLOOR });
    expect(result.fsExtra.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("require.resolve('fs-extra')");
  });

  test("no fs-extra resolvable anywhere fails too, naming the resolver", () => {
    const { paths } = brokenPrefix();
    const resolved = resolveFromLoggingDir(paths);
    // Either MODULE_NOT_FOUND or a hit outside the tree — both are failures, and
    // which one it is depends on whether an ancestor of os.tmpdir() has fs-extra.
    expect(resolved.ok).toBe(false);
    expect(resolved.error).toBeTruthy();
    expect(
      evaluateInstall({ status: 0, log: BROKEN_LOG, paths, minPackages: FIXTURE_FLOOR }).failures.join("\n"),
    ).toContain("require.resolve('fs-extra')");
  });
});

// The real-npm test below runs five child processes (three `npm pack`, one
// `npm install`, and the gate script, which installs again). Each direct
// child is sent SIGKILL at REAL_NPM_TIMEOUT_MS (SIGKILL, not the default
// SIGTERM: the sync spawn waits for the child to exit), and the test declares
// its own timeout covering all five plus margin, so Bun's 5 s default does
// not cut it short. This bounds the test, not the shared unit step.
const REAL_NPM_TIMEOUT_MS = 60_000;
const REAL_NPM_CHILDREN = 5;
const REAL_NPM_TEST_TIMEOUT_MS = REAL_NPM_CHILDREN * REAL_NPM_TIMEOUT_MS + 30_000;

/** Pack a tiny package directory into `dest` with the real npm, returning the tarball path. */
function packFixturePackage(dir: string, manifest: Record<string, unknown>, dest: string): string {
  writePackage(dir, manifest);
  const packed = execFileSync("npm", ["pack", "--silent", "--pack-destination", dest], {
    cwd: dir,
    encoding: "utf8",
    timeout: REAL_NPM_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const name = packed
    .trim()
    .split("\n")
    .filter(Boolean)
    .pop();
  if (!name) throw new Error("npm pack printed no filename");
  return join(dest, name);
}

describe("check-global-install-lockfile — real npm", () => {
  test("an install that fails while a tree remains is refused, naming the exit status", () => {
    const root = mkdtempSync(join(tmpdir(), "flair-gi-realm-"));
    fixtures.push(root);
    const prefix = join(root, "prefix");

    // First install succeeds and leaves a real tree at the prefix.
    const depTgz = packFixturePackage(join(root, "fixture-dep-a"), { name: "dep-a", version: "1.0.0" }, root);
    const good = packFixturePackage(
      join(root, "fixture-good"),
      { name: FLAIR_PACKAGE, version: "0.0.1", dependencies: { "dep-a": `file:${depTgz}` } },
      root,
    );
    const first = spawnSync("npm", ["install", "-g", "--prefix", prefix, good], {
      encoding: "utf8",
      timeout: REAL_NPM_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    expect(first.status).toBe(0);
    expect(existsSync(join(treePaths(prefix).flair, "package.json"))).toBe(true);

    // A package whose dependency points at a missing local tarball: npm exits
    // nonzero and leaves the prefix holding its earlier tree.
    const bad = packFixturePackage(
      join(root, "fixture-bad"),
      {
        name: FLAIR_PACKAGE,
        version: "0.0.2",
        dependencies: { "dep-b": `file:${join(root, "missing-dep-b-1.0.0.tgz")}` },
      },
      root,
    );
    const run = spawnSync(
      nodeBin(),
      [join(REPO, "scripts/check-global-install-lockfile.mjs"), "--package", bad, "--prefix", prefix],
      { encoding: "utf8", timeout: REAL_NPM_TIMEOUT_MS, killSignal: "SIGKILL" },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("exited with status");
    expect(run.stderr).toMatch(/exited with status [1-9]/);
  }, REAL_NPM_TEST_TIMEOUT_MS);
});
