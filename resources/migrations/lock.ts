/**
 * lock.ts — single-flight guard for migration cycles.
 *
 * Two layers:
 *   1. An in-process flag — cheapest guard against two concurrent async
 *      callers inside the SAME process.
 *   2. A file lock at a well-known path under the data dir. Node has no
 *      portable flock() binding, so a contender publishes a complete holder
 *      record to a unique temporary file in the same directory, flushes it,
 *      and hard-links it to the lock path (`link(2)`, which fails with EEXIST
 *      when a lock exists). A reader sees no lock file, a complete record, or
 *      a record this module refuses as unreadable; it never treats a partial
 *      or unknown record as stale.
 *
 * Every migration-lock transition is serialized by a sibling directory mutex
 * (`<lock>.guard`). A process publishes that mutex by renaming an
 * already-populated directory over the guard path: replacing an empty
 * directory succeeds, replacing a non-empty one fails with ENOTEMPTY. The
 * mutex is released by unlinking only the owner entry of the generation it
 * published, leaving the directory empty when the unlink succeeds. A dead
 * owner is recovered by
 * unlinking that same generation-specific entry; the recovering process must
 * then win publication of its own directory, so recovery never grants
 * ownership by itself.
 *
 * The lock file holds `{pid, hostname, startedAt}`. A lock whose recorded
 * holder is on THIS host is reclaimed only when that pid is no longer alive;
 * a live local holder is held regardless of the file's age. A holder
 * recorded on ANOTHER host is judged by age alone (`staleMs`) and is never
 * probed by a local pid. The pid probe is therefore only used for a local
 * holder. A holder record that cannot be read or parsed is not treated as
 * stale: acquisition refuses with a named error.
 *
 * This is a SINGLE-HOST guard, not a Fabric-wide one — multiple Flair
 * instances in a Fabric cluster each have their OWN data dir today. Fabric-
 * wide ordering (one lock across a cluster sharing storage) is deferred.
 *
 * Known windows: a holder recorded on another host is still judged by age,
 * for the mutex as well as the migration record, so a remote holder that
 * resumes after takeover is not fenced. A process killed while preparing a
 * record leaves an unpublished staging directory or temporary file; one
 * killed after publication
 * leaves a complete owner record that another process can recover after
 * establishing death.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  futimesSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { hostname as osHostname } from "node:os";
import { ensureSecureDir } from "./dir-safety.js";
import { txnPausePointSync } from "../txn-pause-point.js";

export const DEFAULT_STALE_MS = 5 * 60 * 1000; // 5 minutes with no heartbeat touch = stale

/** Bounds every acquisition loop; contention settles between attempts. */
const GUARD_ACQUISITION_ATTEMPTS = 24;
const LOCK_ACQUISITION_ROUNDS = 8;
const CONTENTION_SETTLE_MS = 2;

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

interface GuardHolder {
  pid: number;
  hostname: string;
  startedAt: string;
  generation: string;
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

/** The named refusal when the directory mutex cannot be trusted. */
export class MigrationLockMutexError extends Error {
  constructor(guardPath: string, detail: string) {
    super(
      `refusing to change the migration lock at ${guardPath}: ${detail}. Inspect ${guardPath}; ` +
        `if no process on this host still holds the mutex, stop every writer and remove it by hand, then retry`,
    );
    this.name = "MigrationLockMutexError";
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
 * complete regular-file record is unreadable and never breakable.
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
    if (!st.isFile()) return { state: "unreadable", detail: "it is not a regular file" };
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

type PublishResult = { published: true; dev: number; ino: number } | { published: false };

/**
 * Write the complete holder record to a unique temporary file in the lock's
 * directory, flush it, then hard-link it to the lock path. `link` is atomic
 * and fails with EEXIST when a lock already exists, so a reader never sees a
 * partial record. The temporary name is removed best-effort; a cleanup
 * failure leaves an extra temporary file and does not affect a published lock.
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
    writeFileSync(fd, JSON.stringify(holder));
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
    txnPausePointSync("migration-lock-published", process.env, undefined, { lockPath });
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
      /* best-effort cleanup: an extra temporary name does not affect the lock */
    }
  }
}

/** A prepared complete holder record in a unique sibling file, flushed and closed. */
type PreparedRecord = { temp: string; dev: number; ino: number };

function prepareLockRecord(lockPath: string, holder: LockHolder): PreparedRecord {
  const temp = join(
    dirname(lockPath),
    `.${basename(lockPath)}.${process.pid}.${randomBytes(8).toString("hex")}.reclaim.tmp`,
  );
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(holder));
    fsyncSync(fd);
    const st = fstatSync(fd);
    return { temp, dev: st.dev, ino: st.ino };
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      /* best-effort cleanup of our own unpublished record */
    }
    throw err;
  } finally {
    closeSync(fd);
  }
}

// ─── directory mutex ────────────────────────────────────────────────────────

function guardPathFor(lockPath: string): string {
  return `${lockPath}.guard`;
}

function ownerEntryName(generation: string): string {
  return `owner-${generation}.json`;
}

const GENERATION_PATTERN = /^[0-9a-f]{16}$/;
const OWNER_ENTRY_PATTERN = /^owner-([0-9a-f]{16})\.json$/;

type GuardInspection =
  | { state: "absent" }
  | { state: "empty" }
  | { state: "occupied"; holder: GuardHolder; name: string; mtimeMs: number }
  | { state: "unreadable"; detail: string };

function parseGuardHolder(raw: unknown, nameGeneration: string): GuardHolder | null {
  if (
    typeof raw === "object" &&
    raw !== null &&
    Number.isInteger((raw as GuardHolder).pid) &&
    (raw as GuardHolder).pid > 0 &&
    typeof (raw as GuardHolder).hostname === "string" &&
    (raw as GuardHolder).hostname.length > 0 &&
    typeof (raw as GuardHolder).startedAt === "string" &&
    (raw as GuardHolder).startedAt.length > 0 &&
    typeof (raw as GuardHolder).generation === "string" &&
    (raw as GuardHolder).generation === nameGeneration
  ) {
    return {
      pid: (raw as GuardHolder).pid,
      hostname: (raw as GuardHolder).hostname,
      startedAt: (raw as GuardHolder).startedAt,
      generation: (raw as GuardHolder).generation,
    };
  }
  return null;
}

/**
 * Inspect the mutex directory without accepting a symlink or unexpected type.
 * It is either absent, empty, or holds exactly one owner entry whose record
 * and filename name the same generation. Everything else refuses.
 */
function inspectGuard(guardPath: string): GuardInspection {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(guardPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { state: "absent" };
    return { state: "unreadable", detail: `the mutex cannot be inspected (${(err as NodeJS.ErrnoException)?.code ?? String(err)})` };
  }
  if (!st.isDirectory()) return { state: "unreadable", detail: "it is not a directory" };

  let entries: string[];
  try {
    entries = readdirSync(guardPath);
  } catch (err) {
    return { state: "unreadable", detail: `its entries cannot be listed (${(err as NodeJS.ErrnoException)?.code ?? String(err)})` };
  }
  if (entries.length === 0) return { state: "empty" };
  if (entries.length !== 1) {
    return { state: "unreadable", detail: `it contains ${entries.length} entries instead of none or one` };
  }
  const name = entries[0];
  const match = OWNER_ENTRY_PATTERN.exec(name);
  if (match === null) return { state: "unreadable", detail: `it contains an unexpected entry ${name}` };

  let fd: number;
  try {
    fd = openSync(join(guardPath, name), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    return { state: "unreadable", detail: `its owner entry cannot be opened (${(err as NodeJS.ErrnoException)?.code ?? String(err)})` };
  }
  try {
    const entryStat = fstatSync(fd);
    if (!entryStat.isFile()) return { state: "unreadable", detail: "its owner entry is not a regular file" };
    const text = readFileSync(fd, "utf-8");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { state: "unreadable", detail: "its owner entry is not valid JSON" };
    }
    const holder = parseGuardHolder(raw, match[1]);
    if (holder === null) {
      return { state: "unreadable", detail: "its owner entry does not name the generation in its filename or lacks a holder field" };
    }
    return { state: "occupied", holder, name, mtimeMs: entryStat.mtimeMs };
  } catch (err) {
    return { state: "unreadable", detail: `its owner entry cannot be read (${(err as NodeJS.ErrnoException)?.code ?? String(err)})` };
  } finally {
    closeSync(fd);
  }
}

type GuardPublishResult =
  | { published: true }
  | { published: false; contention: true }
  | { published: false; contention: false; code: string | undefined };

function publishGuard(guardPath: string, holder: GuardHolder): GuardPublishResult {
  const staging = join(
    dirname(guardPath),
    `.${basename(guardPath)}.${process.pid}.${randomBytes(8).toString("hex")}.stage`,
  );
  try {
    mkdirSync(staging, { mode: 0o700 });
    const fd = openSync(join(staging, ownerEntryName(holder.generation)), "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(holder));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Test-only pause after the populated staging directory is complete and
    // before the rename that publishes it (flair#2866).
    txnPausePointSync("migration-lock-guard-publish", process.env, undefined, {
      guardPath,
      generation: holder.generation,
    });
    try {
      renameSync(staging, guardPath);
      return { published: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST" || code === "ENOTEMPTY") return { published: false, contention: true };
      return { published: false, contention: false, code };
    }
  } catch (err) {
    return { published: false, contention: false, code: (err as NodeJS.ErrnoException)?.code };
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup of our own staging directory */
    }
  }
}

function releaseGuard(guardPath: string, generation: string): { ok: true } | { ok: false; reason: string } {
  try {
    unlinkSync(join(guardPath, ownerEntryName(generation)));
    return { ok: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ok: true };
    return {
      ok: false,
      reason: `its owner entry ${ownerEntryName(generation)} cannot be removed (${(err as NodeJS.ErrnoException)?.code ?? String(err)})`,
    };
  }
}

function settleContention(): void {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sleeper, 0, 0, CONTENTION_SETTLE_MS);
}

type GuardResult = { acquired: true; generation: string } | { acquired: false; reason: string };

function makeGuardHolder(now: () => number): GuardHolder {
  return {
    pid: process.pid,
    hostname: osHostname(),
    startedAt: new Date(now()).toISOString(),
    generation: randomBytes(8).toString("hex"),
  };
}

/**
 * Acquire the directory mutex, recovering a dead generation at most as often
 * as the bounded loop allows. A live local owner is held regardless of age;
 * a remote owner uses the same age policy as the migration record.
 */
function acquireGuard(guardPath: string, deps: LockDeps): GuardResult {
  for (let attempt = 0; attempt < GUARD_ACQUISITION_ATTEMPTS; attempt++) {
    const holder = makeGuardHolder(deps.now);
    const published = publishGuard(guardPath, holder);
    if (published.published) {
      txnPausePointSync("migration-lock-guard-published", process.env, undefined, {
        guardPath,
        generation: holder.generation,
      });
      return { acquired: true, generation: holder.generation };
    }
    if (!published.contention) {
      return {
        acquired: false,
        reason: `${MigrationLockMutexError.name}: the mutex at ${guardPath} cannot be published (${published.code ?? "unknown error"})`,
      };
    }

    const inspected = inspectGuard(guardPath);
    if (inspected.state === "unreadable") {
      return { acquired: false, reason: `${MigrationLockMutexError.name}: ${inspected.detail}` };
    }
    if (inspected.state !== "occupied") {
      settleContention();
      continue;
    }

    let breakable: boolean;
    try {
      breakable = guardHolderIsBreakable(inspected.holder, inspected.mtimeMs, deps);
    } catch (err) {
      if (err instanceof MigrationLockProbeError) {
        return { acquired: false, reason: `${err.name}: ${err.message}` };
      }
      throw err;
    }
    if (!breakable) {
      return {
        acquired: false,
        reason:
          `the migration-lock mutex is held by pid ${inspected.holder.pid} on ${inspected.holder.hostname} ` +
          `since ${inspected.holder.startedAt} (${guardPath})`,
      };
    }

    // Test-only pause after the dead generation is inspected and before its
    // owner entry is unlinked, so a test can let a successor recover and
    // publish before this process resumes its old cleanup (flair#2866).
    txnPausePointSync("migration-lock-guard-reclaim", process.env, undefined, {
      guardPath,
      generation: inspected.holder.generation,
    });
    try {
      // Unlink only the entry this inspection named; never a fresh listing.
      unlinkSync(join(guardPath, inspected.name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        return {
          acquired: false,
          reason: `${MigrationLockMutexError.name}: ${inspected.name} cannot be removed (${(err as NodeJS.ErrnoException)?.code ?? String(err)})`,
        };
      }
      settleContention();
      continue;
    }
    txnPausePointSync("migration-lock-guard-reclaimed", process.env, undefined, {
      guardPath,
      generation: inspected.holder.generation,
    });
    settleContention();
  }
  return { acquired: false, reason: `lost the race to acquire the migration-lock mutex (${guardPath})` };
}

function guardHolderIsBreakable(holder: GuardHolder, mtimeMs: number, deps: LockDeps): boolean {
  if (holder.hostname === osHostname()) return !deps.isProcessAlive(holder.pid);
  return deps.now() - mtimeMs > deps.staleMs;
}

// ─── migration lock protocol ────────────────────────────────────────────────

type UnderGuardOutcome =
  | { kind: "handle"; holder: LockHolder; dev: number; ino: number }
  | { kind: "held"; holder: LockHolder }
  | { kind: "retry" }
  | { kind: "refused"; reason: string };

/**
 * One inspection-and-transition inside the mutex. The lock is inspected
 * afresh here: an inspection made before the mutex was acquired never
 * authorizes replacement.
 */
function transitionUnderGuard(lockPath: string, deps: LockDeps, staleMs: number, now: () => number): UnderGuardOutcome {
  const inspected = inspectLock(lockPath);

  if (inspected.state === "absent") {
    const holder = makeHolder(now);
    const published = publishLock(lockPath, holder);
    if (!published.published) return { kind: "retry" };
    return { kind: "handle", holder, dev: published.dev, ino: published.ino };
  }

  if (inspected.state === "unreadable") {
    const err = new MigrationLockUnreadableError(lockPath, inspected.detail);
    return { kind: "refused", reason: `${err.name}: ${err.message}` };
  }

  const holder = inspected.holder;
  let breakable: boolean;
  try {
    if (holder.hostname === osHostname()) {
      breakable = !deps.isProcessAlive(holder.pid);
    } else {
      breakable = now() - inspected.mtimeMs > staleMs;
    }
  } catch (err) {
    if (err instanceof MigrationLockProbeError) {
      return { kind: "refused", reason: `${err.name}: ${err.message}` };
    }
    throw err;
  }
  if (!breakable) return { kind: "held", holder };

  // Test-only pause between the dead-holder inspection and the rename-over
  // replacement, so a test can put a second contender into that window
  // deterministically (flair#2866).
  txnPausePointSync("migration-lock-reclaim", process.env, undefined, { lockPath });

  const fresh = makeHolder(now);
  let prepared: PreparedRecord;
  try {
    prepared = prepareLockRecord(lockPath, fresh);
  } catch (err) {
    return {
      kind: "refused",
      reason: `refusing to reclaim ${lockPath}: a new holder record cannot be prepared (${(err as NodeJS.ErrnoException)?.code ?? String(err)})`,
    };
  }
  try {
    // Atomic replacement: the old record occupies the name before, the new
    // one after. There is no unlink-first window and no restore step.
    renameSync(prepared.temp, lockPath);
  } catch (err) {
    try {
      unlinkSync(prepared.temp);
    } catch {
      /* best-effort cleanup of our own unpublished record */
    }
    return {
      kind: "refused",
      reason: `refusing to reclaim ${lockPath}: the new holder record cannot be renamed over it (${(err as NodeJS.ErrnoException)?.code ?? String(err)})`,
    };
  }
  txnPausePointSync("migration-lock-reclaimed", process.env, undefined, { lockPath });
  return { kind: "handle", holder: fresh, dev: prepared.dev, ino: prepared.ino };
}

/**
 * Attempts to acquire the migration lock. On success, returns a handle whose
 * `release()` removes the lock file only when it still holds this handle's
 * record, and whose `touch()` updates the mtime of the verified descriptor.
 */
export function acquireMigrationLock(deps: Partial<LockDeps> & { lockPath: string }): AcquireResult {
  const resolved: LockDeps = { ...defaultLockDeps(deps.lockPath), ...deps };
  const { lockPath, staleMs, now } = resolved;
  const guardPath = guardPathFor(lockPath);

  if (inProcessHeld) {
    return { acquired: false, reason: "already held in-process (another async caller in this process holds it)" };
  }
  inProcessHeld = true;

  const abort = (reason: string, holder?: LockHolder): AcquireResult => {
    inProcessHeld = false;
    return holder === undefined ? { acquired: false, reason } : { acquired: false, reason, holder };
  };

  try {
    ensureSecureDir(dirname(lockPath));
  } catch (err) {
    inProcessHeld = false;
    throw err;
  }

  for (let round = 0; round < LOCK_ACQUISITION_ROUNDS; round++) {
    const guard = acquireGuard(guardPath, resolved);
    if (!guard.acquired) return abort(guard.reason);

    let outcome: UnderGuardOutcome;
    try {
      outcome = transitionUnderGuard(lockPath, resolved, staleMs, now);
    } catch (err) {
      const released = releaseGuard(guardPath, guard.generation);
      if (!released.ok) {
        console.warn(`[flair-migrations] migration-lock mutex cleanup failed for ${guardPath}: ${released.reason}`);
      }
      inProcessHeld = false;
      throw err;
    }

    const released = releaseGuard(guardPath, guard.generation);
    if (!released.ok) {
      if (outcome.kind === "handle") {
        return abort(
          `refusing to return the migration lock at ${lockPath}: the mutex could not be released ` +
            `(${released.reason}); the lock file remains`,
        );
      }
      console.warn(`[flair-migrations] migration-lock mutex cleanup failed for ${guardPath}: ${released.reason}`);
    }

    if (outcome.kind === "retry") {
      settleContention();
      continue;
    }
    if (outcome.kind === "refused") return abort(outcome.reason);
    if (outcome.kind === "held") {
      return abort(
        `held by pid ${outcome.holder.pid} on ${outcome.holder.hostname} since ${outcome.holder.startedAt} (lock ${lockPath})`,
        outcome.holder,
      );
    }
    return issueHandle(lockPath, outcome.holder, outcome.dev, outcome.ino, now);
  }

  return abort(`lost the race to acquire the lock file (${lockPath})`);
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
  const guardPath = guardPathFor(lockPath);
  const identity: LockIdentity = {
    lockPath,
    holder,
    dev,
    ino,
    release: () => {
      // The public handle was revoked before this runs. End protected work
      // first, then serialize the identity-checked unlink with the mutex.
      txnPausePointSync("migration-lock-release-revoked", process.env, undefined, { lockPath });
      let cleanupFailure: string | null = null;
      try {
        const guard = acquireGuard(guardPath, defaultLockDeps(lockPath));
        if (!guard.acquired) {
          cleanupFailure = `the mutex could not be acquired: ${guard.reason}`;
        } else {
          txnPausePointSync("migration-lock-release-guard", process.env, undefined, { lockPath, guardPath });
          try {
            const inspected = inspectLock(lockPath);
            if (
              inspected.state === "held" &&
              inspected.dev === dev &&
              inspected.ino === ino &&
              sameHolder(inspected.holder, holder)
            ) {
              txnPausePointSync("migration-lock-release-verified", process.env, undefined, { lockPath });
              try {
                unlinkSync(lockPath);
                txnPausePointSync("migration-lock-release-unlinked", process.env, undefined, { lockPath });
              } catch (err) {
                if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
                  cleanupFailure = `the lock file cannot be removed (${(err as NodeJS.ErrnoException)?.code ?? String(err)})`;
                }
              }
            }
            // An absent or different record belongs to someone else: leave it.
          } catch (err) {
            cleanupFailure = `the lock file cannot be inspected (${(err as NodeJS.ErrnoException)?.code ?? String(err)})`;
          }
          const released = releaseGuard(guardPath, guard.generation);
          if (!released.ok && cleanupFailure === null) cleanupFailure = released.reason;
        }
      } catch (err) {
        cleanupFailure = `the mutex could not be used (${(err as NodeJS.ErrnoException)?.code ?? String(err)})`;
      } finally {
        inProcessHeld = false;
      }
      if (cleanupFailure !== null) {
        // Release runs in the runner's finally: it must not throw, but an
        // uncertain cleanup is reported rather than silently ignored.
        console.warn(
          `[flair-migrations] migration lock cleanup failed for ${lockPath}: ${cleanupFailure}. ` +
            `The record is left in place; inspect it before the next migration cycle`,
        );
      }
    },
    touch: () => {
      const t = new Date(now());
      let fd: number | undefined;
      try {
        fd = openSync(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const st = fstatSync(fd);
        if (!st.isFile() || st.dev !== dev || st.ino !== ino) return;
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(fd, "utf-8"));
        } catch {
          return;
        }
        const record = parseHolder(raw);
        if (record === null || !sameHolder(record, holder)) return;
        txnPausePointSync("migration-lock-touch-verified", process.env, undefined, { lockPath });
        // Same still-open descriptor: a later pathname replacement cannot
        // redirect this update to a successor's file.
        futimesSync(fd, t, t);
      } catch {
        /* best-effort heartbeat — a failed touch must never break the migration */
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            /* best-effort close */
          }
        }
      }
    },
  };
  return new MigrationLockHandle(HANDLE_KEY, identity);
}
