/**
 * test/unit/check-dep-ages.test.ts — test the collectDeps function in
 * scripts/lib/check-dep-ages-collect.mjs against literal fixture inputs, and
 * the CLI's fail-closed exit codes against a fixture repo:
 *    exit 2: dead registry (FLAIR_NPM_REGISTRY=http://127.0.0.1:1)
 *    exit 1: too-fresh dep (a fixture registry in this process that reports
 *            the dep as published "now", against the default 7-day policy)
 *
 * The CLI cases spawn `node scripts/check-dep-ages.mjs` directly. The script
 * path is derived from this file's location, never from the working directory,
 * and a broken setup (a missing script, a fixture that was not written, a
 * registry that did not bind) throws before the CLI runs. It can never pass as
 * exit 1: `node` exits 1 on a missing entry file too, which is why every CLI
 * case also asserts the gate's own diagnostic, and the too-fresh cases the
 * request the gate made to the fixture registry.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectDeps } from "../../scripts/lib/check-dep-ages-collect.mjs";

/* ─────────────────────────── Unit tests ───────────────────────────── */

describe("collectDeps", () => {
  const keepCurrent = new Set(["harper", "some-skip"]);

  // Helper: build a pkg with only `dependencies` (no optionalDeps, no peerDeps)
  const pkgsDeps = (deps: Record<string,string>, p: string) => [
    { pkg: { dependencies: deps }, path: p },
  ];
  const pkgsOpts = (deps: Record<string,string>, p: string) => [
    { pkg: { optionalDependencies: deps }, path: p },
  ];
  const pkgsPeer = (deps: Record<string,string>, p: string) => [
    { pkg: { peerDependencies: deps }, path: p },
  ];

  /* dependencies */
  describe("dependencies", () => {
    it("collects an exact dependencies pin", () => {
      const result = collectDeps(pkgsDeps({"some-pkg":"1.2.3"},"packages/foo/package.json"), keepCurrent);
      expect(result.size).toBe(1);
      expect(result.get("some-pkg@1.2.3")).toEqual({
        name: "some-pkg", version: "1.2.3",
        declaredIn: ["packages/foo/package.json"],
       });
     });
   });

   /* optionalDependencies */
  describe("optionalDependencies", () => {
    it("collects exact optional pin with correct declaredIn", () => {
      const result = collectDeps(pkgsOpts({"some-opt":"4.5.6"},"packages/bar/package.json"), keepCurrent);
      expect(result.size).toBe(1);
      expect(result.get("some-opt@4.5.6")).toEqual({
        name: "some-opt", version: "4.5.6",
        declaredIn: ["packages/bar/package.json"],
       });
     });
    it("skips an optional range like ^1.2.3", () => {
      expect(collectDeps(pkgsOpts({"some-opt":"^1.2.3"},"packages/bar/package.json"), keepCurrent).size).toBe(0);
     });
    it("skips an optional @tpsdev-ai/* pin", () => {
      expect(collectDeps(pkgsOpts({"@tpsdev-ai/internal":"1.0.0"},"packages/internal/package.json"), keepCurrent).size).toBe(0);
     });
   });

   /* peerDependencies */
  describe("peerDependencies", () => {
    it("does NOT collect an exact peerDependencies pin", () => {
      expect(collectDeps(pkgsPeer({"some-peer":"7.8.9"},"packages/peer/package.json"), keepCurrent).size).toBe(0);
     });
   });

   /* cross-package dedup */
  describe("cross-package dedup", () => {
    it("one entry for same name@version in two packages", () => {
      const result = collectDeps([
           { pkg: { dependencies: {"shared-pkg":"2.0.0"} }, path: "packages/a/package.json" },
           { pkg: { optionalDependencies: {"shared-pkg":"2.0.0"} }, path: "packages/b/package.json" },
        ], keepCurrent);
      expect(result.size).toBe(1);
      expect(result.get("shared-pkg@2.0.0")!.declaredIn.sort()).toEqual([
           "packages/a/package.json", "packages/b/package.json",
        ]);
     });
   });
});

/* ───────────── CLI fail-closed exit tests ─────────────────────────── */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_SCRIPT = join(REPO_ROOT, "scripts", "check-dep-ages.mjs");
const COLLECT_LIB = join(REPO_ROOT, "scripts", "lib", "check-dep-ages-collect.mjs");

/** The one exact external pin every fixture repo declares. */
const FIXTURE_DEP = "fixture-dep";
const FIXTURE_VERSION = "1.0.0";
/** A positive policy: a dep published "now" is too fresh under it. */
const MIN_AGE_DAYS = "7";

/** A broken test setup fails as itself, never as the CLI exit a case expects. */
function setupFailure(what: string): never {
  throw new Error(`test setup failed before the gate ran: ${what}`);
}

let scratch = "";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "flair-dep-ages-"));
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** Write a repo root with one exact external pin and an empty packages/ dir. */
function writeFixtureRepo(root: string): string {
  mkdirSync(join(root, "packages"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "dep-ages-fixture",
    version: "0.0.0",
    dependencies: { [FIXTURE_DEP]: FIXTURE_VERSION },
  }));
  if (!existsSync(join(root, "package.json"))) setupFailure(`fixture package.json not written under ${root}`);
  return root;
}

/**
 * Run the gate as its own process. Async on purpose: the too-fresh cases serve
 * the child's registry request from this same process, and a synchronous spawn
 * would block that server's event loop. The env is built explicitly (no
 * ambient FLAIR_* can change the policy, the keep-current list or the root).
 */
async function runGate(script: string, extraEnv: Record<string, string>) {
  if (!existsSync(script)) setupFailure(`gate script not found at ${script}`);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    FLAIR_DEP_MIN_AGE_DAYS: MIN_AGE_DAYS,
    ...extraEnv,
  };
  const proc = Bun.spawn(["node", script], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, output: stdout + stderr };
}

/** A registry that reports FIXTURE_VERSION as published at the moment of the request. */
function freshRegistry() {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      requests.push(new URL(req.url).pathname);
      return Response.json({ time: { [FIXTURE_VERSION]: new Date().toISOString() } });
    },
  });
  if (!server.port) setupFailure("fixture registry did not bind a port");
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

describe("CLI fail-closed exit — dead registry", () => {
  it("exits 2 when FLAIR_NPM_REGISTRY is unreachable", async () => {
    const root = writeFixtureRepo(join(scratch, "dead-registry"));
    const { exitCode, output } = await runGate(CLI_SCRIPT, {
      FLAIR_CHECK_DEP_AGES_ROOT: root,
      FLAIR_NPM_REGISTRY: "http://127.0.0.1:1",
    });
    expect(output).toContain("Failed to fetch publish times");
    expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}:`);
    expect(exitCode).toBe(2);
  }, 30_000);
});

describe("CLI fail-closed exit — too-fresh dep", () => {
  it("exits 1 when a dep was published now, under a 7-day policy", async () => {
    const root = writeFixtureRepo(join(scratch, "too-fresh"));
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(CLI_SCRIPT, {
        FLAIR_CHECK_DEP_AGES_ROOT: root,
        FLAIR_NPM_REGISTRY: registry.url,
      });
      // The gate asked the fixture registry, and reported the dep as too fresh.
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`]);
      expect(output).toContain("Pinned production deps younger than the bake-time policy");
      expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}`);
      expect(output).toContain("declared in package.json");
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);

  it("resolves its default root from its own location, through a path with a space", async () => {
    // The documented downstream install: both files copied, relative layout kept,
    // no FLAIR_CHECK_DEP_AGES_ROOT. The gate must find the package.json one level
    // above its own scripts/ dir even though the path contains a space.
    const root = writeFixtureRepo(join(scratch, "downstream repo"));
    mkdirSync(join(root, "scripts", "lib"), { recursive: true });
    const script = join(root, "scripts", "check-dep-ages.mjs");
    copyFileSync(CLI_SCRIPT, script);
    copyFileSync(COLLECT_LIB, join(root, "scripts", "lib", "check-dep-ages-collect.mjs"));
    const registry = freshRegistry();
    try {
      const { exitCode, output } = await runGate(script, { FLAIR_NPM_REGISTRY: registry.url });
      expect(registry.requests).toEqual([`/${FIXTURE_DEP}`]);
      expect(output).toContain("Pinned production deps younger than the bake-time policy");
      expect(output).toContain(`${FIXTURE_DEP}@${FIXTURE_VERSION}`);
      expect(exitCode).toBe(1);
    } finally {
      registry.stop();
    }
  }, 30_000);
});
