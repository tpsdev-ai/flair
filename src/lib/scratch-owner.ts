/**
 * Owner stamp for harness scratch directories (flair#1032).
 *
 * Directory mtime is not a liveness signal: on Linux, appending to files
 * inside subdirectories does not update the parent. The stamp records the
 * creating process; a sweep may delete a tree only when that process is gone
 * (and, for Harper trees, when `hdb.pid` is gone too).
 */
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SCRATCH_OWNER_FILE = ".flair-scratch-owner";

export function writeScratchOwnerStamp(dir: string, pid = process.pid): void {
  writeFileSync(join(dir, SCRATCH_OWNER_FILE), `${pid}\n`, { encoding: "utf-8" });
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, "utf-8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function readScratchOwnerPid(dir: string): number | null {
  return readPidFile(join(dir, SCRATCH_OWNER_FILE));
}

export function hasScratchOwnerStamp(dir: string): boolean {
  return existsSync(join(dir, SCRATCH_OWNER_FILE));
}

/** True when the creating process is still alive. Unreadable stamp → not live. */
export function scratchOwnerIsLive(dir: string): boolean {
  const pid = readScratchOwnerPid(dir);
  return pid !== null && isPidAlive(pid);
}

export function hdbPidIsLive(dir: string): boolean {
  const pid = readPidFile(join(dir, "hdb.pid"));
  return pid !== null && isPidAlive(pid);
}

/**
 * True only for a real directory, not a symlink.
 *
 * Must run before any stamp/`hdb.pid`/mtime read or `rmSync`. Those follow
 * links; a `flair-test-*` symlink in `$TMPDIR` pointing outside would
 * otherwise let a sweep delete the target (Kern on #1408).
 */
export function isRealScratchDirectory(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}
