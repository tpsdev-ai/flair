/**
 * pidfile.ts — the ONE O_NOFOLLOW reader of an instance's `hdb.pid`.
 *
 * `hdb.pid` is written by the Harper process itself at `<rootPath>/hdb.pid`
 * (Harper's ROOTPATH, the data directory). A symlink planted at that path must
 * not redirect the read, so the file is opened with O_NOFOLLOW and read from the
 * fd — `readFileSync` has no such flag (flair#1454 decision 6).
 *
 * Shared by src/cli.ts (the daemon-liveness evidence gatherer behind `flair
 * doctor` / `stop` / `start`) and by src/lib/local-instance-pair.ts, which reads
 * the PID file of the instance an operations endpoint reports when that
 * endpoint's own `system_information` carries no process id (flair#2526).
 */
import { closeSync, constants, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PidfileRead } from "./daemon-liveness.js";

/** A file read that refuses to follow a symlink (O_NOFOLLOW). */
export type NoFollowRead =
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string }
  | { kind: "present"; content: string };

/**
 * Read a file with O_NOFOLLOW so a symlink planted at the pidfile/sidecar path
 * cannot redirect the read (flair#1454 decision 6). `readFileSync` has no such
 * flag, so this opens the fd first and reads from it.
 */
export function readFileNoFollow(path: string): NoFollowRead {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { kind: "absent" };
    if (err?.code === "ELOOP") return { kind: "unreadable", reason: `${path} is a symbolic link` };
    return { kind: "unreadable", reason: `cannot open ${path}: ${err?.code ?? err?.message}` };
  }
  try {
    return { kind: "present", content: readFileSync(fd, "utf-8") };
  } catch (err: any) {
    return { kind: "unreadable", reason: `cannot read ${path}: ${err?.code ?? err?.message}` };
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** Read `hdb.pid` (O_NOFOLLOW) into a `PidfileRead`. */
export function readPidfile(dataDir: string): PidfileRead {
  const r = readFileNoFollow(join(dataDir, "hdb.pid"));
  if (r.kind !== "present") return r;
  const n = Number(r.content.trim());
  if (!Number.isInteger(n) || n <= 0) {
    return { kind: "unreadable", reason: `${join(dataDir, "hdb.pid")} does not contain a valid pid` };
  }
  return { kind: "present", pid: n };
}
