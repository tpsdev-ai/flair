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
 *      holds `{pid, hostname, startedAt}`. A lock whose recorded holder is on
 *      THIS host is broken only when that pid is no longer alive; a live local
 *      holder is held regardless of the file's age. A holder recorded on
 *      ANOTHER host is judged by age alone (`staleMs`) and is never probed by
 *      a local pid. The pid probe is therefore only used for a local holder.
 *      The cross-host case keeps the takeover window: a remote holder is still
 *      judged by age, which is out of scope for this single-host guard.
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

const liveHandles = new WeakSet<MigrationLockHandle>();
const revokedHandles = new WeakSet<MigrationLockHandle>();
const HANDLE_KEY = Symbol("migration-lock-handle");

/**
 * An acquired migration lock. Only {@link acquireMigrationLock} constructs a
 * live one; {@link MigrationLockHandle.release} revokes it. The handle is
 * bound to the lock path it acquired (flair#2866).
 */
export class MigrationLockHandle {
  readonly acquired = true as const;
  readonly lockPath: string;
  readonly holder: LockHolder;
  #release: () => void;
  #touch: () => void;

  constructor(key: symbol, lockPath: string, holder: LockHolder, release: () => void, touch: () => void) {
    if (key !== HANDLE_KEY) {
      throw new TypeError("MigrationLockHandle is created only by acquireMigrationLock");
    }
    this.lockPath = lockPath;
    this.holder = holder;
    this.#release = release;
    this.#touch = touch;
    liveHandles.add(this);
  }

  release(): void {
    if (!liveHandles.has(this)) return;
    liveHandles.delete(this);
    revokedHandles.add(this);
    this.#release();
  }

  touch(): void {
    this.#touch();
  }
}

export type MigrationLockHandleStatus = "live" | "released" | "unknown";

/** Classify a value without exposing whether a forged object imitates a handle. */
export function migrationLockHandleStatus(value: unknown): MigrationLockHandleStatus {
  if (typeof value === "object" && value !== null) {
    if (liveHandles.has(value as MigrationLockHandle)) return "live";
    if (revokedHandles.has(value as MigrationLockHandle)) return "released";
  }
  return "unknown";
}

export function isLiveMigrationLockHandle(value: unknown): value is MigrationLockHandle {
  return migrationLockHandleStatus(value) === "live";
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
  | MigrationLockHandle
  | { acquired: false; reason: string; holder?: LockHolder };

/**
 * True only when `lock.lockPath` still records the holder identity this handle
 * acquired. Any read/parse failure answers false: an unknown lock state never
 * licenses a write (flair#2866).
 */
export function migrationLockStillHeld(lock: MigrationLockHandle): boolean {
  const current = readHolder(lock.lockPath);
  return (
    current !== null &&
    current.pid === lock.holder.pid &&
    current.hostname === lock.holder.hostname &&
    current.startedAt === lock.holder.startedAt
  );
}

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

  try {
    mkdirSync(dirname(lockPath), { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  if (existsSync(lockPath)) {
    const holder = readHolder(lockPath);
    let ageMs = Infinity;
    try {
      ageMs = now() - statSync(lockPath).mtimeMs;
    } catch {
      /* vanished between existsSync and stat — fall through to acquire */
    }
    const heldRefusal = (h: LockHolder): AcquireResult => ({
      acquired: false,
      reason: `held by pid ${h.pid} on ${h.hostname} since ${h.startedAt} (lock ${lockPath})`,
      holder: h,
    });
    let breakable: boolean;
    if (holder === null) {
      // Unreadable/corrupt lock: no holder can be trusted, so break it.
      breakable = true;
    } else if (holder.hostname === osHostname()) {
      // Local holder: pid liveness is the only signal; age never breaks it.
      breakable = !isProcessAlive(holder.pid);
    } else {
      // Remote holder: age is the only signal; never probe a local pid.
      breakable = ageMs > staleMs;
    }
    if (breakable) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* another racer already broke it — fine, continue to the exclusive create below */
      }
    } else if (holder !== null) {
      return heldRefusal(holder);
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

  let info: LockHolder;
  try {
    info = { pid: process.pid, hostname: osHostname(), startedAt: new Date(now()).toISOString() };
    writeSync(fd, JSON.stringify(info));
  } finally {
    closeSync(fd);
  }

  inProcessHeld = true;
  const handle = new MigrationLockHandle(
    HANDLE_KEY,
    lockPath,
    info,
    () => {
      inProcessHeld = false;
      // Defence in depth, not the serialization guarantee: the acquisition
      // rule above never breaks a live local holder, so a local successor
      // cannot exist while this process runs. This guard also covers the
      // cross-host residual, where an age-based takeover can replace the file.
      if (!migrationLockStillHeld(handle)) return;
      try {
        unlinkSync(lockPath);
      } catch {
        /* already gone — fine */
      }
    },
    () => {
      const t = new Date(now());
      try {
        utimesSync(lockPath, t, t);
      } catch {
        /* best-effort heartbeat — a failed touch must never break the migration */
      }
    },
  );
  return handle;
}
