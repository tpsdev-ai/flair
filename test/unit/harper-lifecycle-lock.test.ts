// flair#1440 — the Harper restart lock race.
//
// The harness restarts Harper once per question. It worked 489 times and failed
// on the 490th with "Resource temporarily unavailable" on
// <installDir>/database/flair/LOCK. The previous Harper had not released the
// RocksDB lock when the next `install` ran, because the code waited for the
// process to EXIT — and exit is observable but insufficient: Harper's detached
// child services hold the LOCK and outlive the parent by a beat.
//
// The fix makes `stopHarper` wait for the LOCK to be free (bounded), not for the
// process to exit. These tests pin the mechanism directly with a real POSIX
// (fcntl) lock holder, so they are deterministic — the 1-in-500 race itself is
// exercised in the integration lane (harper-lifecycle-restart-lock.test.ts), where
// a live Harper is available.
import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForLocksFree } from "../helpers/harper-lifecycle.js";

const SRC = readFileSync(join(import.meta.dir, "..", "helpers", "harper-lifecycle.ts"), "utf8");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** A fake install tree with a single RocksDB LOCK at database/system/LOCK. */
function makeLockTree(): { dir: string; lock: string } {
  const dir = mkdtempSync(join(tmpdir(), "flair-lock-test-"));
  const dbDir = join(dir, "database", "system");
  mkdirSync(dbDir, { recursive: true });
  const lock = join(dbDir, "LOCK");
  writeFileSync(lock, "");
  return { dir, lock };
}

/** Hold a POSIX (fcntl) record lock in a detached process (python3 fcntl.lockf).
 *  RocksDB uses fcntl(F_SETLK), NOT flock(2) — so the holder must use fcntl too. */
function holdLock(lock: string): ChildProcess {
  const script = `import fcntl,time\nf=open(${JSON.stringify(lock)},'r+')\nfcntl.lockf(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\ntime.sleep(30)`;
  return spawn("python3", ["-c", script], { detached: true, stdio: "ignore" });
}

/** Release the lock by killing the whole process group. */
function releaseLock(holder: ChildProcess): void {
  if (holder.pid) { try { process.kill(-holder.pid, "SIGKILL"); } catch { /* already gone */ } }
}

describe("waitForLocksFree is wired into stopHarper", () => {
  test("stopHarper waits for the lock when the install dir is kept", () => {
    const fn = CODE.slice(CODE.indexOf("export async function stopHarper"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toMatch(/waitForLocksFree\(/);
  });

  test("the wait is bounded — a timeout is named, not an infinite loop", () => {
    expect(CODE).toMatch(/LOCK_WAIT_TIMEOUT_MS/);
    expect(CODE).toMatch(/throw new Error\(`Harper database lock still held/);
  });

  test("the lock is probed, never deleted or force-cleared", () => {
    // The refusal authority: deleting a LOCK file is data loss wearing a fix.
    // The only filesystem write here is the flock probe itself.
    expect(CODE).not.toMatch(/unlink.*LOCK|rm.*LOCK|truncate.*LOCK/);
  });
});

describe("waitForLocksFree (flair#1440)", () => {
  test("resolves once the lock is released", async () => {
    const { dir, lock } = makeLockTree();
    const holder = holdLock(lock);
    try {
      await new Promise((r) => setTimeout(r, 200)); // let the holder acquire
      const wait = waitForLocksFree(dir, 5000);
      setTimeout(() => releaseLock(holder), 300);
      await wait; // must resolve, not throw
    } finally {
      releaseLock(holder);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws naming the lock when it stays held (positive control)", async () => {
    const { dir, lock } = makeLockTree();
    const holder = holdLock(lock);
    try {
      await new Promise((r) => setTimeout(r, 200));
      await expect(waitForLocksFree(dir, 500)).rejects.toThrow(/LOCK/);
    } finally {
      releaseLock(holder);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolves immediately when no database lock exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-lock-test-"));
    try {
      await waitForLocksFree(dir, 1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
