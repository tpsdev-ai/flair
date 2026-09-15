/**
 * global-install-lockfile.test.ts — flair#1683 regression lane, unit half.
 *
 * `scripts/check-global-install-lockfile.mjs` is the CI gate that would have
 * caught 0.54.1 (a global install that exits 0 but leaves harper with no
 * dependency tree). These tests pin its pure logic and, against a synthetic
 * healthy/broken prefix, the four checks themselves. The end-to-end proof
 * against the real published 0.54.1 tarball lives in the PR body.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MIN_PACKAGES,
  evaluateInstall,
  hasDamagedLockfileWarning,
  parseAddedCount,
  treePaths,
} from "../../scripts/check-global-install-lockfile.mjs";

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

  test("the floor sits below the good baseline and above the broken shape", () => {
    expect(MIN_PACKAGES).toBe(500);
    expect(MIN_PACKAGES).toBeLessThan(543); // 0.53.0, the last good release
    expect(MIN_PACKAGES).toBeGreaterThan(50); // 0.54.1
  });
});

describe("check-global-install-lockfile — the four checks", () => {
  test("a healthy install passes all four", () => {
    const { paths } = healthyPrefix();
    const result = evaluateInstall({ log: HEALTHY_LOG, paths });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.added).toBe(543);
    expect(result.harper.ok).toBe(true);
    expect(result.harper.version).toBe("5.2.8");
    expect(result.fsExtra.ok).toBe(true);
  });

  test("a 0.54.1-shaped install fails all four, each named", () => {
    const { paths } = brokenPrefix();
    const result = evaluateInstall({ log: BROKEN_LOG, paths });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(4);
    const joined = result.failures.join("\n");
    expect(joined).toContain("invalid or damaged lockfile");
    expect(joined).toContain("added 50 packages, below the 500 floor");
    expect(joined).toContain("require.resolve('fs-extra')");
    expect(joined).toContain("node harper.js version failed");
  });

  test("a healthy tree with a damaged-lockfile log still fails (the log is evidence)", () => {
    const { paths } = healthyPrefix();
    const result = evaluateInstall({ log: `${BROKEN_LOG.split("\n")[0]}\n\nadded 543 packages in 9s`, paths });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("invalid or damaged lockfile");
  });

  test("a missing 'added N packages' line is a failure, not a silent pass", () => {
    const { paths } = healthyPrefix();
    const result = evaluateInstall({ log: "npm ERR! something", paths });
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("no \"added N packages\" line");
  });

  test("the package floor is configurable (CI can tighten it)", () => {
    const { paths } = healthyPrefix();
    expect(evaluateInstall({ log: HEALTHY_LOG, paths, minPackages: 1000 }).failures.join("\n")).toContain(
      "added 543 packages, below the 1000 floor",
    );
  });
});
