/**
 * migrations-lock.test.ts — resources/migrations/lock.ts's single-flight
 * guard: in-process mutex + stale-tolerant file lock (Kern verdict: "flock
 * on well-known path; dead-holder → break and proceed").
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireMigrationLock, _resetInProcessLockForTests, DEFAULT_STALE_MS } from "../../resources/migrations/lock.ts";

let testRoot: string;
let lockPath: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "flair-migration-lock-test-"));
  lockPath = join(testRoot, ".migrations", "lock");
  _resetInProcessLockForTests();
});

afterEach(() => {
  _resetInProcessLockForTests();
  rmSync(testRoot, { recursive: true, force: true });
});

describe("acquireMigrationLock — basic acquire/release", () => {
  it("acquires when no lock file exists, writing pid/hostname/startedAt", () => {
    const result = acquireMigrationLock({ lockPath });
    expect(result.acquired).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    const holder = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(holder.pid).toBe(process.pid);
    expect(typeof holder.hostname).toBe("string");
    expect(typeof holder.startedAt).toBe("string");
  });

  it("release() removes the lock file and clears the in-process flag", () => {
    const first = acquireMigrationLock({ lockPath });
    expect(first.acquired).toBe(true);
    if (first.acquired) first.release();
    expect(existsSync(lockPath)).toBe(false);

    // A second acquire after release must succeed (in-process flag cleared).
    const second = acquireMigrationLock({ lockPath });
    expect(second.acquired).toBe(true);
    if (second.acquired) second.release();
  });

  it("release() is idempotent (calling it twice doesn't throw)", () => {
    const result = acquireMigrationLock({ lockPath });
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      result.release();
      expect(() => result.release()).not.toThrow();
    }
  });
});

describe("acquireMigrationLock — in-process mutex", () => {
  it("a second acquire call in the SAME process is refused while the first is held", () => {
    const first = acquireMigrationLock({ lockPath });
    expect(first.acquired).toBe(true);

    const second = acquireMigrationLock({ lockPath });
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.reason).toContain("in-process");
  });

  it("after release, a subsequent acquire in the same process succeeds", () => {
    const first = acquireMigrationLock({ lockPath });
    if (first.acquired) first.release();
    const second = acquireMigrationLock({ lockPath });
    expect(second.acquired).toBe(true);
  });
});

describe("acquireMigrationLock — stale-tolerant file lock (dead-holder break)", () => {
  it("refuses when the recorded pid is alive and the lock is fresh", () => {
    // Simulate a DIFFERENT process holding the lock: write a lock file
    // directly (bypassing this process's in-process flag) with our OWN pid
    // (guaranteed "alive") acting as a stand-in for some other live holder.
    const first = acquireMigrationLock({ lockPath });
    expect(first.acquired).toBe(true);
    _resetInProcessLockForTests(); // simulate a SEPARATE process (clears only the in-process half)

    const second = acquireMigrationLock({ lockPath, isProcessAlive: () => true });
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.reason).toContain("held by pid");
  });

  it("breaks the lock when the recorded pid is dead, even if the file is fresh", () => {
    const first = acquireMigrationLock({ lockPath });
    expect(first.acquired).toBe(true);
    _resetInProcessLockForTests();

    const second = acquireMigrationLock({ lockPath, isProcessAlive: () => false });
    expect(second.acquired).toBe(true);
  });

  it("breaks the lock when the file is older than staleMs, even if isProcessAlive would say alive", () => {
    const first = acquireMigrationLock({ lockPath });
    expect(first.acquired).toBe(true);
    _resetInProcessLockForTests();

    // Backdate the lock file's mtime past the stale threshold.
    const old = new Date(Date.now() - DEFAULT_STALE_MS - 60_000);
    utimesSync(lockPath, old, old);

    const second = acquireMigrationLock({ lockPath, isProcessAlive: () => true });
    expect(second.acquired).toBe(true);
  });

  it("does NOT break a fresh lock even with a short staleMs override once re-acquired (regression: staleMs applies per-call)", () => {
    const first = acquireMigrationLock({ lockPath, staleMs: 10_000 });
    expect(first.acquired).toBe(true);
    _resetInProcessLockForTests();

    // Immediately re-check with the SAME short staleMs — file is only
    // milliseconds old, well under 10s, and pid is genuinely alive (this
    // process) — must stay refused.
    const second = acquireMigrationLock({ lockPath, staleMs: 10_000, isProcessAlive: () => true });
    expect(second.acquired).toBe(false);
  });

  it("a corrupt/unparseable lock file is treated as dead (breaks it)", () => {
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(join(testRoot, ".migrations"), { recursive: true });
    writeFileSync(lockPath, "not json");

    const result = acquireMigrationLock({ lockPath });
    expect(result.acquired).toBe(true);
  });
});

describe("acquireMigrationLock — touch()", () => {
  it("touch() updates the lock file's mtime (heartbeat, keeps a live holder from looking stale)", async () => {
    const result = acquireMigrationLock({ lockPath });
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;

    // Backdate the lock file's mtime, then touch() and confirm it moved forward.
    const past = new Date(Date.now() - 10_000);
    utimesSync(lockPath, past, past);
    expect(statSync(lockPath).mtimeMs).toBeLessThanOrEqual(past.getTime() + 1);

    result.touch();
    expect(statSync(lockPath).mtimeMs).toBeGreaterThan(past.getTime());
  });
});
