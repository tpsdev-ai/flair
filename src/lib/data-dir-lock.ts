/**
 * data-dir-lock.ts — one exclusive lock per data directory, for the identity
 * sidecar (`flair-daemon.json`) that both the stop-time cleanup and every
 * sidecar writer touch (flair#2055).
 *
 * WHY. The cleanup re-read the sidecar with O_NOFOLLOW and then unlinked it by
 * pathname. Between that read and the unlink a concurrent `flair start` could
 * replace the sidecar with a FRESH one naming the new pid — and the cleanup
 * would delete the fresh sidecar; a symlink substituted in the same window
 * could be removed too. Serialising the cleanup and every writer on ONE lock,
 * held through the read and the unlink, closes the window: a writer either
 * finishes before the cleanup reads (the cleanup sees the new pid and leaves
 * it), or it waits and writes after the cleanup releases (its sidecar
 * survives).
 *
 * WHY A FILE LOCK, AND WHY HERE. It mirrors the repo's migrations lock
 * (`resources/migrations/lock.ts`): an `O_EXCL` create of a well-known file, a
 * `{pid, hostname, startedAt}` holder record, and a dead-holder break. It is
 * NOT that module — `src/` cannot import `resources/` (they sit on opposite
 * sides of the npm-packaging boundary), and its in-process mutex is global
 * rather than per-lock-path. The lock lives WITH the data directory it
 * protects (`<dataDir>/flair-daemon.lock`), so two instances never share it;
 * it is a single-host guard.
 *
 * FAIL CLOSED. A lock that cannot be taken is a refusal, never a silent
 * proceed: the caller must NOT delete or write on an unheld lock. A holder
 * whose liveness cannot be determined is treated as ALIVE (wait), never broken
 * — unknown evidence never licenses an action. Only a holder whose pid is
 * CONFIRMED gone (ESRCH), or a record older than `staleMs`, is broken.
 */
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";

/** The lock file's name inside the data directory. */
export const DATA_DIR_LOCK_NAME = "flair-daemon.lock";
/** How long a caller waits for a held lock before refusing. */
export const DATA_DIR_LOCK_DEADLINE_MS = 10_000;
/** Poll interval while waiting. */
export const DATA_DIR_LOCK_POLL_MS = 25;
/** A holder record older than this is stale (covers a same-host holder we cannot liveness-check). */
export const DATA_DIR_LOCK_STALE_MS = 5 * 60 * 1000;

export function dataDirLockPath(dataDir: string): string {
  return join(dataDir, DATA_DIR_LOCK_NAME);
}

export interface DataDirLockHolder {
  pid: number;
  hostname: string;
  startedAt: string;
}

export interface DataDirLockDeps {
  deadlineMs: number;
  pollMs: number;
  staleMs: number;
  /** Liveness for a recorded pid: ESRCH = dead; every other outcome (incl. EPERM and unknown) = alive. */
  isPidAlive: (pid: number) => boolean;
  now: () => number;
  sleep: (ms: number) => void;
  hostname: () => string;
}

export type AcquireDataDirLockResult =
  | { status: "acquired"; release: () => void }
  | { status: "refused"; reason: string };

/** Default liveness: only a CONFIRMED ESRCH reads as dead; anything else (EPERM, unknown) is alive. */
export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

function defaultSleep(ms: number): void {
  // A synchronous, bounded wait — the lock's critical sections are synchronous,
  // and the CLI must not yield to another async writer mid-section.
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

function defaultDeps(): DataDirLockDeps {
  return {
    deadlineMs: DATA_DIR_LOCK_DEADLINE_MS,
    pollMs: DATA_DIR_LOCK_POLL_MS,
    staleMs: DATA_DIR_LOCK_STALE_MS,
    isPidAlive: defaultIsPidAlive,
    now: () => Date.now(),
    sleep: defaultSleep,
    hostname: () => osHostname(),
  };
}

function readHolder(lockPath: string): DataDirLockHolder | null {
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
 * Decide whether an EXISTING lock file may be broken, or must be respected.
 * Returns `null` to break, or a human reason to keep waiting.
 *
 * Break ONLY on positive evidence: the holder pid is CONFIRMED gone (ESRCH), or
 * the record is older than `staleMs`. An unreadable / unparseable record is
 * `unknown` — respected while it is fresh, broken only once it ages past
 * `staleMs` (a genuinely abandoned lock), never on sight.
 */
function heldReason(lockPath: string, deps: DataDirLockDeps): string | null {
  const holder = readHolder(lockPath);
  let ageMs = Infinity;
  try {
    ageMs = deps.now() - statSync(lockPath).mtimeMs;
  } catch {
    /* vanished between existsSync and stat — treat as breakable */
    return null;
  }
  const stale = ageMs > deps.staleMs;
  if (holder) {
    if (!deps.isPidAlive(holder.pid)) return null; // confirmed gone — break
    if (stale) return null; // live pid but an aged record — break
    return `held by pid ${holder.pid} on ${holder.hostname} since ${holder.startedAt}`;
  }
  // Unreadable / unparseable holder: unknown. Respect it while fresh.
  if (stale) return null;
  return `lock exists at ${lockPath} with no readable holder record, and it is not yet stale — refusing to break it`;
}

/** Try one O_EXCL create. Returns true on success, false on EEXIST, throws otherwise. */
function tryCreate(lockPath: string, deps: DataDirLockDeps): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw err;
  }
  try {
    const info: DataDirLockHolder = {
      pid: process.pid,
      hostname: deps.hostname(),
      startedAt: new Date(deps.now()).toISOString(),
    };
    writeSync(fd, JSON.stringify(info));
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Acquire the data-directory lock. On success returns `release()`; on any other
 * outcome returns `{ ok: false, reason }` — the caller MUST NOT proceed on a
 * failure (the lock is the authorization for the write/delete).
 */
export function acquireDataDirLock(
  dataDir: string,
  overrides: Partial<DataDirLockDeps> = {},
): AcquireDataDirLockResult {
  const deps: DataDirLockDeps = { ...defaultDeps(), ...overrides };
  const lockPath = dataDirLockPath(dataDir);
  const deadline = deps.now() + deps.deadlineMs;
  let lastReason = `the lock at ${lockPath} could not be taken`;
  for (;;) {
    if (existsSync(lockPath)) {
      const reason = heldReason(lockPath, deps);
      if (reason !== null) {
        lastReason = reason;
        if (deps.now() >= deadline) return { status: "refused", reason: lastReason };
        deps.sleep(deps.pollMs);
        continue;
      }
      // Breakable: remove it and race to re-create.
      try {
        unlinkSync(lockPath);
      } catch {
        /* another racer already broke it — fall through to the create */
      }
    }
    let created: boolean;
    try {
      created = tryCreate(lockPath, deps);
    } catch (err) {
      return { status: "refused", reason: `could not create ${lockPath}: ${(err as Error)?.message ?? err}` };
    }
    if (created) {
      let released = false;
      return {
        status: "acquired",
        release: () => {
          if (released) return;
          released = true;
          try {
            unlinkSync(lockPath);
          } catch {
            /* already gone — fine */
          }
        },
      };
    }
    // Lost the create race (EEXIST): loop and re-evaluate the holder.
    if (deps.now() >= deadline) return { status: "refused", reason: lastReason };
    deps.sleep(deps.pollMs);
  }
}
