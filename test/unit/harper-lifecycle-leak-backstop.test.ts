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

// ─── The pid-reuse guard Sherlock's review surfaced ─────────────────────────
//
// He found the window and judged it acceptable because "the blast radius is a
// test runner process on a dev machine." True in general, FALSE on rockit: this
// machine also runs production Flair (~/flair-prod, :9926). A reused pid here
// could be prod — which is the July 2026 `pkill -f harper` incident with better
// manners.
//
// So the reaper now kills only processes that are still OUR CHILD. Production is
// not our child; neither is anything that inherited a recycled pid.
describe("the reaper kills only its own children", () => {
  const CODE = readFileSync(join(import.meta.dir, "..", "helpers", "harper-lifecycle.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  test("SIGKILL is gated on parentage, not on the pid alone", () => {
    expect(CODE).toMatch(/if \(inst\.pid && isOwnChild\(inst\.pid\)\)/);
  });

  test("the parentage check fails CLOSED", () => {
    // An unknowable pid must be left alone. A leaked directory is recoverable;
    // a killed production instance is not.
    const fn = CODE.slice(CODE.indexOf("function isOwnChild"), CODE.indexOf("function reapLiveInstances"));
    expect(fn).toMatch(/catch\s*\{\s*return false/);
  });

  test("it compares against THIS process, not a hardcoded parent", () => {
    const fn = CODE.slice(CODE.indexOf("function isOwnChild"), CODE.indexOf("function reapLiveInstances"));
    expect(fn).toMatch(/=== process\.pid/);
  });

  test("stopHarper deregisters BEFORE it kills", () => {
    // Sherlock noted the original tests asserted deregistration existed but not
    // its ordering. If the kill came first, a pid could be reused in the gap
    // while the entry was still tracked.
    const fn = CODE.slice(CODE.indexOf("export async function stopHarper"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body.indexOf("LIVE_INSTANCES.delete")).toBeLessThan(body.indexOf("killProcess"));
  });
});

// ─── The signal handler must not survive its own signal ─────────────────────
//
// Registering a handler for SIGINT/SIGTERM/SIGHUP REPLACES Node's default
// action (terminate). Re-raising while the listener is still registered
// re-enters the handler forever, and the process survives the signal it was
// told to die on.
//
// The first version of this hook did exactly that. It hung CI's Integration
// Tests for 35 minutes against a ~15 minute norm until the runner hard-killed
// the job — and it broke the very case the hook exists for, since Ctrl-C would
// no longer stop a test run.
//
// Verified in isolation both ways: re-raising while registered loops
// indefinitely; removing the listener first exits 143 (terminated by SIGTERM).
describe("the signal handler removes its listener before re-raising", () => {
  const CODE = readFileSync(join(import.meta.dir, "..", "helpers", "harper-lifecycle.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  test("removeAllListeners precedes the re-raise", () => {
    const hook = CODE.slice(CODE.indexOf("function installExitHook"), CODE.indexOf("export function countStaleHarperTrees"));
    const remove = hook.indexOf("process.removeAllListeners(sig)");
    const raise = hook.indexOf("process.kill(process.pid, sig)");
    expect(remove).toBeGreaterThan(-1);
    expect(raise).toBeGreaterThan(-1);
    expect(remove).toBeLessThan(raise);
  });

  test("the reap still happens before either", () => {
    // Order is reap -> deregister handler -> re-raise. Removing the listener
    // first would be safe but would skip the cleanup this hook exists for.
    const hook = CODE.slice(CODE.indexOf("function installExitHook"), CODE.indexOf("export function countStaleHarperTrees"));
    expect(hook.indexOf("reapLiveInstances()")).toBeLessThan(hook.indexOf("process.removeAllListeners(sig)"));
  });

  test("a re-raise-while-registered pattern loops — the property being avoided", async () => {
    // Behavioural proof rather than a claim about Node's semantics, run in a
    // child so it cannot take this suite down.
    const { spawnSync } = await import("node:child_process");
    const script = [
      "let n=0;",
      "process.on('SIGTERM',()=>{n++;if(n>4){console.log('LOOP');process.exit(9);}process.kill(process.pid,'SIGTERM');});",
      "setTimeout(()=>{console.log('NOLOOP');process.exit(0);},800);",
      "process.kill(process.pid,'SIGTERM');",
    ].join("");
    // spawnSync, not execFileSync: the loop path exits 9, and execFileSync
    // throws on a non-zero exit before the output can be read — which would
    // fail this test for the wrong reason.
    const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf-8", timeout: 15000 });
    expect(String(r.stdout)).toContain("LOOP");
  });
});
