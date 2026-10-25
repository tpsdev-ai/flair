/**
 * dir-safety.ts — 0700 directory enforcement for migration snapshot/export
 * dirs (Sherlock verdict: "0700 via stat-verify after creation (umask can
 * override mkdir mode) and before writes; refuse with the path + actual
 * perms named in the error." — "the safety mechanism must not become the
 * exfil surface... export dir = highest-value target on the system.")
 *
 * `ensureSecureDir` creates-or-verifies a directory is 0700: it mkdirs with
 * mode 0700, then explicitly `chmodSync`s to 0700 (covers a permissive
 * umask silently widening mkdir's mode argument), then stat-verifies the
 * result. If the directory STILL isn't 0700 after the explicit chmod
 * (unusual filesystem/ACL), it refuses loudly rather than silently
 * proceeding into a world-readable directory — naming the exact path and
 * actual octal perms in the thrown error, per Sherlock's wording.
 *
 * `verifySecureDir` is exported separately so callers can (and must)
 * re-verify immediately before EACH write inside the directory, not only at
 * creation time (Kern: "Perms re-verified at write time, not only
 * creation.") — a directory can be re-permissioned by something else on the
 * host between creation and a later write in a long-running batch loop.
 */
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

export class UnsafeDirectoryError extends Error {
  constructor(
    public readonly path: string,
    public readonly actualMode: number,
  ) {
    super(
      `refusing to use ${path}: expected 0700, found ${actualMode.toString(8).padStart(4, "0")} ` +
        `(group/other-accessible) — fix permissions (chmod 700 ${path}) or point the migration ` +
        `at a different directory`,
    );
    this.name = "UnsafeDirectoryError";
  }
}

/** Throws UnsafeDirectoryError if `dir`'s mode has any group/other bits set. */
export function verifySecureDir(dir: string): void {
  const st = statSync(dir);
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new UnsafeDirectoryError(dir, mode);
  }
}

/**
 * Ensures `dir` exists and is 0700. Idempotent — safe to call before every
 * write. Never silently tolerates a world/group-readable result: attempts
 * one explicit chmod(0700) remediation (covers the umask-widened-mkdir
 * case), then re-verifies and throws if it's still not compliant.
 */
export function ensureSecureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: 0o700 });
  }
  try {
    verifySecureDir(dir);
  } catch (err) {
    if (!(err instanceof UnsafeDirectoryError)) throw err;
    chmodSync(dir, 0o700);
    verifySecureDir(dir); // throws again (loudly) if the chmod didn't stick
  }
}

/** Test seam: the random part of {@link writeSecureFile}'s temporary file name. */
export const secureFileTempSuffix = { next: (): string => randomBytes(8).toString("hex") };

/** Test seam: the data flush {@link writeSecureFile} makes before its rename. */
export const secureFileFsync = { sync: (fd: number): void => fsyncSync(fd) };

/**
 * Writes `contents` to `path` at 0600, re-verifying the CONTAINING
 * directory is still 0700 immediately before the write (per Kern's
 * write-time re-verification requirement above).
 *
 * The write is ATOMIC: the contents go to a fresh temporary file beside the
 * target (same directory, so the rename stays on one filesystem), created with
 * mode 0600 (the process umask can only remove bits from it), which is then
 * renamed over the target. Once the target exists, a concurrent reader
 * observes either the old file or the new file — never a truncated or
 * half-written one (a plain writeFileSync truncates first and fills second, so
 * a reader can land in between and see an empty or partial file); before the
 * first rename there is no file to read. The temporary file's data is flushed
 * (fsyncSync) before the rename, so after a power loss or OS crash the target
 * is not left empty or truncated. The rename's directory entry itself is NOT
 * fsynced.
 *
 * What this does NOT solve: two concurrent WRITERS still race on their
 * read-modify-write cycles (last rename wins, the other writer's entry is
 * lost). Serializing writers is a separate follow-up, not done here.
 */
export function writeSecureFile(path: string, contents: string, dir: string): void {
  verifySecureDir(dir);
  const targetDir = dirname(path);
  const temp = join(targetDir, `.${basename(path)}.${process.pid}.${secureFileTempSuffix.next()}.tmp`);
  // Set once the exclusive create succeeds. The catch unlinks the temporary
  // path only when it is set, so a pre-existing file at that path is left in
  // place when the create fails on it.
  let created = false;
  try {
    const fd = openSync(temp, "wx", 0o600);
    created = true;
    try {
      writeFileSync(fd, contents);
      // Flush the data before the rename publishes the name: without this a
      // crash can keep the rename but lose the data, leaving an empty or
      // truncated target that reads as no record.
      secureFileFsync.sync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (err) {
    if (created) {
      try {
        unlinkSync(temp);
      } catch {
        // The original error is the one worth surfacing.
      }
    }
    throw err;
  }
}
