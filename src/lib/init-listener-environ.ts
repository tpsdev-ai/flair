/**
 * ROOTPATH of a process `flair init` did not start (flair#1749).
 *
 * Linux reads `/proc/<pid>/environ` (NUL-separated, so a space in the path
 * stays part of the value). macOS `ps -E` output does not separate arguments
 * from the environment, so it cannot establish ROOTPATH. On macOS, and on
 * any failed read, the directory is unavailable. Init must not refuse
 * before auth from a directory it cannot read, and must not invent one.
 *
 * Daemon sidecar recovery keeps its own reader. This module is init's.
 */
import { readFileSync } from "node:fs";
import { extractRootPath, parseNullSeparatedEnviron } from "./daemon-liveness.js";

export interface InitListenerRootPath {
  rootPath: string | null;
  /** False when the read failed or this platform cannot establish ROOTPATH. */
  environReadable: boolean;
}

const UNAVAILABLE: InitListenerRootPath = { rootPath: null, environReadable: false };

/**
 * Platform gate. Anything other than Linux is unavailable and does not call
 * `readLinuxProc` — macOS must not parse `ps -E` and then treat the result
 * as a data directory.
 */
export function listenerRootPathOnPlatform(
  platform: NodeJS.Platform,
  readLinuxProc: () => InitListenerRootPath,
): InitListenerRootPath {
  if (platform !== "linux") return UNAVAILABLE;
  return readLinuxProc();
}

/** Init-only. Linux `/proc/<pid>/environ`. Unavailable on every other platform. */
export function readInitListenerRootPath(pid: number): InitListenerRootPath {
  return listenerRootPathOnPlatform(process.platform, () => {
    if (!Number.isInteger(pid) || pid <= 0) return UNAVAILABLE;
    try {
      const raw = readFileSync(`/proc/${pid}/environ`, "utf-8");
      return { rootPath: extractRootPath(parseNullSeparatedEnviron(raw)), environReadable: true };
    } catch {
      return UNAVAILABLE;
    }
  });
}
