/**
 * test/unit/check-dep-ages.test.ts — test the collectDeps function in
 * scripts/lib/check-dep-ages-collect.mjs against literal fixture inputs.
 *
 * Also tests the CLI script's fail-closed exit codes:
 *    exit 2: dead registry (FLAIR_NPM_REGISTRY=http://127.0.0.1:1)
 *    exit 1: too-fresh dep (via a bash helper that starts a local server)
 *
 * Rationale for the bash helper on the too-fresh test:
 *   A `node` child from `bun test` cannot connect to `Bun.serve` on the
 *   same machine. The bash helper starts a separate `node` HTTP server (not
 *   Bun.serve) and runs the CLI against it — which avoids the TCP restriction.
 */

import { describe, expect, it } from "bun:test";
import { collectDeps } from "../../scripts/lib/check-dep-ages-collect.mjs";
import { spawnSync } from "child_process";

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

/*
 * The too-fresh test uses a bash helper script
 * (test/fixtures/run-ffi-check.sh) because a `node` child process from
 * `bun test` cannot make network connections to `Bun.serve` on the same
 * machine. The helper starts a `node` HTTP server, waits, and runs the
 * CLI against it — avoiding the TCP restriction by using a *separate*
 * server implementation.
 */
const CLI_SCRIPT =
  process.cwd() + "/scripts/check-dep-ages.mjs";

describe("CLI fail-closed exit — dead registry", () => {
  it("exits 2 when FLAIR_NPM_REGISTRY is unreachable", () => {
    const result = spawnSync("node", [CLI_SCRIPT], {
      env: { ...process.env, FLAIR_NPM_REGISTRY: "http://127.0.0.1:1" },
      timeout: 60_000,
      stdio: ["inherit", "pipe", "pipe"],
      });
    expect(result.status).toBe(2);
    const combined = Buffer.from(result.stdout).toString()
        + Buffer.from(result.stderr).toString();
    expect(combined).toContain("Failed to fetch publish times");
    });
});

describe("CLI fail-closed exit — too-fresh dep", () => {
  it("exits 1 when a dep's publish time is now (via local server)", () => {
     // Run the bash helper script. It:
     //    1. Creates a tiny fixture repo with one exact dep (pkg-dep@1.0.0)
     //    2. Starts a node HTTP server returning publish-time = "now"
     //    3. Runs CLI with FLAIR_CHECK_DEP_AGES_ROOT + FLAIR_NPM_REGISTRY
     //    4. Expects EXIT:1
    const result = spawnSync("bash", [
      process.cwd() + "/test/fixtures/run-ffi-check.sh",
      ], {
      timeout: 60_000,
      stdio: ["inherit", "pipe", "pipe"],
      });
    expect(result.status).toBe(1);
    });
});
