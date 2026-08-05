// The leak backstop in test/helpers/harper-lifecycle.ts.
//
// WHY IT EXISTS, measured on rockit 2026-08-05: after a night of integration
// runs, NINE orphaned `flair-test-*` trees totalling 27 GB, held open by four
// abandoned `harper dev` processes — two of them four days old. The disk reached
// zero bytes and NO command could run at all, because every tool writes an output
// file before it executes.
//
// `stopHarper` was never wrong. It simply was not called: when a `beforeAll`
// throws or times out, `afterAll` does not run, and the spawned Harper survives
// holding its install tree open. Deleting the directories would not have helped
// on its own — a file held open by a live process does not return its blocks.
//
// These are structural checks. The behavioural one (spawn a Harper, kill the
// runner, assert nothing survives) needs a live Harper and belongs in the
// integration lane; what is asserted here is that the mechanism is WIRED, which
// is the half that silently rots.
import { describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countStaleHarperTrees } from "../helpers/harper-lifecycle.js";

const SRC = readFileSync(join(import.meta.dir, "..", "helpers", "harper-lifecycle.ts"), "utf8");

// Scan code, not prose — this file's own comments name every identifier below,
// and a raw scan would pass on a file that had none of them.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the backstop is wired, not merely defined", () => {
  test("startHarper registers the instance before returning", () => {
    // Registration must happen on the success path. A backstop that only runs
    // when startHarper THROWS misses the case that actually leaked: a successful
    // start followed by a beforeAll timeout somewhere else.
    expect(CODE).toMatch(/LIVE_INSTANCES\.add\(/);
    const addAt = CODE.indexOf("LIVE_INSTANCES.add(");
    const returnAt = CODE.indexOf("return {\n        httpURL, opsURL, installDir, process: proc");
    expect(addAt).toBeGreaterThan(-1);
    if (returnAt > -1) expect(addAt).toBeLessThan(returnAt);
  });

  test("stopHarper deregisters, so a clean stop cannot leave a stale entry", () => {
    // Without this, the exit hook holds a pid that may have been reused by an
    // unrelated process by the time the runner exits — and SIGKILLs it.
    expect(CODE).toMatch(/LIVE_INSTANCES\.delete\(inst\.__tracked\)/);
  });

  test("the exit hook covers signals, not just a clean exit", () => {
    // `bun test` interrupted, or a CI runner cancelling the job, is exactly when
    // a leak is most likely — an exit-only hook would miss all of it.
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) expect(CODE).toContain(sig);
    expect(CODE).toMatch(/process\.on\("exit", reapLiveInstances\)/);
  });

  test("the reaper is synchronous — an exit handler cannot await", () => {
    // rm/kill promises would be abandoned mid-flight at process exit, which is
    // the shape of a fix that looks right and does nothing.
    expect(CODE).toMatch(/function reapLiveInstances\(\): void/);
    expect(CODE).toMatch(/rmSync\(/);
    expect(CODE).toMatch(/process\.kill\(inst\.pid, "SIGKILL"\)/);
    const reaper = CODE.slice(CODE.indexOf("function reapLiveInstances"), CODE.indexOf("function installExitHook"));
    expect(reaper).not.toMatch(/await |async /);
  });

  test("it kills the process before removing the directory", () => {
    // Order is load-bearing: blocks held open by a live process are not returned
    // by unlinking the path. Removing first would report success and free nothing
    // — which is precisely what my manual cleanup did before I found the pids.
    const reaper = CODE.slice(CODE.indexOf("function reapLiveInstances"), CODE.indexOf("function installExitHook"));
    expect(reaper.indexOf("process.kill")).toBeLessThan(reaper.indexOf("rmSync"));
  });

  test("it only removes directories the harness created", () => {
    // A caller-supplied installDir (the downgrade lanes share one across two
    // starts) belongs to the caller. Reaping it would delete a tree another test
    // is still using.
    const reaper = CODE.slice(CODE.indexOf("function reapLiveInstances"), CODE.indexOf("function installExitHook"));
    expect(reaper).toMatch(/inst\.owns/);
  });
});

describe("countStaleHarperTrees — so a leak is visible before the disk is gone", () => {
  test("counts flair-test-* trees in the temp dir", () => {
    const before = countStaleHarperTrees();
    const d = mkdtempSync(join(tmpdir(), "flair-test-"));
    try {
      expect(countStaleHarperTrees()).toBe(before + 1);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
    expect(countStaleHarperTrees()).toBe(before);
  });

  test("does not count unrelated temp directories", () => {
    const before = countStaleHarperTrees();
    const d = mkdtempSync(join(tmpdir(), "flair-something-else-"));
    try {
      expect(countStaleHarperTrees()).toBe(before);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
