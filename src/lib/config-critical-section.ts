/**
 * config-critical-section.ts — the ONE exclusive, identity-checked
 * observe → decide → write primitive for Flair's read-modify-write config
 * sinks (flair#1778 slice 2c-i-b, invariant I3b).
 *
 * A config sink that reads a file, decides what it should become, and writes
 * it back is a race when two Flair writers run at once: both read the same
 * bytes, both compute from that stale snapshot, and the second write silently
 * discards the first. Before this module every sink did exactly that with an
 * in-place `writeFileSync` — no lock, no re-check, no atomic replace.
 *
 * This primitive makes observe → decide → write ONE critical section:
 *
 *   1. OBSERVE (before the lock) records THREE things, never one: the
 *      configured ENTRY's identity ({dev, ino}) and type; the RESOLVED
 *      target's realpath + stat; and the RESOLVED PARENT directory's realpath
 *      + {dev, ino}. ABSENCE is explicit — the target is "absent" only when
 *      the configured entry does not exist AND the parent resolves. A dangling
 *      symlink is not absence; EACCES / ELOOP / ENOTDIR are resolution ERRORS
 *      and HOLD, never "absent".
 *   2. LOCK: an `O_EXCL` create of `<resolvedTarget>.lock`, beside the
 *      RESOLVED target so stable symlink aliases share one lock, computed once
 *      per attempt. Content is diagnostic only (`<pid> <iso> <hostname>`),
 *      never an authorization input. Bounded retry then a NAMED refusal. No
 *      reclaim, no age-out, no pid-liveness shortcut.
 *   3. RE-OBSERVE INSIDE the lock and compare. Any change of entry type,
 *      entry identity, resolved path, target identity, parent identity or
 *      absence state HELDS the write (fixture 11/12), naming which
 *      observation changed.
 *   4. READ inside the lock, then call `decide(bytes, identity)`. The callback
 *      returns a DECISION and cannot write. (This does not make it pure — it
 *      can still import fs or close over stale state — so sinks are covered by
 *      an import-boundary fixture as well; TypeScript does not enforce it.)
 *   5. WRITE (on `{ write }`): a temp `<resolvedTarget>.tmp-<pid>-<rand>`
 *      created `wx` mode 0600 BEFORE any bytes, written, chmod'd to the
 *      ORIGINAL's permission bits (new file 0600; setuid/setgid/sticky
 *      stripped; special file types rejected), owner/group preserved with
 *      `fchown` or REFUSED before rename, `fsync` → rename → best-effort
 *      parent `fsync`. Rename lands on the RESOLVED target, never the
 *      configured symlink. A failure BEFORE the rename leaves the original
 *      intact ("nothing written"); a failure AFTER it is a COMMITTED write
 *      with a cleanup warning, never reported as "nothing written".
 *
 * BACKUP SEMANTICS. `opts.backup` runs on the IN-LOCK bytes BEFORE `decide` on
 * every call that reaches the read — INCLUDING calls whose decision ends up
 * noop or held. A backup of the current bytes is never wrong; the churn is the
 * price of backing up before parsing. It is skipped only where the read is
 * skipped: an absent destination, or a non-regular one (refused above).
 *   6. FRESH-ATTEMPT PROTOCOL: another cooperative writer's committed
 *      replacement changes the target inode, so a waiting writer's in-lock
 *      comparison FAILS and it is HELD — by design, never waived. The
 *      primitive runs up to K=3 complete fresh attempts, retrying ONLY when
 *      the change is "target identity changed AND entry type unchanged AND new
 *      target is a regular file" (a committed replacement). A type change,
 *      retarget, parent change or absence change is a FINAL hold. Every
 *      attempt decides on ITS OWN in-lock bytes; nothing precomputed crosses
 *      attempts; exhausting the bound is a HOLD-with-reason, never a throw.
 *
 * THREAT BOUNDARY (flair#1778 2c-i-b design review, convergent). This
 * primitive serializes cooperative Flair writers and detects identity changes
 * made before its final check; it does not defend against an ancestor
 * directory replaced between that check and the rename — a pathname is not a
 * pinned directory handle, and Node exposes no openat-relative rename.
 *
 * FILESYSTEM GUARANTEES. The exclusive create/rename guarantees hold on macOS
 * APFS (probed: O_EXCL→EEXIST, same-directory rename atomic, directory fsync
 * honoured) and on Linux ext4/xfs. On NFS/SMB homes O_EXCL is not reliable:
 * there the lock may not serialize at all, and safety DEGRADES to the in-lock
 * re-observe plus the fresh-attempt protocol — this module never claims
 * serialization on those filesystems. A stale lock left by another host on a
 * shared home is a NAMED availability residual: the refusal names the recorded
 * host and the operator may not have it. This primitive REFUSES on a held
 * lock; it never reclaims one (two reclaimers can rename a LIVE lock away, pid
 * reuse lies, and a blank/partially written lock is refused too).
 *
 * METADATA / BEHAVIOUR CHANGE. Every config sink this replaces writes IN PLACE
 * and preserves the inode. Temp+rename REPLACES the inode, so: (a) an
 * owner/group change the process cannot preserve is a REFUSE, never a silent
 * success — UNTESTED (needs a privilege drop): exercising the refusal needs the
 * ORIGINAL to be owned by a uid the process cannot `fchown` the replacement to,
 * which a same-user fixture cannot arrange, so this branch is covered by review,
 * not by a test; (b) a client holding an open fd keeps the OLD inode until it reopens
 * (every wired client re-reads at startup). ACL, xattr and hard-link
 * preservation are NOT handled and are documented, not silently dropped.
 *
 * Leaf module: imports only node:fs, node:crypto, node:os and node:path.
 * NEVER import src/cli.ts here — its `writeFileAtomic` lacks exclusive temp
 * creation, fsync, locking and identity checks (flair#1778 2c-i-b ruling).
 */
import {
  closeSync,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

// ── observations ────────────────────────────────────────────────────────────

export type ConfigEntryType = "regular" | "symlink" | "other" | "absent";

export interface ConfigEntryObservation {
  /** What the CONFIGURED path (as named) is: `lstat` semantics. */
  type: ConfigEntryType;
  dev: number | null;
  ino: number | null;
}

export interface ConfigTargetObservation {
  /** The canonical (realpath) path of the file a read would access. For an
   *  absent entry this is synthesized from the resolved parent, so callers can
   *  still name the destination that would be created. */
  path: string;
  type: ConfigEntryType;
  dev: number | null;
  ino: number | null;
  mode: number | null;
  uid: number | null;
  gid: number | null;
}

export interface ConfigParentObservation {
  /** realpath of the parent directory. */
  path: string;
  dev: number;
  ino: number;
}

/** The three-part observation: configured entry, resolved target, resolved
 *  parent. Passed to `decide` as the `identity` argument, and the in-lock
 *  re-observe compares all of it. */
export interface ConfigObservation {
  entry: ConfigEntryObservation;
  target: ConfigTargetObservation;
  parent: ConfigParentObservation;
}

/** The observation field whose change held the write (fixture 11/12). */
export type ConfigObservationField =
  | "entry-type"
  | "entry-identity"
  | "absence"
  | "resolved-path"
  | "target-identity"
  | "parent-identity";

// ── decision + result ───────────────────────────────────────────────────────

/** What `decide` returns. It cannot write; the primitive performs the
 *  authorized replacement. */
export type ConfigDecision =
  | { write: Uint8Array }
  | { hold: string }
  | { noop: string };

export type ConfigDecide = (bytes: Uint8Array | null, identity: ConfigObservation) => ConfigDecision;

export interface ConfigSectionOptions {
  /** Invoked on the IN-LOCK bytes before `decide`, only when a file exists.
   *  Returns the backup path (or null). Throwing short-circuits to a named
   *  refusal BEFORE `decide` runs: nothing is written. */
  backup?: (bytes: Uint8Array) => string | null | void;
  /** Maximum COMPLETE fresh attempts (default 3). */
  maxAttempts?: number;
  /** Lock acquisition: bounded retry (default 40 × 50 ms). */
  lockRetry?: { attempts?: number; delayMs?: number };
  /** TEST-ONLY deterministic barriers at the production read/write boundary.
   *  Inert unless a fixture sets them. `afterPreObserve` fires between the
   *  pre-lock observation and the lock; `afterRead` fires between the in-lock
   *  read and `decide`; `afterTempCreate` fires right after the staging file is
   *  created and before any bytes are written. Child-process fixtures use the
   *  `FLAIR_TEST_CRITICAL_BARRIER` env directory instead (see `envBarrier`). */
  testHooks?: {
    afterPreObserve?: (attempt: number) => void;
    afterRead?: (attempt: number) => void;
    afterTempCreate?: (tempPath: string) => void;
  };
}

export type ConfigSectionStatus = "written" | "noop" | "held" | "refused";

export interface ConfigSectionResult {
  status: ConfigSectionStatus;
  /** The RESOLVED target path the primitive operated on. */
  path: string;
  /** Which complete attempt produced this result (1-based). */
  attempts: number;
  /** Human line for noop/held/refused; empty for a plain write. */
  message: string;
  /** For a held write: which observation changed (fixture 11/12). */
  changed?: ConfigObservationField;
  /** Backup path when `opts.backup` ran. */
  backupPath?: string | null;
  /** True once the rename landed, even if a later cleanup step warned. */
  committed?: boolean;
  /** Set when the write COMMITTED but a post-rename cleanup step failed. */
  cleanupWarning?: string | null;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Synchronous backoff without blocking the process on a sleep primitive that
 *  differs between bun and node. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** ENV-GATED barrier for child-process fixtures: after marking its own stage
 *  file it waits (bounded) for a `go` file the schedule controller drops.
 *  Inert unless `FLAIR_TEST_CRITICAL_BARRIER` names a directory. */
function envBarrier(stage: string): void {
  const dir = process.env.FLAIR_TEST_CRITICAL_BARRIER;
  if (!dir) return;
  try { writeFileSync(join(dir, `${process.pid}.${stage}`), "1"); } catch { /* */ }
  const go = join(dir, "go");
  const deadline = Date.now() + 15_000;
  while (!existsSync(go) && Date.now() < deadline) sleepSync(5);
}

function barrier(hook: ((attempt: number) => void) | undefined, stage: string, attempt: number): void {
  envBarrier(stage);
  hook?.(attempt);
}

function isRegularMode(mode: number): boolean {
  return (mode & 0o170000) === 0o100000;
}

function entryTypeOf(st: Stats): ConfigEntryType {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isFile()) return "regular";
  return "other";
}

function targetTypeOf(st: Stats): ConfigEntryType {
  if (st.isFile()) return "regular";
  return "other";
}

// ── observation ─────────────────────────────────────────────────────────────

type ObserveResult =
  | { ok: true; value: ConfigObservation; reason?: undefined }
  | { ok: false; value?: undefined; reason: string };

/**
 * The one observation: configured entry (`lstat`), resolved target (realpath +
 * `stat`), resolved parent (realpath + `stat`). Total: every failure to resolve
 * is reported as a reason, never coerced to "absent".
 */
export function observeConfig(configPath: string): ObserveResult {
  const parentDir = dirname(configPath);

  let parentPath: string;
  let parentStat: Stats;
  try {
    parentPath = realpathSync(parentDir);
    parentStat = statSync(parentPath);
  } catch (err) {
    return { ok: false, reason: `cannot resolve the parent directory ${parentDir}: ${msg(err)}` };
  }
  const parent: ConfigParentObservation = { path: parentPath, dev: parentStat.dev, ino: parentStat.ino };

  let entryStat: Stats | null;
  try {
    entryStat = lstatSync(configPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") entryStat = null;
    else return { ok: false, reason: `cannot stat ${configPath}: ${msg(err)}` };
  }

  if (entryStat === null) {
    // Absent entry, parent resolves → explicit ABSENCE.
    const targetPath = join(parentPath, basename(configPath));
    return {
      ok: true,
      value: {
        entry: { type: "absent", dev: null, ino: null },
        target: { path: targetPath, type: "absent", dev: null, ino: null, mode: null, uid: null, gid: null },
        parent,
      },
    };
  }

  const entry: ConfigEntryObservation = { type: entryTypeOf(entryStat), dev: entryStat.dev, ino: entryStat.ino };

  // Resolve the target: a read follows the entry (realpath). A dangling
  // symlink / EACCES / ELOOP / ENOTDIR here is a resolution ERROR → hold.
  let targetPath: string;
  try {
    targetPath = realpathSync(configPath);
  } catch (err) {
    return { ok: false, reason: `cannot resolve ${configPath} to a target: ${msg(err)}` };
  }
  let targetStat: Stats;
  try {
    targetStat = statSync(targetPath);
  } catch (err) {
    return { ok: false, reason: `cannot stat the resolved target ${targetPath}: ${msg(err)}` };
  }

  return {
    ok: true,
    value: {
      entry,
      target: {
        path: targetPath,
        type: targetTypeOf(targetStat),
        dev: targetStat.dev,
        ino: targetStat.ino,
        mode: targetStat.mode,
        uid: targetStat.uid,
        gid: targetStat.gid,
      },
      parent,
    },
  };
}

function resolvedTargetPath(obs: ConfigObservation, configPath: string): string {
  if (obs.target.type === "absent") return join(obs.parent.path, basename(configPath));
  return obs.target.path;
}

/** First changed field, in a fixed order. Entry TYPE first (a regular entry
 *  replaced by a symlink), then absence, then PARENT identity (an ancestor
 *  swapped), then a SYMLINK entry's own link identity (replaced link), then
 *  the resolved path (a retarget), then the target identity (a committed
 *  replacement of the file). For a plain regular entry the entry's and the
 *  target's identity are the same inode, so the committed-replacement case is
 *  reported as `target-identity` and stays retryable. Null when identical. */
export function compareObservation(a: ConfigObservation, b: ConfigObservation): ConfigObservationField | null {
  if (a.entry.type !== b.entry.type) return "entry-type";
  const aAbsent = a.target.type === "absent";
  const bAbsent = b.target.type === "absent";
  if (aAbsent !== bAbsent) return "absence";
  if (a.parent.dev !== b.parent.dev || a.parent.ino !== b.parent.ino) return "parent-identity";
  if (a.entry.type === "symlink" && (a.entry.dev !== b.entry.dev || a.entry.ino !== b.entry.ino)) {
    return "entry-identity";
  }
  if (!aAbsent && a.target.path !== b.target.path) return "resolved-path";
  if (!aAbsent && (a.target.dev !== b.target.dev || a.target.ino !== b.target.ino)) return "target-identity";
  return null;
}

const FIELD_LABEL: Record<ConfigObservationField, string> = {
  "entry-type": "the configured entry's type",
  "entry-identity": "the configured entry's identity",
  absence: "the destination's presence",
  "resolved-path": "the resolved target path",
  "target-identity": "the target's identity",
  "parent-identity": "the resolved parent directory's identity",
};

function heldLine(field: ConfigObservationField): string {
  return `held: ${FIELD_LABEL[field]} changed between the pre-lock observation and the in-lock re-observe — nothing written (another Flair writer touched the destination).`;
}

// ── lock ────────────────────────────────────────────────────────────────────

export interface ConfigLockHandle {
  path: string;
  holder: string | null;
}

function parseLockHolder(raw: string | null): { pid: string; timestamp: string; host: string } | null {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d+)\s+(\S+)\s+(\S+)$/);
  if (!m) return null;
  return { pid: m[1]!, timestamp: m[2]!, host: m[3]! };
}

function lockRefusalLine(lockPath: string, holder: string | null): string {
  const parsed = parseLockHolder(holder);
  if (parsed) {
    return (
      `lock exists at ${lockPath}; recorded holder pid ${parsed.pid} since ${parsed.timestamp} on host ${parsed.host}. ` +
      `Quiesce Flair writers and check the recorded holder ON THAT HOST before removing the file.`
    );
  }
  return (
    `lock exists at ${lockPath} and its contents are not a readable holder record (blank or partially written); refusing to write. ` +
    `Quiesce Flair writers and check the recorded holder ON THAT HOST before removing the file.`
  );
}

function acquireLock(
  lockPath: string,
  retry: { attempts: number; delayMs: number },
): { ok: true; holder?: undefined } | { ok: false; holder: string | null } {
  for (let i = 0; i < retry.attempts; i++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, `${process.pid} ${new Date().toISOString()} ${hostname()}\n`);
      } catch {
        // The lock exists (that is what protects us); a failed diagnostic
        // write is not fatal, and the content is never an authorization input.
      } finally {
        try { closeSync(fd); } catch { /* already closed */ }
      }
      return { ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return { ok: false, holder: null };
      if (i < retry.attempts - 1) sleepSync(retry.delayMs);
    }
  }
  let holder: string | null = null;
  try { holder = readFileSync(lockPath, "utf-8"); } catch { holder = null; }
  return { ok: false, holder };
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* best effort; a leaked lock refuses, never corrupts */ }
}

// ── atomic replacement ──────────────────────────────────────────────────────

type ReplaceResult =
  | { ok: true; cleanupWarning: string | null; reason?: undefined }
  | { ok: false; reason: string; cleanupWarning?: undefined };

function writeAllSync(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

/**
 * Temp (wx, 0600) → write → fchmod to the original bits → fchown owner/group
 * or refuse → fsync → rename onto the RESOLVED target → best-effort parent
 * fsync. A failure before the rename leaves the original untouched.
 */
export function atomicReplace(
  targetPath: string,
  bytes: Uint8Array,
  original: { mode: number; uid: number; gid: number } | null,
  onTempCreate?: (tempPath: string) => void,
): ReplaceResult {
  if (original && !isRegularMode(original.mode)) {
    return { ok: false, reason: `the destination ${targetPath} is not a regular file (mode ${original.mode.toString(8)}); refusing to replace it` };
  }
  const dir = dirname(targetPath);
  const tempPath = `${targetPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;

  let fd = -1;
  const cleanupTemp = () => { try { unlinkSync(tempPath); } catch { /* nothing to remove */ } };
  const fail = (reason: string): ReplaceResult => {
    if (fd >= 0) { try { closeSync(fd); } catch { /* */ } fd = -1; }
    cleanupTemp();
    return { ok: false, reason };
  };

  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    fd = openSync(tempPath, "wx", 0o600);
    onTempCreate?.(tempPath);
    writeAllSync(fd, buf);

    const perm = original ? (original.mode & 0o777) : 0o600;
    try { fchmodSync(fd, perm); }
    catch (err) { return fail(`could not set mode ${perm.toString(8)} on the staging file: ${msg(err)}`); }

    if (original) {
      let fchownError: unknown = null;
      try { fchownSync(fd, original.uid, original.gid); }
      catch (err) { fchownError = err; }
      if (fchownError !== null) {
        let cur: Stats | null = null;
        try { cur = fstatSync(fd); } catch { cur = null; }
        if (!cur || cur.uid !== original.uid || cur.gid !== original.gid) {
          return fail(
            `cannot preserve owner/group ${original.uid}:${original.gid} on the replacement (${msg(fchownError)}); ` +
            `refusing to change ownership silently`,
          );
        }
      }
    }

    try { fsyncSync(fd); }
    catch (err) { return fail(`could not fsync the staging file: ${msg(err)}`); }
  } catch (err) {
    return fail(`staging the replacement failed: ${msg(err)}`);
  } finally {
    if (fd >= 0) { try { closeSync(fd); } catch { /* */ } }
  }

  try { renameSync(tempPath, targetPath); }
  catch (err) { cleanupTemp(); return { ok: false, reason: `could not rename the staging file into place: ${msg(err)}` }; }

  let cleanupWarning: string | null = null;
  try {
    const dfd = openSync(dir, "r");
    try { fsyncSync(dfd); } finally { try { closeSync(dfd); } catch { /* */ } }
  } catch (err) {
    cleanupWarning = `the replacement is committed but the directory fsync failed: ${msg(err)}`;
  }
  return { ok: true, cleanupWarning };
}

// ── the primitive ───────────────────────────────────────────────────────────

/**
 * Observe → lock → re-observe → read → decide → write, as ONE critical
 * section. See the module docblock for the full contract.
 */
export function withConfigCriticalSection(
  configPath: string,
  decide: ConfigDecide,
  opts: ConfigSectionOptions = {},
): ConfigSectionResult {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const lockRetry = { attempts: opts.lockRetry?.attempts ?? 40, delayMs: opts.lockRetry?.delayMs ?? 50 };
  let attempts = 0;
  let lastHold: ConfigSectionResult | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;

    // 1. OBSERVE (before the lock).
    const pre = observeConfig(configPath);
    if (!pre.ok) {
      return { status: "held", path: configPath, attempts, message: pre.reason };
    }
    const preObs = pre.value;
    const targetPath = resolvedTargetPath(preObs, configPath);
    barrier(opts.testHooks?.afterPreObserve, "preObserve", attempt);

    // 2. LOCK (computed once per attempt).
    const lockPath = `${targetPath}.lock`;
    const lock = acquireLock(lockPath, lockRetry);
    if (!lock.ok) {
      return { status: "refused", path: targetPath, attempts, message: lockRefusalLine(lockPath, lock.holder) };
    }

    try {
      // 3. RE-OBSERVE inside the lock.
      const inLock = observeConfig(configPath);
      if (!inLock.ok) {
        return { status: "held", path: targetPath, attempts, message: `held: ${inLock.reason} — nothing written.` };
      }
      const obs = inLock.value;
      const changed = compareObservation(preObs, obs);
      if (changed) {
        const retryable =
          changed === "target-identity" &&
          obs.entry.type === preObs.entry.type &&
          obs.target.type === "regular";
        const line = heldLine(changed);
        if (retryable && attempt < maxAttempts) {
          lastHold = { status: "held", path: targetPath, attempts, message: line, changed };
          continue; // fresh attempt: re-observe from scratch
        }
        return { status: "held", path: targetPath, attempts, message: line, changed };
      }

      if (obs.target.type === "other") {
        return { status: "refused", path: targetPath, attempts, message: `the destination ${targetPath} is not a regular file; refusing to write it.` };
      }

      // 4. READ inside the lock.
      let bytes: Uint8Array | null = null;
      if (obs.target.type === "regular") {
        try {
          bytes = readFileSync(obs.target.path);
        } catch (err) {
          return { status: "held", path: targetPath, attempts, message: `held: could not read ${obs.target.path}: ${msg(err)} — nothing written.` };
        }
      }

      // Backup on the IN-LOCK bytes, before decide. A failure short-circuits.
      let backupPath: string | null = null;
      if (opts.backup && bytes !== null) {
        try {
          const r = opts.backup(bytes);
          backupPath = typeof r === "string" ? r : null;
        } catch (err) {
          return { status: "refused", path: targetPath, attempts, message: `backup failed before deciding: ${msg(err)} — nothing written.` };
        }
      }

      barrier(opts.testHooks?.afterRead, "read", attempt);
      const decision = decide(bytes, obs);
      if ("hold" in decision) {
        return { status: "held", path: targetPath, attempts, message: decision.hold, backupPath };
      }
      if ("noop" in decision) {
        return { status: "noop", path: targetPath, attempts, message: decision.noop, backupPath };
      }

      // 5. WRITE.
      const original = obs.target.type === "regular"
        ? { mode: obs.target.mode!, uid: obs.target.uid!, gid: obs.target.gid! }
        : null;
      const wr = atomicReplace(targetPath, decision.write, original, opts.testHooks?.afterTempCreate);
      if (!wr.ok) {
        return { status: "refused", path: targetPath, attempts, message: `nothing written: ${wr.reason}`, backupPath };
      }
      return {
        status: "written",
        path: targetPath,
        attempts,
        message: "",
        backupPath,
        committed: true,
        cleanupWarning: wr.cleanupWarning,
      };
    } finally {
      // 6. RELEASE in finally, including when decide() throws.
      releaseLock(lockPath);
    }
  }

  return lastHold ?? {
    status: "held",
    path: configPath,
    attempts,
    message: `held: the destination changed on every one of ${maxAttempts} attempts — nothing written.`,
  };
}
