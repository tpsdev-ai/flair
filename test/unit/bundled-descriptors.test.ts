/**
 * bundled-descriptors.test.ts — flair#1580 pack/install.
 *
 * The unpublished `@tpsdev-ai/flair-tool-descriptors` package is a runtime
 * dep of `@tpsdev-ai/flair` and `@tpsdev-ai/flair-mcp`. Without bundling,
 * `npm install` of a packed tarball 404s on the registry (the pack-smoke /
 * install-weight / upgrade-smoke / MCP-wiring failure on PR #1598).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLED_NAME,
  BUNDLED_REL,
  PACK_STAGE_EXTRAS,
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
    expect(root.scripts.prepack).toContain("node scripts/materialize-bundled-descriptors.mjs");
    expect(root.scripts.prepack).toContain("node scripts/materialize-patched-harper.mjs");
    expect(root.scripts.postpack).toBe("node scripts/materialize-patched-harper.mjs --restore");
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
      expect(text, `${name} must COPY materialize-patched-harper.mjs (flair#847)`).toContain(
        "materialize-patched-harper.mjs",
      );
      expect(text, `${name} must COPY alasql-rn-peer.mjs (flair#847)`).toContain("alasql-rn-peer.mjs");
    }
  });

  test("upgrade-liveness pack stage copies PACK_STAGE_EXTRAS (flair#1580)", () => {
    const text = readFileSync(join(REPO, "test/compat/upgrade-restart-liveness.test.ts"), "utf8");
    expect(text).toContain("PACK_STAGE_EXTRAS");
    expect(PACK_STAGE_EXTRAS).toContain("scripts/materialize-bundled-descriptors.mjs");
    expect(PACK_STAGE_EXTRAS).toContain("scripts/materialize-patched-harper.mjs");
    expect(PACK_STAGE_EXTRAS).toContain("scripts/alasql-rn-peer.mjs");
    expect(PACK_STAGE_EXTRAS).toContain(BUNDLED_REL);
  });

  test("Dockerfile.test materializes the bundled package and installs llama-cpp in the builder", () => {
    const text = readFileSync(join(REPO, "docker/Dockerfile.test"), "utf8");
    expect(text).toContain("materialize-bundled-descriptors.mjs");
    expect(text).toMatch(/node scripts\/materialize-bundled-descriptors\.mjs/);
    const builder = text.slice(0, text.indexOf("FROM node:24-slim AS test"));
    const testStage = text.slice(text.indexOf("FROM node:24-slim AS test"));
    expect(builder).toContain("@node-llama-cpp/linux-x64@3");
    expect(testStage).not.toContain("npm install --no-save @node-llama-cpp");
  });

  test("materialize CLI writes the success line to stderr, not stdout", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-bundle-cli-"));
    fixtures.push(dir);
    mkdirSync(join(dir, "packages"), { recursive: true });
    cpSync(join(REPO, BUNDLED_REL), join(dir, BUNDLED_REL), { recursive: true });
    const result = spawnSync(process.execPath, [join(REPO, "scripts/materialize-bundled-descriptors.mjs")], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`materialized ${BUNDLED_NAME}`);
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
