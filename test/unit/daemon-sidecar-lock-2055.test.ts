/**
 * daemon-sidecar-lock-2055.test.ts — flair#2055 blockers 1 and 2.
 *
 * Blocker 2: the stop-time sidecar cleanup and every sidecar writer share ONE
 * per-data-directory lock, held through the final read and the unlink, so a
 * concurrent writer can never lose its fresh sidecar (and a symlink substituted
 * in the window can never be removed). These tests drive the REAL cleanup and
 * writer exported from src/cli.ts, plus the lock in src/lib/data-dir-lock.ts.
 *
 * Blocker 1's adapter decision is covered by the pure `livenessFromKillError`
 * tests in daemon-liveness.test.ts; here the same "unknown never removes" rule
 * is exercised through the filesystem adapter with a real symlinked sidecar.
 *
 * Everything is HOME-isolated (a scratch data dir under the OS temp dir); no
 * real service manager or Flair data dir is touched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  removeStaleSidecarIfConfirmedDead,
  writeDaemonSidecar,
  readSidecar,
  setSidecarCleanupBeforeUnlinkHookForTests,
} from "../../src/cli.ts";
import { acquireDataDirLock, dataDirLockPath } from "../../src/lib/data-dir-lock.ts";

let dataDir: string;
const dirs: string[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "flair2055-lock-"));
  dirs.push(dataDir);
});
afterEach(() => {
  setSidecarCleanupBeforeUnlinkHookForTests(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sidecarPath = () => join(dataDir, "flair-daemon.json");
function writeSidecarJson(pid: number, extra: Record<string, unknown> = {}): void {
  writeFileSync(sidecarPath(), JSON.stringify({ pid, startTimeMs: Date.now(), port: 19926, flairVersion: "0.57.0", ...extra }) + "\n");
}
function captureErrors<T>(body: () => T): { result: T; errors: string } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  try {
    return { result: body(), errors: errors.join("\n") };
  } finally {
    console.error = original;
  }
}
/** A pid that is CONFIRMED gone: ESRCH only. */
async function confirmedDeadPid(): Promise<number> {
  const p = Bun.spawn(["bun", "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
  const pid = (p as unknown as { pid: number }).pid;
  await p.exited;
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ESRCH") return pid;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`pid ${pid} never reported ESRCH`);
}

// ─── the lock ───────────────────────────────────────────────────────────────

describe("flair#2055 — the per-data-directory lock", () => {
  test("acquire creates the lock file and release removes it", () => {
    const lock = acquireDataDirLock(dataDir);
    expect(lock.status).toBe("acquired");
    expect(existsSync(dataDirLockPath(dataDir))).toBe(true);
    if (lock.status === "acquired") lock.release();
    expect(existsSync(dataDirLockPath(dataDir))).toBe(false);
  });

  test("a held lock is refused (short deadline), not stolen", () => {
    const first = acquireDataDirLock(dataDir);
    expect(first.status).toBe("acquired");
    const second = acquireDataDirLock(dataDir, { deadlineMs: 0 });
    expect(second.status).toBe("refused");
    if (second.status === "refused") expect(second.reason).toContain(`pid ${process.pid}`);
    if (first.status === "acquired") first.release();
  });

  test("a CONFIRMED-dead holder is broken (ESRCH only)", async () => {
    const dead = await confirmedDeadPid();
    writeFileSync(dataDirLockPath(dataDir), JSON.stringify({ pid: dead, hostname: "h", startedAt: new Date().toISOString() }));
    const lock = acquireDataDirLock(dataDir, { deadlineMs: 50 });
    expect(lock.status).toBe("acquired");
    if (lock.status === "acquired") lock.release();
  });

  test("an unreadable holder record is RESPECTED while fresh — never broken on sight", () => {
    writeFileSync(dataDirLockPath(dataDir), "not a holder record");
    const lock = acquireDataDirLock(dataDir, { deadlineMs: 0, staleMs: 5 * 60_000 });
    expect(lock.status).toBe("refused");
    if (lock.status === "refused") expect(lock.reason).toContain("no readable holder record");
  });

  test("an unreadable holder record that is STALE is recovered", () => {
    const path = dataDirLockPath(dataDir);
    writeFileSync(path, "not a holder record");
    const old = (Date.now() - 10 * 60_000) / 1000;
    utimesSync(path, old, old);
    const lock = acquireDataDirLock(dataDir, { deadlineMs: 50, staleMs: 60_000 });
    expect(lock.status).toBe("acquired");
    if (lock.status === "acquired") lock.release();
  });

  test("an EPERM holder reads as ALIVE — its lock is never broken", () => {
    // The current process is alive; the default liveness maps only ESRCH to
    // dead, so a recorded pid we cannot signal still counts as held.
    writeFileSync(dataDirLockPath(dataDir), JSON.stringify({ pid: process.pid, hostname: "h", startedAt: new Date().toISOString() }));
    const lock = acquireDataDirLock(dataDir, { deadlineMs: 0 });
    expect(lock.status).toBe("refused");
  });
});

// ─── cleanup against the lock ───────────────────────────────────────────────

describe("flair#2055 — the cleanup never removes on an unheld lock", () => {
  test("a held lock makes cleanup refuse and leave the sidecar", async () => {
    const dead = await confirmedDeadPid();
    writeSidecarJson(dead);
    const held = acquireDataDirLock(dataDir);
    expect(held.status).toBe("acquired");
    const { errors } = captureErrors(() => removeStaleSidecarIfConfirmedDead(dataDir, { deadlineMs: 30 }));
    expect(existsSync(sidecarPath())).toBe(true); // NOT removed: we never held the lock
    expect(errors).toContain("could not remove a stale daemon sidecar");
    if (held.status === "acquired") held.release();
  });

  test("an unreadable lock also refuses (unknown never licenses a delete)", async () => {
    const dead = await confirmedDeadPid();
    writeSidecarJson(dead);
    // A lock path that is a DIRECTORY: exists, unreadable as a holder, fresh.
    mkdirSync(dataDirLockPath(dataDir));
    const { errors } = captureErrors(() => removeStaleSidecarIfConfirmedDead(dataDir, { deadlineMs: 30 }));
    expect(existsSync(sidecarPath())).toBe(true);
    expect(errors).toContain("could not remove a stale daemon sidecar");
  });
});

// ─── the controlled concurrent-writer test (blocker 2's acceptance) ──────────

describe("flair#2055 — a concurrent writer never loses its sidecar", () => {
  test("a writer that rewrites while the cleanup holds the lock waits, and its sidecar survives", async () => {
    const dead = await confirmedDeadPid();
    writeSidecarJson(dead);
    const writerPid = process.pid; // a LIVE pid: its sidecar must survive

    let committedInWindow = false;
    setSidecarCleanupBeforeUnlinkHookForTests(() => {
      // The cleanup holds the lock here (it is about to unlink). A concurrent
      // writer tries to publish a FRESH sidecar. With the lock it cannot — it
      // waits — so its sidecar is never in the unlink's path.
      try {
        writeDaemonSidecar(dataDir, writerPid, 19926, Date.now(), { deadlineMs: 25 });
        committedInWindow = true;
      } catch {
        committedInWindow = false;
      }
    });

    removeStaleSidecarIfConfirmedDead(dataDir);
    setSidecarCleanupBeforeUnlinkHookForTests(null);

    // THE ASSERTION THE MUTATION BREAKS: without the cleanup's lock the writer
    // commits IN the window (true) and the cleanup then deletes its sidecar.
    expect(committedInWindow).toBe(false);

    // The writer now completes (the lock is free) and its sidecar survives.
    writeDaemonSidecar(dataDir, writerPid, 19926);
    expect(readSidecar(dataDir)).toMatchObject({ kind: "present", pid: writerPid });
  });
});

// ─── a real filesystem symlink through the O_NOFOLLOW adapter ────────────────

describe("flair#2055 — a real symlinked sidecar is neither followed nor removed", () => {
  test("readSidecar reads a symlink as unreadable and cleanup leaves it and its target alone", async () => {
    const dead = await confirmedDeadPid();
    const target = join(dataDir, "elsewhere.json");
    writeSidecarJson(dead);
    // Move the real sidecar aside and make the sidecar path a SYMLINK to it.
    const realContent = readFileSync(sidecarPath(), "utf-8");
    writeFileSync(target, realContent);
    rmSync(sidecarPath());
    symlinkSync(target, sidecarPath());

    const read = readSidecar(dataDir);
    expect(read.kind).toBe("unreadable");
    if (read.kind === "unreadable") expect(read.reason).toContain("symbolic link");

    removeStaleSidecarIfConfirmedDead(dataDir);

    // The symlink was not followed and not removed, and the target is intact.
    expect(lstatSync(sidecarPath()).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe(realContent);
  });
});

// ─── the ordinary removal paths still work ──────────────────────────────────

describe("flair#2055 — cleanup removes only a confirmed-dead sidecar", () => {
  test("a sidecar naming a confirmed-dead pid is removed", async () => {
    const dead = await confirmedDeadPid();
    writeSidecarJson(dead);
    removeStaleSidecarIfConfirmedDead(dataDir);
    expect(existsSync(sidecarPath())).toBe(false);
  });

  test("a sidecar naming a LIVE pid is kept", () => {
    writeSidecarJson(process.pid);
    removeStaleSidecarIfConfirmedDead(dataDir);
    expect(existsSync(sidecarPath())).toBe(true);
  });

  test("no sidecar is a no-op", () => {
    removeStaleSidecarIfConfirmedDead(dataDir);
    expect(existsSync(sidecarPath())).toBe(false);
  });
});
