/**
 * Owner stamp for harness scratch directories (flair#1032 / flair#1372).
 *
 * Directory mtime is not a liveness signal: on Linux, appending to files
 * inside subdirectories does not update the parent. The stamp records the
 * creating process *and* its start time; a sweep may treat a tree as live
 * only when that pid is still alive AND the live start time matches the
 * stamp. A recycled pid therefore fails closed (dead), never "live forever".
 *
 * Harper identity (Kern A1) is the same model: `harperPid` + `harperStartedAt`.
 * Start-time matching reuses `daemon-liveness` (`isStartTimeMatch`, ±2s) and
 * `readProcessStartTimeMs` — no second parser.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isStartTimeMatch } from "./daemon-liveness.js";
import { readProcessStartTimeMs } from "./process-start-time.js";

export const SCRATCH_OWNER_FILE = ".flair-scratch-owner";

export interface ScratchOwnerStamp {
  ownerPid: number;
  ownerStartedAt?: number;
  harperPid?: number;
  harperStartedAt?: number;
}

export type OrphanHarperKillVerdict =
  | { kind: "kill"; pid: number; startedAt: number }
  | { kind: "already-gone" }
  | { kind: "unverified"; reason: string }
  | { kind: "pid-disagreement"; hdbPid: number; harperPid: number };

export function writeScratchOwnerStamp(
  dir: string,
  stamp: Partial<ScratchOwnerStamp> = {},
): void {
  const ownerPid = stamp.ownerPid ?? process.pid;
  const ownerStartedAt = stamp.ownerStartedAt ?? readProcessStartTimeMs(ownerPid) ?? undefined;
  const rec: ScratchOwnerStamp = { ownerPid };
  if (ownerStartedAt != null) rec.ownerStartedAt = ownerStartedAt;
  if (stamp.harperPid != null) rec.harperPid = stamp.harperPid;
  if (stamp.harperStartedAt != null) rec.harperStartedAt = stamp.harperStartedAt;
  writeFileSync(join(dir, SCRATCH_OWNER_FILE), `${JSON.stringify(rec)}\n`, { encoding: "utf-8" });
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

function parseScratchOwnerStamp(content: string): ScratchOwnerStamp | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const ownerPid = Number(obj.ownerPid);
      if (!Number.isInteger(ownerPid) || ownerPid <= 0) return null;
      const stamp: ScratchOwnerStamp = { ownerPid };
      const ownerStartedAt = Number(obj.ownerStartedAt);
      if (Number.isFinite(ownerStartedAt)) stamp.ownerStartedAt = ownerStartedAt;
      const harperPid = Number(obj.harperPid);
      if (Number.isInteger(harperPid) && harperPid > 0) stamp.harperPid = harperPid;
      const harperStartedAt = Number(obj.harperStartedAt);
      if (Number.isFinite(harperStartedAt)) stamp.harperStartedAt = harperStartedAt;
      return stamp;
    } catch {
      return null;
    }
  }
  // Legacy pid-only stamp. No started-at → cannot verify identity.
  const pid = Number(trimmed);
  if (Number.isInteger(pid) && pid > 0) return { ownerPid: pid };
  return null;
}

export function readScratchOwnerStamp(dir: string): ScratchOwnerStamp | null {
  try {
    return parseScratchOwnerStamp(readFileSync(join(dir, SCRATCH_OWNER_FILE), "utf-8"));
  } catch {
    return null;
  }
}

export function readScratchOwnerPid(dir: string): number | null {
  return readScratchOwnerStamp(dir)?.ownerPid ?? null;
}

export function hasScratchOwnerStamp(dir: string): boolean {
  return existsSync(join(dir, SCRATCH_OWNER_FILE));
}

export function readHdbPid(dir: string): number | null {
  return readPidFile(join(dir, "hdb.pid"));
}

function pidMatchesStamp(pid: number, recordedStartedAt: number | undefined): boolean {
  if (recordedStartedAt == null) return false;
  const actual = readProcessStartTimeMs(pid);
  if (actual == null) return false;
  return isStartTimeMatch(actual, recordedStartedAt);
}

/** True when the creating process is still alive AND its start time matches. */
export function scratchOwnerIsLive(dir: string): boolean {
  const stamp = readScratchOwnerStamp(dir);
  if (!stamp || !isPidAlive(stamp.ownerPid)) return false;
  return pidMatchesStamp(stamp.ownerPid, stamp.ownerStartedAt);
}

export function hdbPidIsLive(dir: string): boolean {
  const pid = readHdbPid(dir);
  return pid !== null && isPidAlive(pid);
}

/**
 * Whether a dead-owner tree's Harper pid may be killed.
 *
 * Kill only when `hdb.pid` (or stamped `harperPid`) is alive AND its start
 * time matches `harperStartedAt`. A mismatch is already-gone (the original
 * Harper is not that pid). Disagreement between the two names, or a
 * stampless tree with a live `hdb.pid`, is unverified — fail closed.
 */
export function classifyOrphanHarperKill(dir: string): OrphanHarperKillVerdict {
  const stamp = readScratchOwnerStamp(dir);
  const hdbPid = readHdbPid(dir);

  if (!stamp) {
    if (hdbPid !== null && isPidAlive(hdbPid)) {
      return { kind: "unverified", reason: "stampless tree with live hdb.pid" };
    }
    return { kind: "already-gone" };
  }

  if (hdbPid !== null && stamp.harperPid != null && hdbPid !== stamp.harperPid) {
    return { kind: "pid-disagreement", hdbPid, harperPid: stamp.harperPid };
  }

  const target = hdbPid ?? stamp.harperPid ?? null;
  if (target === null || !isPidAlive(target)) {
    return { kind: "already-gone" };
  }
  if (stamp.harperStartedAt == null) {
    return { kind: "unverified", reason: "stamp has no harperStartedAt" };
  }
  const actual = readProcessStartTimeMs(target);
  if (actual === null) {
    return { kind: "unverified", reason: `could not read the start time of pid ${target}` };
  }
  if (!isStartTimeMatch(actual, stamp.harperStartedAt)) {
    return { kind: "already-gone" };
  }
  return { kind: "kill", pid: target, startedAt: stamp.harperStartedAt };
}
