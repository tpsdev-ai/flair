/**
 * dist-freshness.test.ts — flair#2583.
 *
 * startHarper loads the COMPILED dist/resources/*.js, so a resource edit with
 * no rebuild would run the previous build. These tests pin the preflight that
 * refuses to start against a stale/missing dist, using a synthetic Flair-shaped
 * tree (resources/ + tsconfig.json + dist/) whose mtimes are set directly — no
 * real build is needed and nothing in the worktree is touched.
 *
 * The refusal is asserted through the REAL startHarper (test/helpers/
 * harper-lifecycle.ts), which is the seam under test; it throws before any
 * install or spawn, so the case stays fast and leaks no flair-test-* tree.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertFlairDistFresh, distFreshnessIssues, isFlairSourceRoot } from "../helpers/dist-freshness.js";
import { startHarper } from "../helpers/harper-lifecycle.js";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
});

/** A second, in epoch milliseconds, offset from a fixed base. */
const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");
const OLD = BASE_MS;
const NEW = BASE_MS + 60_000;

function write(path: string, contents = "x\n"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

/** Stamp every file under `dir` with `mtimeMs`. */
function stamp(dir: string, mtimeMs: number): void {
  const at = new Date(mtimeMs);
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    return;
  }
  if (isDir) {
    for (const name of readdirSync(dir)) stamp(join(dir, name), mtimeMs);
  } else {
    utimesSync(dir, at, at);
  }
}

interface Fixture {
  root: string;
}

/**
 * Build a fresh Flair-shaped tree: every input mtime is OLD and every built
 * output mtime is NEW (fresh, like CI after a build).
 */
function makeTree(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "flair-2583-fixture-"));
  roots.push(root);
  write(join(root, "resources", "foo.ts"));
  write(join(root, "tsconfig.json"), '{ "include": ["resources/**/*.ts"] }\n');
  write(join(root, "package.json"), '{ "name": "flair-fixture" }\n');
  write(join(root, "bun.lock"));
  write(join(root, "scripts", "write-build-info.mjs"));
  write(join(root, "src", "cli.ts"));
  write(join(root, "tsconfig.cli.json"), '{ "include": ["src/cli.ts"] }\n');
  write(join(root, "dist", "resources", "foo.js"));
  write(join(root, "dist", "build-info.json"), "{}\n");
  write(join(root, "dist", "cli.js"));
  for (const input of ["resources", "tsconfig.json", "package.json", "bun.lock", "scripts", "src", "tsconfig.cli.json"]) {
    stamp(join(root, input), OLD);
  }
  for (const output of ["dist/resources", "dist/build-info.json", "dist/cli.js"]) {
    stamp(join(root, output), NEW);
  }
  return { root };
}

describe("dist freshness (flair#2583)", () => {
  it("a fresh tree has no issues and does not throw", () => {
    const { root } = makeTree();
    expect(distFreshnessIssues(root)).toEqual([]);
    expect(() => assertFlairDistFresh(root)).not.toThrow();
  });

  it("a resource newer than the build is reported, naming the source and the command", () => {
    const { root } = makeTree();
    stamp(join(root, "resources", "foo.ts"), NEW + 60_000);
    const issues = distFreshnessIssues(root);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("resources/foo.ts");
    expect(issues[0].message).toContain("newer than the oldest built resource");
    expect(issues[0].remedy).toBe("bun run build");
    expect(() => assertFlairDistFresh(root)).toThrow(/dist\/ was not built from the current sources/);
  });

  it("a missing dist/resources is reported", () => {
    const { root } = makeTree();
    rmSync(join(root, "dist", "resources"), { recursive: true, force: true });
    const issues = distFreshnessIssues(root);
    expect(issues.some((i) => i.message.includes("dist/resources contains no built resources"))).toBe(true);
  });

  it("a missing dist/cli.js is detected with the build:cli remedy", () => {
    const { root } = makeTree();
    rmSync(join(root, "dist", "cli.js"));
    const issues = distFreshnessIssues(root);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("dist/cli.js is missing");
    expect(issues[0].remedy).toBe("bun run build:cli");
  });

  it("a src newer than dist/cli.js is reported (bun run build wipes the CLI)", () => {
    const { root } = makeTree();
    stamp(join(root, "src", "cli.ts"), NEW + 60_000);
    const issues = distFreshnessIssues(root);
    expect(issues.some((i) => i.message.includes("src/cli.ts") && i.remedy === "bun run build:cli")).toBe(true);
  });

  it("a tree without tsconfig.json is not the Flair source tree and is skipped", () => {
    const { root } = makeTree();
    rmSync(join(root, "tsconfig.json"));
    rmSync(join(root, "dist"), { recursive: true, force: true });
    expect(isFlairSourceRoot(root)).toBe(false);
    expect(() => assertFlairDistFresh(root)).not.toThrow();
  });

  it("startHarper refuses a stale tree before spawning and leaks no scratch dir", async () => {
    const { root } = makeTree();
    stamp(join(root, "resources", "foo.ts"), NEW + 60_000);
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("flair-test-")));
    await expect(startHarper({ cwd: root, harperBinDir: root })).rejects.toThrow(/refusing to start Harper/);
    const leaked = readdirSync(tmpdir()).filter((n) => n.startsWith("flair-test-") && !before.has(n));
    expect(leaked).toEqual([]);
  });
});
