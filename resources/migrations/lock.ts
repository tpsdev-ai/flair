/**
 * lock.ts — single-flight guard (Kern verdict, 2026-07-12):
 * "Single-flight v1 = in-process mutex + stale-tolerant file lock (flock on
 * well-known path; dead-holder → break and proceed). Fabric-wide ordering =
 * follow-on with its own review, NOT this slice."
 *
 * Two layers:
 *   1. An in-process mutex (module-scope flag) — cheapest guard against two
 *      concurrent async callers inside the SAME Node process (e.g. a
 *      duplicate boot-trigger firing twice).
 *   2. A file lock at a well-known path under the data dir. Node has no
 *      portable flock() binding, so this uses exclusive file CREATE
 *      (O_CREAT|O_EXCL — atomic at the OS level, the same primitive flock
 *      ultimately reduces to for a single-host guard) instead. The lock file
 *      holds `{pid, hostname, startedAt}`. A lock is considered STALE (and
 *      is broken/removed before the new attempt) when either: the recorded
 *      pid is no longer alive on this host, OR the file is older than
 *      `staleMs` (covers a cross-host holder this process can't liveness-
 *      check by pid — Fabric-wide coordination is explicitly out of scope
 *      for this slice, so age is the only signal available for that case).
 *
 * This is a SINGLE-HOST guard, not a Fabric-wide one — multiple Flair
 * instances in a Fabric cluster each have their OWN data dir today, so this
 * is sufficient for v1. Fabric-wide ordering (one lock across a cluster
 * sharing storage) is explicitly deferred, per the verdict above.
 */
import { existsSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, unlinkSync, statSync, utimesSync, constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import { hostname as osHostname } from "node:os";

export const DEFAULT_STALE_MS = 5 * 60 * 1000; // 5 minutes with no heartbeat touch = stale

export interface LockHolder {
  pid: number;
  hostname: string;
  startedAt: string;
}

export interface LockDeps {
  lockPath: string;
  staleMs: number;
  /** Liveness check for a recorded pid. Injectable for tests. */
  isProcessAlive: (pid: number) => boolean;
  now: () => number;
}

export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function defaultLockDeps(lockPath: string): LockDeps {
  return {
    lockPath,
    staleMs: DEFAULT_STALE_MS,
    isProcessAlive: defaultIsProcessAlive,
    now: () => Date.now(),
  };
}

// In-process mutex — module-scope, so it's shared by every caller within
// this one Node process regardless of which lockPath they pass (a single
// process only ever wants to run one migration cycle at a time).
let inProcessHeld = false;

/** Test-only reset for the in-process mutex (mirrors instance-identity.ts's `_reset*ForTests` idiom). */
export function _resetInProcessLockForTests(): void {
  inProcessHeld = false;
}

export type AcquireResult =
  | { acquired: true; release: () => void; touch: () => void }
  | { acquired: false; reason: string; holder?: LockHolder };

function readHolder(lockPath: string): LockHolder | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf-8"));
    if (typeof raw?.pid === "number" && typeof raw?.hostname === "string" && typeof raw?.startedAt === "string") {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Attempts to acquire the migration lock. On success, returns `release()`
 * (removes the lock file + clears the in-process flag) and `touch()`
 * (updates the lock file's mtime — the runner calls this periodically
 * during a long-running migration so ANOTHER process's staleness check
 * doesn't mistake a genuinely-still-running holder for dead).
 */
export function acquireMigrationLock(deps: Partial<LockDeps> & { lockPath: string }): AcquireResult {
  const resolved: LockDeps = { ...defaultLockDeps(deps.lockPath), ...deps };
  const { lockPath, staleMs, isProcessAlive, now } = resolved;

  if (inProcessHeld) {
    return { acquired: false, reason: "already held in-process (another async caller in this process holds it)" };
  }

  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  if (existsSync(lockPath)) {
    const holder = readHolder(lockPath);
    let ageMs = Infinity;
    try {
      ageMs = now() - statSync(lockPath).mtimeMs;
    } catch {
      /* vanished between existsSync and stat — fall through to acquire */
    }
    const dead = !holder || !isProcessAlive(holder.pid) || ageMs > staleMs;
    if (dead) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* another racer already broke it — fine, continue to the exclusive create below */
      }
    } else {
      return {
        acquired: false,
        reason: `held by pid ${holder.pid} on ${holder.hostname} since ${holder.startedAt}`,
        holder,
      };
    }
  }

  let fd: number;
  try {
    // O_EXCL: atomic exclusive create — fails with EEXIST if another
    // process/racer won the create between our stale-check above and here.
    fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      return { acquired: false, reason: "lost the race to acquire the lock file" };
    }
    throw err;
  }

  try {
    const info: LockHolder = { pid: process.pid, hostname: osHostname(), startedAt: new Date(now()).toISOString() };
    writeSync(fd, JSON.stringify(info));
  } finally {
    closeSync(fd);
  }

  inProcessHeld = true;
  let released = false;
  return {
    acquired: true,
    release: () => {
      if (released) return;
      released = true;
      inProcessHeld = false;
      try {
        unlinkSync(lockPath);
      } catch {
        /* already gone — fine */
      }
    },
    touch: () => {
      const t = new Date(now());
      try {
        utimesSync(lockPath, t, t);
      } catch {
        /* best-effort heartbeat — a failed touch must never break the migration */
      }
    },
  };
}
