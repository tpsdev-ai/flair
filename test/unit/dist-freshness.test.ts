import { afterAll, describe, expect, it } from "bun:test";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertFlairDistFresh, distFreshnessIssues, isFlairSourceRoot } from "../helpers/dist-freshness.js";
import { spawnCli } from "../helpers/build-cli-once.js";
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
  write(join(root, "package.json"), '{ "name": "flair-fixture", "version": "1.0.0" }\n');
  write(join(root, "bun.lock"));
  write(join(root, "scripts", "write-build-info.mjs"));
  write(join(root, "src", "cli.ts"));
  write(join(root, "tsconfig.cli.json"), '{ "include": ["src/cli.ts"] }\n');
  write(join(root, "dist", "resources", "foo.js"));
  write(join(root, "dist", "build-info.json"), "{}\n");
  write(join(root, "dist", "cli.js"), 'require("node:fs").writeFileSync(process.argv[2], "ran");\n');
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

  it("fresh resources do not require dist/cli.js or fresh CLI sources", () => {
    const { root } = makeTree();
    rmSync(join(root, "dist", "cli.js"));
    stamp(join(root, "src", "cli.ts"), NEW + 60_000);
    expect(distFreshnessIssues(root)).toEqual([]);
    expect(() => assertFlairDistFresh(root)).not.toThrow();
  });

  it("a copied tree with a null build-info commit is checked by resource mtimes", () => {
    const { root } = makeTree();
    const result = spawnSync("node", [resolve(import.meta.dirname, "../../scripts/write-build-info.mjs")], {
      cwd: root, encoding: "utf-8", timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "dist", "build-info.json"), "utf-8")).commit).toBeNull();
    rmSync(join(root, "dist", "cli.js"));
    expect(distFreshnessIssues(root)).toEqual([]);
    stamp(join(root, "resources", "foo.ts"), NEW + 60_000);
    expect(() => assertFlairDistFresh(root)).toThrow("resources/foo.ts");
  });

  for (const state of ["missing", "stale"]) {
    it(`CLI spawn refuses a ${state} dist/cli.js and names build:cli`, () => {
      const { root } = makeTree();
      const marker = join(root, "spawned");
      if (state === "missing") rmSync(join(root, "dist", "cli.js"));
      else stamp(join(root, "src", "cli.ts"), NEW + 60_000);
      expect(() => spawnCli([marker], { timeout: 2000 }, root)).toThrow(/refusing to spawn CLI:.*dist\/cli.js.*bun run build:cli/);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(root, "dist", "cli.js"))).toBe(state !== "missing");
    });
  }

  it("CLI spawn runs a fresh CLI and rechecks it on the next call", async () => {
    const { root } = makeTree();
    const marker = join(root, "spawned");
    const child = spawnCli([marker], { timeout: 2000 }, root);
    const [code, signal] = await once(child, "close");
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(readFileSync(marker, "utf-8")).toBe("ran");
    rmSync(marker);
    rmSync(join(root, "dist", "cli.js"));
    expect(() => spawnCli([marker], { timeout: 2000 }, root)).toThrow("bun run build:cli");
    expect(existsSync(marker)).toBe(false);
  }, 5000);

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
