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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BUDGET_REL,
  FLAIR_PACKAGE,
  evaluateInstall,
  hasDamagedLockfileWarning,
  parseAddedCount,
  readMinPackages,
  registryInstallSpec,
  resolveFromLoggingDir,
  treePaths,
} from "../../scripts/check-global-install-lockfile.mjs";

const REPO = join(import.meta.dir, "../..");
/** The reviewed floor, read the same way CI reads it. */
const MIN = readMinPackages(REPO);

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

/**
 * A prefix shaped like a real `npm install -g` tree: harper present with a
 * resolvable fs-extra sibling and a working entrypoint.
 */
function healthyPrefix() {
  const prefix = mkdtempSync(join(tmpdir(), "flair-gi-"));
  fixtures.push(prefix);
  const paths = treePaths(prefix);
  mkdirSync(paths.harperLoggingDir, { recursive: true });
  const fsExtra = join(paths.flair, "node_modules", "harper", "node_modules", "fs-extra");
  mkdirSync(fsExtra, { recursive: true });
  writeFileSync(join(fsExtra, "package.json"), JSON.stringify({ name: "fs-extra", version: "11.3.0", main: "index.js" }));
  writeFileSync(join(fsExtra, "index.js"), "module.exports = {};\n");
  mkdirSync(dirname(paths.harperJs), { recursive: true });
  writeFileSync(paths.harperJs, 'console.log("5.2.8");\n');
  return { prefix, paths };
}

/** A prefix shaped like 0.54.1's: the @tpsdev-ai/flair dir exists, harper has nothing. */
function brokenPrefix() {
  const prefix = mkdtempSync(join(tmpdir(), "flair-gi-"));
  fixtures.push(prefix);
  const paths = treePaths(prefix);
  mkdirSync(paths.flair, { recursive: true });
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
  mkdirSync(paths.harperLoggingDir, { recursive: true });
  const ambient = join(root, "node_modules", "fs-extra");
  mkdirSync(ambient, { recursive: true });
  writeFileSync(join(ambient, "package.json"), JSON.stringify({ name: "fs-extra", version: "11.3.0", main: "index.js" }));
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

  test("sits below the healthy baseline and above the broken shape", () => {
    // 0.53.0 (last good release): 543 added on npm 10, 560 on npm 11.
    expect(MIN).toBeLessThan(543);
    expect(MIN).toBeGreaterThan(50); // 0.54.1, npm 10
    expect(MIN).toBeGreaterThan(44); // 0.54.1, npm 11 / macOS
    expect(MIN).toBeGreaterThan(Math.floor(543 * 0.9)); // a 10% collapse must still trip it
  });

  test("a budget without the field is an error, never a silent zero floor", () => {
    const root = mkdtempSync(join(tmpdir(), "flair-gi-budget-"));
    fixtures.push(root);
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(join(root, BUDGET_REL), JSON.stringify({ maxBytes: 1, maxPackages: 1 }));
    expect(() => readMinPackages(root)).toThrow(/minPackages/);
  });
});

describe("check-global-install-lockfile — the four checks", () => {
  test("a healthy install passes all four", () => {
    const { paths } = healthyPrefix();
    const result = evaluateInstall({ log: HEALTHY_LOG, paths, minPackages: MIN });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.added).toBe(543);
    expect(result.harper.ok).toBe(true);
    expect(result.harper.version).toBe("5.2.8");
    expect(result.fsExtra.ok).toBe(true);
    expect(result.fsExtra.resolved?.startsWith(paths.flair)).toBe(true);
  });

  test("a 0.54.1-shaped install fails all four, each named", () => {
    const { paths } = brokenPrefix();
    const result = evaluateInstall({ log: BROKEN_LOG, paths, minPackages: MIN });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(4);
    const joined = result.failures.join("\n");
    expect(joined).toContain("invalid or damaged lockfile");
    expect(joined).toContain(`added 50 packages, below the ${MIN} floor`);
    expect(joined).toContain("require.resolve('fs-extra')");
    expect(joined).toContain("node harper.js version failed");
  });

  test("a healthy tree with a damaged-lockfile log still fails (the log is evidence)", () => {
    const { paths } = healthyPrefix();
    const result = evaluateInstall({ log: `${BROKEN_LOG.split("\n")[0]}\n\nadded 543 packages in 9s`, paths, minPackages: MIN });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("invalid or damaged lockfile");
  });

  test("a missing 'added N packages' line is a failure, not a silent pass", () => {
    const { paths } = healthyPrefix();
    const result = evaluateInstall({ log: "npm ERR! something", paths, minPackages: MIN });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain('no "added N packages" line');
  });

  test("the package floor is configurable (local probing can tighten it)", () => {
    const { paths } = healthyPrefix();
    expect(evaluateInstall({ log: HEALTHY_LOG, paths, minPackages: 1000 }).failures.join("\n")).toContain(
      "added 543 packages, below the 1000 floor",
    );
  });

  test("an install with no minPackages at all is a programming error, not a free pass", () => {
    const { paths } = healthyPrefix();
    // @ts-expect-error — the floor is required; the reviewed value comes from readMinPackages().
    expect(() => evaluateInstall({ log: HEALTHY_LOG, paths })).toThrow(/minPackages/);
  });
});

describe("resolveFromLoggingDir requires the hit to be inside the tree", () => {
  test("a resolvable copy OUTSIDE the installed tree fails, naming the resolver", () => {
    const { paths, ambient } = hoistedPrefix();
    const resolved = resolveFromLoggingDir(paths);
    expect(resolved.ok).toBe(false);
    expect(resolved.resolved?.startsWith(ambient)).toBe(true);
    expect(resolved.error).toContain("outside the installed tree");

    const result = evaluateInstall({ log: HEALTHY_LOG, paths, minPackages: MIN });
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
    expect(evaluateInstall({ log: BROKEN_LOG, paths, minPackages: MIN }).failures.join("\n")).toContain(
      "require.resolve('fs-extra')",
    );
  });
});
