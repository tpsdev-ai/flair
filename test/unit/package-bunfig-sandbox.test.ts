/**
 * flair#1853 round 3 — every package with Bun tests sandboxes HOME.
 *
 * The root `bunfig.toml` preload only applies to `bun test` run from the repo
 * root. CI also runs a package suite directly (`cd packages/adk-flair-js &&
 * bun test test/integration/`), and a developer running `bun test` inside a
 * package gets no sandbox at all — that process would read and write the REAL
 * home. Give every package that has Bun tests its own `bunfig.toml`, pointing
 * the preload at the shared helper, so the sandbox travels with the package.
 *
 * This is the class guard: adding a package with tests but no local bunfig turns
 * it red.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");
const HELPER_REL = join("test", "helpers", "sandbox-home.ts");

/** Every `*.test.*` file under `dir`, skipping node_modules/dist/dot dirs. */
function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (/\.test\.[jt]sx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Package directory names under `packages/` that contain Bun tests. */
function packagesWithTests(): string[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => testFiles(join(PACKAGES_DIR, name)).length > 0)
    .sort();
}

describe("every package with Bun tests sandboxes HOME (flair#1853)", () => {
  const packages = packagesWithTests();

  test("the enumeration found packages with tests (positive control)", () => {
    expect(packages.length).toBeGreaterThan(0);
  });

  for (const pkg of packages) {
    test(`${pkg} has a bunfig.toml that preloads the shared sandbox helper`, () => {
      const bunfig = join(PACKAGES_DIR, pkg, "bunfig.toml");
      expect(existsSync(bunfig)).toBe(true);

      const text = readFileSync(bunfig, "utf8");
      const match = text.match(/^\s*preload\s*=\s*\[([^\]]*)\]/m);
      expect(match).not.toBeNull();

      const specs = match![1]!
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      const helper = specs.find((s) => s.endsWith("sandbox-home.ts"));
      expect(helper).toBeDefined();

      // The preload path must resolve, from the package dir, to the shared helper.
      const resolved = join(PACKAGES_DIR, pkg, helper!);
      expect(existsSync(resolved)).toBe(true);
      expect(relative(REPO_ROOT, resolved)).toBe(HELPER_REL);
    });
  }
});
