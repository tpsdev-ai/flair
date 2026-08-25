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
import { readFileSync, mkdtempSync, rmSync, readdirSync, existsSync, utimesSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countStaleHarperTrees, startHarper, sweepStaleHarperTrees } from "../helpers/harper-lifecycle.js";
import { SCRATCH_OWNER_FILE, writeScratchOwnerStamp } from "../../src/lib/scratch-owner.js";

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

  test("the exit hook is installed for clean exits", () => {
    // Signals are deliberately NOT handled — see the no-signal-handlers block
    // below. federation-watch.test.ts SIGTERMs the runner as its fixture, so a
    // handler here truncates the suite instead of protecting it.
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

// ─── No signal handlers: the harness must not intercept its own fixtures ────
//
// An earlier version registered SIGINT/SIGTERM/SIGHUP so an interrupted run
// would still reap. It broke the suite: federation-watch.test.ts SIGTERMs the
// TEST RUNNER ITSELF as its fixture (its own comment says so), a global handler
// intercepted that, and the run died after 53 of 58 files with exit 143.
//
// A handler here is either wrong for those tests or useless for us, and "wrong"
// is silent — it truncates a suite rather than failing a test. So the exit hook
// stands alone and interrupted runs are allowed to leak, with
// countStaleHarperTrees making that visible on the next run.
describe("the harness registers no process-wide signal handlers", () => {
  const CODE = readFileSync(join(import.meta.dir, "..", "helpers", "harper-lifecycle.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  test("no process.on for SIGINT/SIGTERM/SIGHUP", () => {
    // federation-watch.test.ts signals the runner deliberately. Anything we
    // register here changes what that fixture does.
    expect(CODE).not.toMatch(/process\.on\(\s*["']SIG/);
    expect(CODE).not.toMatch(/for \(const sig of/);
  });

  test("the exit hook is still installed — clean exits must still reap", () => {
    expect(CODE).toMatch(/process\.on\("exit", reapLiveInstances\)/);
  });
});

describe("startHarper failure does not leak a scratch dir (flair#1032)", () => {
  test("an install that cannot start leaves no new flair-test-* tree", async () => {
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("flair-test-")));
    await expect(startHarper({
      cwd: "/tmp/flair-1032-no-such-cwd",
      harperBinDir: "/tmp/flair-1032-no-such-cwd",
    })).rejects.toThrow();
    const leaked = readdirSync(tmpdir()).filter((n) => n.startsWith("flair-test-") && !before.has(n));
    expect(leaked).toEqual([]);
  });

  test("boot sweep removes an abandoned flair-test-* tree", () => {
    const leftover = mkdtempSync(join(tmpdir(), "flair-test-stale-"));
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(leftover, past, past);
    try {
      const removed = sweepStaleHarperTrees({ olderThanMs: 60 * 60 * 1000 });
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(existsSync(leftover)).toBe(false);
    } finally {
      rmSync(leftover, { recursive: true, force: true });
    }
  });

  test("boot sweep does not delete a tree whose owner pid is still alive", () => {
    const live = mkdtempSync(join(tmpdir(), "flair-test-live-"));
    writeScratchOwnerStamp(live);
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(live, past, past);
    try {
      sweepStaleHarperTrees({ olderThanMs: 0 });
      expect(existsSync(live)).toBe(true);
    } finally {
      rmSync(live, { recursive: true, force: true });
    }
  });

  test("boot sweep removes a tree whose owner pid is dead", () => {
    const orphan = mkdtempSync(join(tmpdir(), "flair-test-orphan-"));
    writeFileSync(join(orphan, SCRATCH_OWNER_FILE), "999999999\n");
    try {
      const removed = sweepStaleHarperTrees({ olderThanMs: 0 });
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(existsSync(orphan)).toBe(false);
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });

  test("boot sweep does not delete a tree whose hdb.pid is still alive", () => {
    const live = mkdtempSync(join(tmpdir(), "flair-test-hdb-"));
    writeFileSync(join(live, "hdb.pid"), `${process.pid}\n`);
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(live, past, past);
    try {
      sweepStaleHarperTrees({ olderThanMs: 0 });
      expect(existsSync(live)).toBe(true);
    } finally {
      rmSync(live, { recursive: true, force: true });
    }
  });

  test("sweep unlinks a prefix-named symlink and does not touch its target", () => {
    // Pins the Node property Flint and both reviewers measured on #1408:
    // fs.rmSync({recursive:true}) lstats and unlinks a symlink — it never
    // descends into the target. A future Node that followed would fail this
    // before it deleted someone else's tree.
    const target = mkdtempSync(join(tmpdir(), "flair-1032-rmsync-target-"));
    writeFileSync(join(target, "keep-me"), "safe");
    const link = join(tmpdir(), `flair-test-symlink-${Date.now()}`);
    symlinkSync(target, link);
    try {
      sweepStaleHarperTrees({ olderThanMs: 0 });
      expect(existsSync(join(target, "keep-me"))).toBe(true);
      expect(existsSync(link)).toBe(false);
    } finally {
      try { unlinkSync(link); } catch { /* sweep already removed it */ }
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("startHarper calls the boot sweep before creating a new tree", () => {
    expect(CODE).toMatch(/sweepStaleHarperTrees\(/);
    const sweepAt = CODE.indexOf("sweepStaleHarperTrees()");
    const mkdtempAt = CODE.indexOf("mkdtemp(join(tmpdir(), \"flair-test-\")");
    expect(sweepAt).toBeGreaterThan(-1);
    expect(mkdtempAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeLessThan(mkdtempAt);
  });
});
