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
 *      portable flock() binding, so a contender publishes a complete holder
 *      record to a unique temporary file in the same directory, flushes it,
 *      and hard-links it to the lock path (`link(2)`, which fails with EEXIST
 *      when a lock exists). A reader therefore sees either no lock file or a
 *      complete record, never a partial one. The lock file holds
 *      `{pid, hostname, startedAt}`. A lock whose recorded holder is on THIS
 *      host is reclaimed only when that pid is no longer alive; a live local
 *      holder is held regardless of the file's age. A holder recorded on
 *      ANOTHER host is judged by age alone (`staleMs`) and is never probed by
 *      a local pid. The pid probe is therefore only used for a local holder.
 *      A holder record that cannot be read or parsed is not treated as stale:
 *      acquisition refuses with a named error. The cross-host case keeps the
 *      takeover window: a remote holder is still judged by age, which is out
 *      of scope for this single-host guard.
 *
 * This is a SINGLE-HOST guard, not a Fabric-wide one — multiple Flair
 * instances in a Fabric cluster each have their OWN data dir today, so this
 * is sufficient for v1. Fabric-wide ordering (one lock across a cluster
 * sharing storage) is explicitly deferred, per the verdict above.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { hostname as osHostname } from "node:os";
import { txnPausePointSync } from "../txn-pause-point.js";

export const DEFAULT_STALE_MS = 5 * 60 * 1000; // 5 minutes with no heartbeat touch = stale

export interface LockHolder {
  pid: number;
  hostname: string;
  startedAt: string;
}

/** Where the state writer and release() read a handle's identity (flair#2866). */
export interface MigrationLockIdentity {
  readonly lockPath: string;
  readonly holder: LockHolder;
}

interface LockIdentity extends MigrationLockIdentity {
  readonly dev: number;
  readonly ino: number;
  release(): void;
  touch(): void;
}

const liveHandles = new WeakSet<MigrationLockHandle>();
const revokedHandles = new WeakSet<MigrationLockHandle>();
/** Module-private identity: never read from a property a caller can shadow. */
const identities = new WeakMap<MigrationLockHandle, LockIdentity>();
const HANDLE_KEY = Symbol("migration-lock-handle");

/**
 * An acquired migration lock. Only {@link acquireMigrationLock} constructs a
 * live one; {@link MigrationLockHandle.release} revokes it. The lock path and
 * holder record live in module-private storage keyed by this object. The
 * `lockPath` and `holder` getters return a snapshot for diagnostics; neither
 * `state.ts` nor `release()` consults them (flair#2866).
 */
export class MigrationLockHandle {
  readonly acquired = true as const;

  constructor(key: symbol, identity: LockIdentity) {
    if (key !== HANDLE_KEY) {
      throw new TypeError("MigrationLockHandle is created only by acquireMigrationLock");
    }
    identities.set(this, identity);
    liveHandles.add(this);
  }

  get lockPath(): string {
    return identityFor(this).lockPath;
  }

  get holder(): LockHolder {
    return identityFor(this).holder;
  }

  release(): void {
    const identity = identities.get(this);
    if (!liveHandles.has(this) || identity === undefined) return;
    liveHandles.delete(this);
    revokedHandles.add(this);
    identity.release();
  }

  touch(): void {
    if (!liveHandles.has(this)) return;
    identities.get(this)?.touch();
  }
}

function identityFor(handle: MigrationLockHandle): LockIdentity {
  const identity = identities.get(handle);
  if (identity === undefined) throw new TypeError("not a migration lock handle");
  return identity;
}

/**
 * The lock path and holder a handle was issued for, or null for any other
 * value. This is the only way `state.ts` reads a handle's identity.
 */
export function migrationLockIdentity(value: unknown): MigrationLockIdentity | null {
  if (typeof value !== "object" || value === null) return null;
  const identity = identities.get(value as MigrationLockHandle);
  if (identity === undefined) return null;
  return Object.freeze({ lockPath: identity.lockPath, holder: identity.holder });
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

/** The named refusal when a pid probe fails for a reason other than ESRCH/EPERM. */
export class MigrationLockProbeError extends Error {
  constructor(pid: number, code: string | undefined) {
    super(
      `refusing to treat holder pid ${pid} as dead: the liveness probe failed with ` +
        `${code ?? "an unknown error"}. Inspect pid ${pid} on this host (for example, ` +
        `ps -p ${pid}); only when it is gone, and no other writer is running, remove the lock file by hand`,
    );
    this.name = "MigrationLockProbeError";
  }
}

/** The named refusal when a lock file's holder record cannot be trusted. */
export class MigrationLockUnreadableError extends Error {
  constructor(lockPath: string, detail: string) {
    super(
      `refusing to break ${lockPath}: ${detail}. Inspect ${lockPath}; if no process on ` +
        `this host still holds it, stop every writer and remove that file by hand, then retry`,
    );
    this.name = "MigrationLockUnreadableError";
  }
}

/**
 * True when the pid is alive. ESRCH means dead; EPERM means alive (the process
 * exists but is not ours to signal); every other probe error refuses
 * acquisition by name rather than guessing (flair#2866).
 */
export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw new MigrationLockProbeError(pid, code);
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
 * True only when this module issued the handle and the lock file still
 * records that handle's holder at the device and inode recorded when the lock
 * was published. Any read or parse failure answers false: an unknown lock
 * state never licenses a write (flair#2866).
 */
export function migrationLockStillHeld(lock: MigrationLockHandle): boolean {
  const identity = identities.get(lock);
  if (identity === undefined) return false;
  const current = inspectLock(identity.lockPath);
  return (
    current.state === "held" &&
    current.dev === identity.dev &&
    current.ino === identity.ino &&
    sameHolder(current.holder, identity.holder)
  );
}

type LockInspection =
  | { state: "absent" }
  | { state: "held"; holder: LockHolder; dev: number; ino: number; mtimeMs: number }
  | { state: "unreadable"; detail: string };

function sameHolder(a: LockHolder, b: LockHolder): boolean {
  return a.pid === b.pid && a.hostname === b.hostname && a.startedAt === b.startedAt;
}

function parseHolder(raw: unknown): LockHolder | null {
  if (
    typeof raw === "object" &&
    raw !== null &&
    Number.isInteger((raw as LockHolder).pid) &&
    (raw as LockHolder).pid > 0 &&
    typeof (raw as LockHolder).hostname === "string" &&
    (raw as LockHolder).hostname.length > 0 &&
    typeof (raw as LockHolder).startedAt === "string" &&
    (raw as LockHolder).startedAt.length > 0
  ) {
    return {
      pid: (raw as LockHolder).pid,
      hostname: (raw as LockHolder).hostname,
      startedAt: (raw as LockHolder).startedAt,
    };
  }
  return null;
}

/**
 * Read the lock's holder, device and inode from one open file descriptor, so
 * the three facts describe the same file even if the name is replaced while
 * the read runs. A missing file is absent; anything else that prevents a
 * complete record is unreadable and never breakable.
 */
function inspectLock(lockPath: string): LockInspection {
  let fd: number;
  try {
    fd = openSync(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { state: "absent" };
    return { state: "unreadable", detail: `the lock file cannot be opened (${(err as NodeJS.ErrnoException)?.code ?? String(err)})` };
  }
  try {
    const st = fstatSync(fd);
    const text = readFileSync(fd, "utf-8");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { state: "unreadable", detail: "its holder record is not valid JSON" };
    }
    const holder = parseHolder(raw);
    if (holder === null) {
      return { state: "unreadable", detail: "its holder record lacks a positive integer pid, a hostname or a startedAt" };
    }
    return { state: "held", holder, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
  } catch (err) {
    return { state: "unreadable", detail: `the lock file cannot be read (${(err as NodeJS.ErrnoException)?.code ?? String(err)})` };
  } finally {
    closeSync(fd);
  }
}

function holderRecordAt(path: string): LockHolder | null {
  try {
    return parseHolder(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return null;
  }
}

type PublishResult = { published: true; dev: number; ino: number } | { published: false };

/**
 * Write the complete holder record to a unique temporary file in the lock's
 * directory, flush it, then hard-link it to the lock path. `link` is atomic
 * and fails with EEXIST when a lock already exists, so a reader never sees a
 * partial record. The temporary name is removed on every path.
 */
function publishLock(lockPath: string, holder: LockHolder): PublishResult {
  const temp = join(
    dirname(lockPath),
    `.${basename(lockPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  let created = false;
  let dev = 0;
  let ino = 0;
  try {
    fd = openSync(temp, "wx", 0o600);
    created = true;
    writeSync(fd, JSON.stringify(holder));
    fsyncSync(fd);
    const st = fstatSync(fd);
    dev = st.dev;
    ino = st.ino;
    closeSync(fd);
    fd = undefined;
    // Test-only pause between the complete temporary record and the link that
    // publishes it, so a test can put a second contender into that window
    // deterministically (flair#2866).
    txnPausePointSync("migration-lock-publish", process.env, undefined, { lockPath, temp });
    try {
      linkSync(temp, lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return { published: false };
      throw err;
    }
    return { published: true, dev, ino };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* the original error is the one to surface */
      }
    }
    try {
      if (created) unlinkSync(temp);
    } catch {
      /* the temporary name is best-effort cleanup; the lock (if linked) is unaffected */
    }
  }
}

type ReclaimResult = { reclaimed: true } | { reclaimed: false; reason: string };

/**
 * Remove the inspected dead holder's lock. The lock is renamed to a unique
 * sibling and the moved file is compared by device and inode with the one
 * inspected: a match is the dead holder's lock and is removed; a mismatch is
 * a successor's lock, which is linked back and left in place. When it cannot
 * be linked back, both paths are named and nothing is deleted (flair#2866).
 */
function reclaimDeadLock(
  lockPath: string,
  inspected: Extract<LockInspection, { state: "held" }>,
): ReclaimResult {
  const moved = `${lockPath}.reclaim-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    renameSync(lockPath, moved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { reclaimed: true };
    throw err;
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(moved);
  } catch (err) {
    return {
      reclaimed: false,
      reason:
        `refusing to acquire ${lockPath}: the lock moved while reclaiming a dead holder and the moved file ` +
        `${moved} cannot be inspected (${(err as NodeJS.ErrnoException)?.code ?? String(err)}); inspect both paths`,
    };
  }
  const movedHolder = holderRecordAt(moved);
  if (
    movedHolder === null ||
    st.dev !== inspected.dev ||
    st.ino !== inspected.ino ||
    !sameHolder(movedHolder, inspected.holder)
  ) {
    try {
      linkSync(moved, lockPath);
    } catch (err) {
      return {
        reclaimed: false,
        reason:
          `refusing to acquire ${lockPath}: the lock changed after the dead holder was inspected and another ` +
          `lock now exists there; the moved lock is at ${moved} ` +
          `(${(err as NodeJS.ErrnoException)?.code ?? String(err)}); inspect both paths`,
      };
    }
    try {
      unlinkSync(moved);
    } catch {
      /* the successor's lock is restored at lockPath; the extra name is left rather than deleting it */
    }
    return {
      reclaimed: false,
      reason:
        `refusing to acquire ${lockPath}: the lock changed after the dead holder was inspected ` +
        `(a successor's lock was moved aside and restored)`,
    };
  }
  try {
    unlinkSync(moved);
  } catch (err) {
    return {
      reclaimed: false,
      reason:
        `refusing to acquire ${lockPath}: the dead holder's lock was moved to ${moved} but cannot be removed ` +
        `(${(err as NodeJS.ErrnoException)?.code ?? String(err)}); inspect that path`,
    };
  }
  return { reclaimed: true };
}

/**
 * Attempts to acquire the migration lock. On success, returns a handle whose
 * `release()` removes the lock file and clears the in-process flag, and whose
 * `touch()` (updates the lock file's mtime — the runner calls this
 * periodically during a long-running migration so ANOTHER process's staleness
 * check doesn't mistake a genuinely-still-running holder for dead).
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

  const heldRefusal = (h: LockHolder): AcquireResult => ({
    acquired: false,
    reason: `held by pid ${h.pid} on ${h.hostname} since ${h.startedAt} (lock ${lockPath})`,
    holder: h,
  });

  for (let attempt = 0; attempt < 4; attempt++) {
    const inspected = inspectLock(lockPath);

    if (inspected.state === "absent") {
      const info = makeHolder(now);
      const published = publishLock(lockPath, info);
      if (published.published) return issueHandle(lockPath, info, published.dev, published.ino, now);
      continue; // another contender published between the inspection and the link
    }

    if (inspected.state === "unreadable") {
      const err = new MigrationLockUnreadableError(lockPath, inspected.detail);
      return { acquired: false, reason: `${err.name}: ${err.message}` };
    }

    const holder = inspected.holder;
    let breakable: boolean;
    if (holder.hostname === osHostname()) {
      let alive: boolean;
      try {
        alive = isProcessAlive(holder.pid);
      } catch (err) {
        if (err instanceof MigrationLockProbeError) {
          return { acquired: false, reason: `${err.name}: ${err.message}` };
        }
        throw err;
      }
      breakable = !alive;
    } else {
      breakable = now() - inspected.mtimeMs > staleMs;
    }

    if (!breakable) return heldRefusal(holder);

    // Test-only pause between the dead-holder inspection above and the
    // rename/unlink below, so a test can put a second contender into the
    // reclaim window deterministically (flair#2866).
    txnPausePointSync("migration-lock-reclaim", process.env, undefined, { lockPath });

    const reclaimed = reclaimDeadLock(lockPath, inspected);
    if (!reclaimed.reclaimed) return { acquired: false, reason: reclaimed.reason };
  }

  return { acquired: false, reason: `lost the race to acquire the lock file (${lockPath})` };
}

function makeHolder(now: () => number): LockHolder {
  return { pid: process.pid, hostname: osHostname(), startedAt: new Date(now()).toISOString() };
}

function issueHandle(
  lockPath: string,
  holder: LockHolder,
  dev: number,
  ino: number,
  now: () => number,
): MigrationLockHandle {
  Object.freeze(holder);
  inProcessHeld = true;
  const identity: LockIdentity = {
    lockPath,
    holder,
    dev,
    ino,
    release: () => {
      inProcessHeld = false;
      // Move the lock aside, then confirm the moved file is the one this
      // handle published (device, inode and holder record). A file that does
      // not match belongs to a successor: link it back and leave it.
      const moved = `${lockPath}.release-${process.pid}-${randomBytes(8).toString("hex")}`;
      try {
        renameSync(lockPath, moved);
      } catch {
        return; // already gone
      }
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(moved);
      } catch {
        return;
      }
      const record = holderRecordAt(moved);
      const own = st.dev === dev && st.ino === ino && record !== null && sameHolder(record, holder);
      if (own) {
        try {
          unlinkSync(moved);
        } catch {
          /* the lock is released; a leftover name is harmless */
        }
        return;
      }
      try {
        linkSync(moved, lockPath);
        unlinkSync(moved);
      } catch {
        // A concurrent lock now occupies lockPath: leave the moved file in
        // place rather than deleting a successor's lock record.
      }
    },
    touch: () => {
      const t = new Date(now());
      try {
        const st = statSync(lockPath);
        if (st.dev !== dev || st.ino !== ino) return;
        utimesSync(lockPath, t, t);
      } catch {
        /* best-effort heartbeat — a failed touch must never break the migration */
      }
    },
  };
  return new MigrationLockHandle(HANDLE_KEY, identity);
}
