/**
 * bundled-descriptors.test.ts — flair#1580 pack/install.
 *
 * The unpublished `@tpsdev-ai/flair-tool-descriptors` package is a runtime
 * dep of `@tpsdev-ai/flair` and `@tpsdev-ai/flair-mcp`. Without bundling,
 * `npm install` of a packed tarball 404s on the registry (the pack-smoke /
 * install-weight / upgrade-smoke / MCP-wiring failure on PR #1598).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLED_NAME,
  buildDescriptors,
  materializeBundledDescriptors,
} from "../../scripts/materialize-bundled-descriptors.mjs";

const REPO = join(import.meta.dir, "../..");
const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bundled flair-tool-descriptors (flair#1580 pack/install)", () => {
  test("root and flair-mcp declare the dep, bundle it, and prepack materializes it", () => {
    const root = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    const mcp = JSON.parse(readFileSync(join(REPO, "packages/flair-mcp/package.json"), "utf8"));
    expect(root.dependencies[BUNDLED_NAME]).toBe(root.version);
    expect(mcp.dependencies[BUNDLED_NAME]).toBe(mcp.version);
    expect(root.bundleDependencies).toEqual([BUNDLED_NAME]);
    expect(mcp.bundleDependencies).toEqual([BUNDLED_NAME]);
    expect(root.scripts.prepack).toBe("node scripts/materialize-bundled-descriptors.mjs");
    expect(mcp.scripts.prepack).toBe("node ../../scripts/materialize-bundled-descriptors.mjs");
  });

  test("every Dockerfile that npm pack COPYs the prepack script (flair#1580)", () => {
    const dockerDir = join(REPO, "docker");
    const packers = readdirSync(dockerDir)
      .filter((name) => name.startsWith("Dockerfile"))
      .filter((name) => readFileSync(join(dockerDir, name), "utf8").includes("npm pack"));
    expect(packers.length, "expected at least the two pack-in-image Dockerfiles").toBeGreaterThanOrEqual(2);
    for (const name of packers) {
      const text = readFileSync(join(dockerDir, name), "utf8");
      expect(
        text,
        `${name} must COPY materialize-bundled-descriptors.mjs — prepack MODULE_NOT_FOUND otherwise`,
      ).toContain("materialize-bundled-descriptors.mjs");
    }
  });

  test("buildDescriptors emits dist via tsc without bun or a workspace link", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-bundle-build-"));
    fixtures.push(dir);
    const src = join(REPO, "packages/flair-tool-descriptors");
    const pkg = join(dir, "pkg");
    for (const entry of ["package.json", "tsconfig.json", "src", "LICENSE", "README.md"]) {
      cpSync(join(src, entry), join(pkg, entry), { recursive: true });
    }
    expect(existsSync(join(pkg, "dist", "index.js"))).toBe(false);
    buildDescriptors(pkg, REPO);
    expect(existsSync(join(pkg, "dist", "index.js"))).toBe(true);
  });

  test("materialize writes publishable files into a real node_modules tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-bundle-desc-"));
    fixtures.push(dir);
    const dest = materializeBundledDescriptors(dir, REPO);
    expect(dest).toBe(join(dir, "node_modules", "@tpsdev-ai", "flair-tool-descriptors"));
    expect(existsSync(join(dest, "dist", "index.js"))).toBe(true);
    expect(existsSync(join(dest, "package.json"))).toBe(true);
    expect(existsSync(join(dest, "LICENSE"))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dest, "package.json"), "utf8"));
    expect(pkg.name).toBe(BUNDLED_NAME);
    expect(pkg.dependencies ?? {}).toEqual({});
    const src = readFileSync(join(dest, "dist", "index.js"), "utf8");
    expect(src).not.toMatch(/\bharper\b/);
    expect(src).not.toMatch(/@tpsdev-ai\/flair-client/);
    expect(src).not.toMatch(/from ["']zod["']/);
  });
});
