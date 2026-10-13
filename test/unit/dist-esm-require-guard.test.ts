/**
 * dist-esm-require-guard.test.ts — proves the flair#1657 guard is a control.
 *
 * flair#1653 shipped a `require("node:fs")` in an ESM command module next to
 * its entry's top-level await. Node reported ERR_AMBIGUOUS_MODULE_SYNTAX only
 * at runtime, so the source suite (bun tolerates require in ESM) stayed green
 * and nothing checked the emitted dist/. scripts/check-dist-esm-require.mjs
 * closes that gap; these tests exist so the guard itself cannot regress into a
 * check that never fires.
 *
 * The fixtures are built in a temp dir and the checker is run as a subprocess
 * under the real `node` binary — the same runtime the shipped CLI uses. The
 * last block pins the CI wiring so the lane cannot be deleted or softened
 * (continue-on-error / `|| true`) without failing here.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { load as loadYaml } from "js-yaml";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-dist-esm-require.mjs");
const TEST_YML = readFileSync(join(REPO_ROOT, ".github", "workflows", "test.yml"), "utf8");

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Materialize a fixture tree and return its root directory. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "flair-dist-esm-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function runGuard(dir: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8", timeout: 20_000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Pull one top-level job block out of test.yml by its key. */
function jobBlock(key: string): string {
  const marker = `\n  ${key}:`;
  const at = TEST_YML.indexOf(marker);
  expect(at, `job "${key}" must exist in test.yml`).toBeGreaterThan(-1);
  const rest = TEST_YML.slice(at + marker.length);
  const next = rest.search(/\n  [a-z0-9-]+:/);
  return TEST_YML.slice(at, next === -1 ? TEST_YML.length : at + marker.length + next);
}

describe("check-dist-esm-require — it fires on the hazard (flair#1657)", () => {
  test("mixed: a module with require() and its own top-level await names both lines", () => {
    const dir = fixture({
      "mixed.js": [
        "export function probe() {",
        '  const { readFileSync } = require("node:fs");',
        "  return readFileSync;",
        "}",
        "await Promise.resolve(1);",
        "export const main = () => probe();",
      ].join("\n"),
    });

    const { status, out } = runGuard(dir);
    expect(status).toBe(1);
    expect(out).toMatch(/ERR_AMBIGUOUS_MODULE_SYNTAX/);
    expect(out).toMatch(/mixed\.js:2/); // require()
    expect(out).toMatch(/mixed\.js:5/); // top-level await
  });

  test("escape: the exact #1653 shape — require in one module, top-level await in its entry", () => {
    const dir = fixture({
      "probe.js": [
        "export function probe() {",
        '  return require("node:fs");',
        "}",
      ].join("\n"),
      "entry.js": [
        'import { probe } from "./probe.js";',
        "await Promise.resolve(1);",
        "export const run = () => probe();",
      ].join("\n"),
    });

    const { status, out } = runGuard(dir);
    expect(status).toBe(1);
    // The require-only module must be named, not just the awaiting entry.
    expect(out).toMatch(/probe\.js:2/);
    expect(out).toMatch(/entry\.js:2/);
    expect(out).toMatch(/ERR_AMBIGUOUS_MODULE_SYNTAX/);
  });

  test("walks nested directories", () => {
    const dir = fixture({
      "commands/session.js": [
        "export function list() {",
        '  return require("node:fs");',
        "}",
        "await Promise.resolve(1);",
      ].join("\n"),
    });

    const { status, out } = runGuard(dir);
    expect(status).toBe(1);
    expect(out).toMatch(/commands[\\/]session\.js:2/);
  });
});

describe("check-dist-esm-require — it does not fire on clean code", () => {
  test("require() present but no top-level await anywhere", () => {
    const dir = fixture({
      "plain.js": 'export function f() { return require("node:fs"); }\nexport const x = 1;\n',
    });
    expect(runGuard(dir).status).toBe(0);
  });

  test("top-level await present but no require()", () => {
    const dir = fixture({
      "await.js": "export const x = await Promise.resolve(1);\n",
    });
    expect(runGuard(dir).status).toBe(0);
  });

  test("require() inside a function does not count as top-level await", () => {
    const dir = fixture({
      "nested.js": [
        "export async function f() {",
        '  const fs = require("node:fs");',
        "  return fs;",
        "}",
        "export const x = 1;",
      ].join("\n"),
    });
    expect(runGuard(dir).status).toBe(0);
  });

  test("detection is structural: comments and strings that mention require() do not trip it", () => {
    const dir = fixture({
      "mention.js": [
        '// require("node:fs") is described here',
        'export const s = "require(\'node:fs\')";',
        "await Promise.resolve(1);",
      ].join("\n"),
    });
    expect(runGuard(dir).status).toBe(0);
  });

  test("createRequire() is not a require() call", () => {
    const dir = fixture({
      "create-require.js": [
        'import { createRequire } from "node:module";',
        "const req = createRequire(import.meta.url);",
        "await Promise.resolve(1);",
        'export const fs = req("node:fs");',
      ].join("\n"),
    });
    expect(runGuard(dir).status).toBe(0);
  });

  test("ignores CommonJS .cjs modules", () => {
    const dir = fixture({
      "legacy.cjs": 'module.exports = function () { return require("node:fs"); };\n',
      "await.js": "export const x = await Promise.resolve(1);\n",
    });
    expect(runGuard(dir).status).toBe(0);
  });
});

describe("check-dist-esm-require — corpus safety (a check that scans nothing must not pass)", () => {
  test("a missing target directory fails", () => {
    const dir = fixture({ "keep.txt": "not a module\n" });
    expect(runGuard(join(dir, "does-not-exist")).status).toBe(1);
  });

  test("an empty target (no .js/.mjs modules) fails rather than passing vacuously", () => {
    const dir = fixture({ "readme.txt": "no modules here\n" });
    const { status, out } = runGuard(dir);
    expect(status).toBe(1);
    expect(out).toMatch(/refusing to pass vacuously/i);
  });
});

describe("check-dist-esm-require — CI wiring", () => {
  const job = jobBlock("dist-esm-guard");

  test("a CI job runs the checker against a built dist", () => {
    expect(job).toContain("scripts/check-dist-esm-require.mjs");
    // flair#2540 — pack-smoke and dist-esm-guard share the build job's artifact.
    expect(job).toContain("name: flair-dist");
    const builder = jobBlock("build");
    expect(builder).toMatch(/bun run build\b/);
    expect(builder).toMatch(/bun run build:cli\b/);
    expect(builder).toContain("name: flair-dist");
  });

  test("the lane is not softened", () => {
    // Ignore comment lines: the job's own warning comment names the patterns
    // it forbids, which would otherwise trip this assertion.
    const body = job
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(body).not.toContain("continue-on-error");
    expect(body).not.toMatch(/\|\|\s*true/);
    expect(body).not.toMatch(/\|\|\s*echo/);
  });
});

describe("install-weight — docs-only workflow contract", () => {
  type Job = { if?: string; needs?: unknown; steps: { if?: string; run?: string }[] };
  const workflow = loadYaml(TEST_YML) as { jobs: Record<string, Job> };
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { files: string[] };
  const job = workflow.jobs["install-weight"];

  test("docs-only PRs do not skip install-weight", () => {
    expect(manifest.files).toContain("docs/");
    expect(manifest.files).toContain("README.md");
    expect(job).toBeDefined();
    expect(job.if).toBeUndefined();
    expect(job.needs).toBeUndefined();
    const measurement = job.steps.find((step) => step.run?.includes("scripts/check-install-weight.mjs"));
    expect(measurement).toBeDefined();
    expect(measurement?.if).toBeUndefined();
  });

  test.each(manifest.files)("shipped manifest entry %s cannot trigger a docs-only install-weight skip", (path) => {
    expect(path.length).toBeGreaterThan(0);
    expect(job.if).toBeUndefined();
    expect(job.needs).toBeUndefined();
    for (const step of job.steps) expect(step.if ?? "").not.toContain("docs_only");
  });
});

describe("shared dist consumers — dependency setup", () => {
  type Step = { uses?: string; run?: string; if?: unknown; with?: Record<string, string> };
  const workflow = loadYaml(TEST_YML) as { jobs: Record<string, { steps?: Step[] }> };
  const consumers = Object.entries(workflow.jobs).filter(([, job]) =>
    job.steps?.some((step) => step.uses?.startsWith("actions/download-artifact@") && step.with?.name === "flair-dist"),
  );

  test("pack-smoke and dist-esm-guard download the shared dist", () => {
    expect(consumers.map(([name]) => name)).toEqual(["pack-smoke", "dist-esm-guard"]);
  });

  for (const [name, job] of consumers) {
    test(`${name} installs frozen dependencies before consuming shared dist`, () => {
      const steps = job.steps ?? [];
      const bun = steps.findIndex((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
      const cache = steps.findIndex((step) => step.uses?.startsWith("actions/cache@") && step.with?.path?.includes("node_modules"));
      const install = steps.findIndex((step) => step.run === "sfw bun install --frozen-lockfile");
      const download = steps.findIndex((step) => step.uses?.startsWith("actions/download-artifact@") && step.with?.name === "flair-dist");
      expect(bun).toBeGreaterThanOrEqual(0);
      expect(cache).toBeGreaterThan(bun);
      expect(steps[cache].with).toEqual({
        path: "node_modules\npackages/*/node_modules\n",
        key: "node-modules-${{ runner.os }}-${{ hashFiles('bun.lock') }}",
        "restore-keys": "node-modules-${{ runner.os }}-\n",
      });
      expect(install).toBeGreaterThan(cache);
      expect(download).toBeGreaterThan(install);
      expect(steps[install].if).toBeUndefined();
      expect(steps.some((step) => /bun run build/.test(step.run ?? ""))).toBe(false);
      const checks = steps.flatMap((step, index) => /node scripts\/check-(imports|dist-esm-require)\.mjs dist/.test(step.run ?? "") ? [index] : []);
      expect(checks.length).toBeGreaterThan(0);
      for (const check of checks) expect(check).toBeGreaterThan(download);
    });
  }
});
