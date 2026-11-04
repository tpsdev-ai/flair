/**
 * migrations-lock.test.ts — resources/migrations/lock.ts's single-flight
 * guard: in-process mutex + stale-tolerant file lock (Kern verdict: "flock
 * on well-known path; dead-holder → break and proceed").
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, renameSync, rmSync, existsSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { probeMigrationDataDir } from "../../resources/migrations/data-dir.ts";
import { acquireMigrationLock, _resetInProcessLockForTests, migrationLockStillHeld, DEFAULT_STALE_MS, defaultIsProcessAlive } from "../../resources/migrations/lock.ts";

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
  it("fails with ENOENT when the candidate is removed after the probe", () => {
    expect(probeMigrationDataDir(testRoot).ok).toBe(true);
    rmSync(testRoot, { recursive: true });
    let error: unknown;
    try { acquireMigrationLock({ lockPath }); } catch (err) { error = err; }
    expect((error as NodeJS.ErrnoException)?.code).toBe("ENOENT");
    expect(existsSync(testRoot)).toBe(false);
  });

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

  it("release() does not remove a lock record replaced under its pathname", () => {
    const first = acquireMigrationLock({ lockPath });
    expect(first.acquired).toBe(true);
    const replacement = { pid: 424242, hostname: "host-b", startedAt: "2026-01-01T00:00:00.000Z" };
    // A sibling file renamed over the lock pathname gives the lock a new
    // inode and a different holder; the device stays the same.
    const temp = join(testRoot, ".migrations", `.replacement.${process.pid}.tmp`);
    writeFileSync(temp, JSON.stringify(replacement));
    renameSync(temp, lockPath);

    if (first.acquired) first.release();

    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf-8"))).toEqual(replacement);
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
    if (first.acquired) first.release();
  });

  it("breaks the lock when another local pid is dead, even if the file is fresh", () => {
    mkdirSync(join(testRoot, ".migrations"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, hostname: hostname(), startedAt: "2026-01-01T00:00:00.000Z" }));
    const second = acquireMigrationLock({ lockPath, isProcessAlive: () => false });
    expect(second.acquired).toBe(true);
    if (second.acquired) second.release();
  });

  it("does NOT break this module's live handle when the file is older than staleMs", () => {
    const first = acquireMigrationLock({ lockPath });
    expect(first.acquired).toBe(true);
    _resetInProcessLockForTests();

    // The live handle protects this module's record despite its old mtime.
    const old = new Date(Date.now() - DEFAULT_STALE_MS - 60_000);
    utimesSync(lockPath, old, old);

    const second = acquireMigrationLock({ lockPath, isProcessAlive: () => true });
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.reason).toContain(`held by pid ${process.pid}`);
      expect(second.reason).toContain(hostname());
      expect(second.reason).toContain(lockPath);
    }
    if (first.acquired) first.release();
  });

  it("does NOT probe a local pid for a holder recorded on another host", () => {
    mkdirSync(join(testRoot, ".migrations"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 424242, hostname: "host-b", startedAt: "2026-01-01T00:00:00.000Z" }));

    // Fresh file, and isProcessAlive would say dead: only age decides for a
    // remote holder, so the lock is still held.
    const result = acquireMigrationLock({ lockPath, isProcessAlive: () => false });
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.reason).toContain("on host-b");
  });

  it("breaks a holder recorded on another host by age alone", () => {
    mkdirSync(join(testRoot, ".migrations"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 424242, hostname: "host-b", startedAt: "2026-01-01T00:00:00.000Z" }));
    const old = new Date(Date.now() - DEFAULT_STALE_MS - 60_000);
    utimesSync(lockPath, old, old);

    const result = acquireMigrationLock({ lockPath, isProcessAlive: () => false });
    expect(result.acquired).toBe(true);
    if (result.acquired) result.release();
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
    if (first.acquired) first.release();
  });

  it("refuses a corrupt/unparseable lock file instead of breaking it", () => {
    mkdirSync(join(testRoot, ".migrations"), { recursive: true });
    writeFileSync(lockPath, "not json");

    const result = acquireMigrationLock({ lockPath });
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.reason).toContain("MigrationLockUnreadableError");
    expect(readFileSync(lockPath, "utf-8")).toBe("not json");
  });

  it("refuses an incomplete holder record instead of breaking it", () => {
    mkdirSync(join(testRoot, ".migrations"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));

    const result = acquireMigrationLock({ lockPath });
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.reason).toContain("MigrationLockUnreadableError");
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe("defaultIsProcessAlive — probe classification (flair#2866)", () => {
  it("answers false when the probe reports ESRCH", () => {
    const proc = Bun.spawnSync(["true"]);
    expect(defaultIsProcessAlive(proc.pid)).toBe(false);
  });

  it("answers true when the probe reports EPERM (the process exists)", () => {
    const original = process.kill;
    (process as unknown as { kill: unknown }).kill = () => {
      const err = new Error("operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    };
    try {
      expect(defaultIsProcessAlive(1234)).toBe(true);
    } finally {
      (process as unknown as { kill: unknown }).kill = original;
    }
  });

  it("refuses acquisition by name when the probe fails for another reason", () => {
    mkdirSync(join(testRoot, ".migrations"), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid + 1, hostname: hostname(), startedAt: "2026-01-01T00:00:00.000Z" }),
    );
    const original = process.kill;
    (process as unknown as { kill: unknown }).kill = () => {
      const err = new Error("invalid argument") as NodeJS.ErrnoException;
      err.code = "EINVAL";
      throw err;
    };
    try {
      const result = acquireMigrationLock({ lockPath });
      expect(result.acquired).toBe(false);
      if (!result.acquired) expect(result.reason).toContain("MigrationLockProbeError");
    } finally {
      (process as unknown as { kill: unknown }).kill = original;
    }
  });
});

describe("acquireMigrationLock — touch()", () => {
  it("touch() leaves a successor installed before the heartbeat unchanged", () => {
    const first = acquireMigrationLock({ lockPath });
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;

    const replacement = { pid: 424242, hostname: "host-b", startedAt: "2026-01-01T00:00:00.000Z" };
    const bytes = JSON.stringify(replacement);
    const temp = join(testRoot, ".migrations", `.replacement.${process.pid}.tmp`);
    writeFileSync(temp, bytes);
    renameSync(temp, lockPath);
    const past = new Date(Date.now() - 10_000);
    utimesSync(lockPath, past, past);
    const mtime = statSync(lockPath).mtimeMs;

    first.touch();

    expect(readFileSync(lockPath, "utf-8")).toBe(bytes);
    expect(statSync(lockPath).mtimeMs).toBe(mtime);
    first.release();
  });

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

describe("acquireMigrationLock — directory mutex (flair#2866)", () => {
  const generation = "0123456789abcdef";
  const guardPath = () => `${lockPath}.guard`;

  function writeGuard(holder: Record<string, unknown>): void {
    mkdirSync(join(testRoot, ".migrations"), { recursive: true, mode: 0o700 });
    mkdirSync(guardPath(), { mode: 0o700 });
    writeFileSync(join(guardPath(), `owner-${generation}.json`), JSON.stringify(holder));
  }

  it("leaves the mutex directory empty while the handle is held and after release", () => {
    const result = acquireMigrationLock({ lockPath });
    expect(result.acquired).toBe(true);
    expect(existsSync(guardPath())).toBe(true);
    expect(readdirSync(guardPath())).toEqual([]);
    if (result.acquired) result.release();
    expect(readdirSync(guardPath())).toEqual([]);
  });

  it("refuses to change the lock while a live local mutex owner holds it", () => {
    writeGuard({ pid: process.pid, hostname: hostname(), startedAt: "2026-01-01T00:00:00.000Z", generation });

    const result = acquireMigrationLock({ lockPath, isProcessAlive: () => true });
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.reason).toContain("mutex is held by pid");
    expect(readdirSync(guardPath())).toEqual([`owner-${generation}.json`]);
  });

  it("a released handle whose record still exists is not still-held", () => {
    const result = acquireMigrationLock({ lockPath });
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;
    // A live local owner holds the mutex, so release cannot remove the lock
    // record this handle wrote.
    writeFileSync(
      join(guardPath(), `owner-${generation}.json`),
      JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: "2026-01-01T00:00:00.000Z", generation }),
    );

    result.release();

    expect(existsSync(lockPath)).toBe(true);
    expect(migrationLockStillHeld(result)).toBe(false);
  });

  it("recovers a dead mutex generation by removing only its owner entry", () => {
    writeGuard({ pid: 424242, hostname: hostname(), startedAt: "2026-01-01T00:00:00.000Z", generation });

    const result = acquireMigrationLock({ lockPath, isProcessAlive: () => false });
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      expect(readdirSync(guardPath())).toEqual([]);
      result.release();
    }
    expect(readdirSync(guardPath())).toEqual([]);
  });

  it("reports an owner-entry unlink failure after finding a holder as error", () => {
    mkdirSync(join(testRoot, ".migrations"), { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, hostname: hostname(), startedAt: new Date().toISOString() }));
    let inspected = false;
    const result = acquireMigrationLock({
      lockPath,
      isProcessAlive: () => {
        inspected = true;
        const guard = `${lockPath}.guard`;
        const owner = join(guard, readdirSync(guard)[0]);
        unlinkSync(owner);
        mkdirSync(owner);
        return true;
      },
    });
    expect(inspected).toBe(true);
    expect(result.acquired).toBe(false);
    if (result.acquired) throw new Error("expected refusal");
    expect(result.kind).toBe("error");
    expect(result.reason).toContain("could not be released");
    expect(result.reason).toContain("cannot be removed");
  });

  it("refuses a mutex directory with an unexpected entry", () => {
    mkdirSync(join(testRoot, ".migrations"), { recursive: true, mode: 0o700 });
    mkdirSync(guardPath(), { mode: 0o700 });
    writeFileSync(join(guardPath(), "junk.txt"), "not an owner record");

    const result = acquireMigrationLock({ lockPath });
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.reason).toContain("MigrationLockMutexError");
  });

  it("refuses an owner entry whose generation does not match its filename", () => {
    mkdirSync(join(testRoot, ".migrations"), { recursive: true, mode: 0o700 });
    mkdirSync(guardPath(), { mode: 0o700 });
    writeFileSync(
      join(guardPath(), `owner-${generation}.json`),
      JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: "2026-01-01T00:00:00.000Z", generation: "fedcba9876543210" }),
    );

    const result = acquireMigrationLock({ lockPath });
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.reason).toContain("MigrationLockMutexError");
  });
});
