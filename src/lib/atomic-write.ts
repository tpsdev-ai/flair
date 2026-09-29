/**
 * atomic-write.ts — replace a set of files all together, or not at all
 * (flair#2034 §2).
 *
 * The service re-pointing paths (`flair init`, `flair doctor --fix`) rewrite
 * files an operator's service manager reads: a launchd plist, a systemd unit,
 * the federation-sync shim. A write that truncates the file in place and then
 * fails leaves a half-written unit; a two-file update that fails between the
 * files leaves a pair that disagree. Either is worse than not writing at all.
 *
 * `writeFilesAtomically` stages every new file as a temp file in the target's
 * own directory (same filesystem, so the final rename is atomic), fsyncs each
 * one, and only then renames them over their targets. When a rename fails
 * part-way, every target already replaced is restored from the bytes and mode
 * it had before the call, and the remaining temp files are removed. The caller
 * sees either the complete new set or the complete old set.
 *
 * PLANNED FROM THESE BYTES (flair#2034 §2, round 3). A caller that computed
 * the new content FROM the file's current content passes the snapshot it
 * planned from as `expect` (see snapshotRegularFile). Immediately before the
 * rename, the target is lstat'ed and read again: it must still be a regular
 * file (never a symlink — rename would replace the link itself, not the file
 * it points to), the SAME file (device + inode), and hold exactly the planned
 * bytes. Anything else — an operator's edit saved while flair was planning, a
 * file swapped for a symlink — refuses the write and changes nothing. This is a
 * re-check, not a lock: the window between the re-check and the rename is the
 * one syscall apart, and a second flair writer planning from the same bytes
 * computes the same content.
 *
 * BYTES, NOT DECODED TEXT (round 4). A snapshot is taken only of a file whose
 * bytes survive a UTF-8 decode and re-encode unchanged; any other file is
 * refused before anything is planned from it (two different invalid byte
 * sequences decode to the same U+FFFD, so a rewrite would change bytes flair
 * does not own). The re-check compares the file's BYTES with the encoding of
 * the planned content, which is exact for such a file, and the new content is
 * written as its UTF-8 encoding, so every byte outside the replaced values is
 * the byte that was read.
 *
 * The filesystem primitives are injectable so a test can fail any step (a
 * write, an fsync, the Nth rename) and prove the recovery, without a real
 * failing disk.
 */
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

/** The identity and bytes a caller planned from (see snapshotRegularFile). */
export interface PlannedFrom {
  /** The file's bytes, decoded — losslessly: they re-encode to exactly the bytes read. */
  content: string;
  dev: number;
  ino: number;
}

export interface AtomicWriteEntry {
  path: string;
  content: string;
  /** File mode for the new file (e.g. 0o600). */
  mode: number;
  /**
   * The file the new content was planned from. When set, the target is
   * re-checked immediately before its rename and the write is refused unless
   * it is still that regular file (same device + inode) holding exactly those
   * bytes.
   */
  expect?: PlannedFrom;
}

/** The subset of fs.Stats the re-checks read. */
export interface LstatResult {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  dev: number;
  ino: number;
  mode: number;
}

/** A regular file as read for planning: its bytes, mode and identity. */
export interface FileSnapshot extends PlannedFrom {
  path: string;
  /** Permission bits (mode & 0o7777). */
  mode: number;
}

export interface AtomicWriteHooks {
  open?: (path: string, flags: string, mode: number) => number;
  write?: (fd: number, data: string) => void;
  /** Sets the staged file's exact mode (the open() mode is narrowed by the umask). */
  fchmod?: (fd: number, mode: number) => void;
  fsync?: (fd: number) => void;
  close?: (fd: number) => void;
  rename?: (from: string, to: string) => void;
  unlink?: (path: string) => void;
  exists?: (path: string) => boolean;
  read?: (path: string) => string;
  /** The file's raw bytes (snapshots and the pre-rename re-check compare bytes). */
  readBytes?: (path: string) => Buffer;
  modeOf?: (path: string) => number;
  lstat?: (path: string) => LstatResult;
}

interface Resolved {
  open: (path: string, flags: string, mode: number) => number;
  write: (fd: number, data: string) => void;
  fchmod: (fd: number, mode: number) => void;
  fsync: (fd: number) => void;
  close: (fd: number) => void;
  rename: (from: string, to: string) => void;
  unlink: (path: string) => void;
  exists: (path: string) => boolean;
  read: (path: string) => string;
  readBytes: (path: string) => Buffer;
  modeOf: (path: string) => number;
  lstat: (path: string) => LstatResult;
}

function resolveHooks(h: AtomicWriteHooks): Resolved {
  return {
    open: h.open ?? ((p, flags, mode) => openSync(p, flags, mode)),
    write: h.write ?? ((fd, data) => {
      const buf = Buffer.from(data, "utf-8");
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    }),
    fchmod: h.fchmod ?? ((fd, mode) => fchmodSync(fd, mode)),
    fsync: h.fsync ?? ((fd) => fsyncSync(fd)),
    close: h.close ?? ((fd) => closeSync(fd)),
    rename: h.rename ?? ((from, to) => renameSync(from, to)),
    unlink: h.unlink ?? ((p) => unlinkSync(p)),
    exists: h.exists ?? ((p) => existsSync(p)),
    read: h.read ?? ((p) => readFileSync(p, "utf-8")),
    readBytes: h.readBytes ?? ((p) => readFileSync(p)),
    modeOf: h.modeOf ?? ((p) => statSync(p).mode & 0o7777),
    lstat: h.lstat ?? ((p) => lstatSync(p)),
  };
}

/** Why `st` is not a plain regular file, or null. */
function notRegular(path: string, st: LstatResult): string | null {
  if (st.isSymbolicLink()) return `${path} is a symbolic link`;
  if (!st.isFile()) return `${path} is not a regular file`;
  return null;
}

/**
 * Read `path` for planning: it must be a regular file (lstat — a symlink is
 * refused, never followed), it must be the same file before and after the
 * read, and its bytes must be valid UTF-8 that re-encodes to exactly those
 * bytes. Throws an Error naming the path and what did not hold.
 */
export function snapshotRegularFile(
  path: string,
  hooks: Pick<AtomicWriteHooks, "lstat" | "readBytes"> = {},
): FileSnapshot {
  const lstat = hooks.lstat ?? ((p: string) => lstatSync(p));
  const readBytes = hooks.readBytes ?? ((p: string) => readFileSync(p));
  const before = lstat(path);
  const bad = notRegular(path, before);
  if (bad) throw new Error(bad);
  const bytes = readBytes(path);
  const content = bytes.toString("utf-8");
  if (!Buffer.from(content, "utf-8").equals(bytes)) {
    throw new Error(`${path} is not valid UTF-8, so flair cannot rewrite it without changing bytes it does not own`);
  }
  const after = lstat(path);
  if (notRegular(path, after) || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error(`${path} was replaced while it was being read`);
  }
  return { path, content, dev: before.dev, ino: before.ino, mode: before.mode & 0o7777 };
}

/** The re-check before a rename: null when `path` is still the planned file with the planned bytes. */
function plannedFileProblem(fs: Resolved, path: string, expect: PlannedFrom): string | null {
  let st: LstatResult;
  try {
    st = fs.lstat(path);
  } catch (err) {
    return `${path} could not be checked again before replacing it (${(err as Error)?.message ?? err})`;
  }
  const bad = notRegular(path, st);
  if (bad) return bad;
  if (st.dev !== expect.dev || st.ino !== expect.ino) return `${path} was replaced by another file since flair read it`;
  let now: Buffer;
  try {
    now = fs.readBytes(path);
  } catch (err) {
    return `${path} could not be read again before replacing it (${(err as Error)?.message ?? err})`;
  }
  if (!now.equals(Buffer.from(expect.content, "utf-8"))) return `${path} was changed since flair read it`;
  return null;
}

function tempPathFor(target: string): string {
  return join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
}

/** Write `content` to a NEW temp file next to `target`, fsynced and closed. */
function stage(fs: Resolved, target: string, content: string, mode: number): string {
  const tmp = tempPathFor(target);
  const fd = fs.open(tmp, "wx", mode);
  try {
    fs.write(fd, content);
    fs.fchmod(fd, mode);
    fs.fsync(fd);
  } catch (err) {
    try { fs.close(fd); } catch { /* already failing */ }
    try { fs.unlink(tmp); } catch { /* best effort */ }
    throw err;
  }
  fs.close(fd);
  return tmp;
}

/** Best-effort directory fsync so the renames themselves are durable. */
function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {
    /* not every platform allows fsync on a directory; the renames are still atomic */
  }
}

/**
 * Replace every file in `entries`, or none of them.
 *
 * Throws when the set could not be written. The error message says whether the
 * originals were restored; in the (double-failure) case where a restore itself
 * failed, it names every path that may now hold new content.
 */
export function writeFilesAtomically(entries: AtomicWriteEntry[], hooks: AtomicWriteHooks = {}): void {
  const fs = resolveHooks(hooks);

  // 1. Remember what each target held, so a failed commit can put it back.
  //    A planned-from target must already be exactly what was planned from.
  for (const e of entries) {
    if (!e.expect) continue;
    const problem = plannedFileProblem(fs, e.path, e.expect);
    if (problem) throw new Error(`refusing to replace ${e.path}: ${problem}; nothing was changed`);
  }
  const originals = entries.map((e) => {
    if (!fs.exists(e.path)) return { path: e.path, existed: false as const };
    // A planned-from target is restored from the bytes it was re-checked to hold.
    const content = e.expect ? e.expect.content : fs.read(e.path);
    return { path: e.path, existed: true as const, content, mode: fs.modeOf(e.path) };
  });

  // 2. Stage every new file. Nothing visible has changed yet.
  const staged: string[] = [];
  try {
    for (const e of entries) staged.push(stage(fs, e.path, e.content, e.mode));
  } catch (err) {
    for (const tmp of staged) { try { fs.unlink(tmp); } catch { /* best effort */ } }
    throw new Error(
      `could not stage the new ${entries.length === 1 ? "file" : "files"} (${(err as Error)?.message ?? err}); ` +
        `nothing was changed: ${entries.map((e) => e.path).join(", ")}`,
    );
  }

  // 3. Commit: rename each staged file over its target.
  const committed: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    try {
      // Re-check the planned-from target immediately before replacing it.
      const expect = entries[i]!.expect;
      const problem = expect ? plannedFileProblem(fs, entries[i]!.path, expect) : null;
      if (problem) throw new Error(`refusing to replace it: ${problem}`);
      fs.rename(staged[i]!, entries[i]!.path);
      committed.push(i);
    } catch (err) {
      // Remove the temps not yet committed, then put back what was replaced.
      for (let j = i; j < staged.length; j++) { try { fs.unlink(staged[j]!); } catch { /* best effort */ } }
      const unrestored: string[] = [];
      for (const k of committed.reverse()) {
        const o = originals[k]!;
        try {
          if (o.existed) {
            const tmp = stage(fs, o.path, o.content, o.mode);
            fs.rename(tmp, o.path);
          } else {
            fs.unlink(o.path);
          }
        } catch {
          unrestored.push(o.path);
        }
      }
      const cause = (err as Error)?.message ?? String(err);
      if (unrestored.length > 0) {
        throw new Error(
          `could not replace ${entries[i]!.path} (${cause}), and restoring the files already replaced failed for: ` +
            `${unrestored.join(", ")} — those now hold the NEW content while the rest hold the old.`,
        );
      }
      if (committed.length === 0) {
        throw new Error(`could not replace ${entries[i]!.path} (${cause}); nothing was changed`);
      }
      throw new Error(
        `could not replace ${entries[i]!.path} (${cause}); every file was restored to its previous content: ` +
          `${entries.map((e) => e.path).join(", ")}`,
      );
    }
  }
  for (const dir of new Set(entries.map((e) => dirname(e.path)))) fsyncDir(dir);
}
