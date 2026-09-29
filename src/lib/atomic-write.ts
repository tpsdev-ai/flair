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
 * The filesystem primitives are injectable so a test can fail any step (a
 * write, an fsync, the Nth rename) and prove the recovery, without a real
 * failing disk.
 */
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteEntry {
  path: string;
  content: string;
  /** File mode for the new file (e.g. 0o600). */
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
  modeOf?: (path: string) => number;
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
  modeOf: (path: string) => number;
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
    modeOf: h.modeOf ?? ((p) => statSync(p).mode & 0o7777),
  };
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
  const originals = entries.map((e) => {
    if (!fs.exists(e.path)) return { path: e.path, existed: false as const };
    return { path: e.path, existed: true as const, content: fs.read(e.path), mode: fs.modeOf(e.path) };
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
      throw new Error(
        `could not replace ${entries[i]!.path} (${cause}); every file was restored to its previous content: ` +
          `${entries.map((e) => e.path).join(", ")}`,
      );
    }
  }
  for (const dir of new Set(entries.map((e) => dirname(e.path)))) fsyncDir(dir);
}
