/**
 * Live-process start time in epoch ms.
 *
 * Parsers and the ±2s match live in `daemon-liveness.ts` (pure). This file
 * is the I/O adapter those parsers need: Linux `/proc/<pid>/stat` field 22
 * plus `/proc/uptime`, macOS `ps -o lstart=`. One reader for the production
 * daemon identity check and the harness scratch-owner stamp (flair#1372).
 *
 * Darwin `ps -o lstart=` prints local time without a zone. `Date.parse` of
 * that string uses the JS engine's zone — and `bun test` forces UTC even
 * when the host is not (Kern on #1708: a PDT parent stamp vs a UTC sweep
 * was 7h off). Self-calibrate against this process: parse our own lstart,
 * subtract our true start (`Date.now() - process.uptime()*1000`), and apply
 * that offset to the target. Kern wrote `offset = parse(ownLstart) - Date.now()`;
 * without uptime that offset is process age, not zone skew, and owner
 * stamps would drift. Uptime is what makes the offset the parser's zone
 * error. Linux `/proc` is already zone-independent.
 *
 * A null answer is "unverified" — it never decides a verdict toward a
 * destructive branch.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  parseProcStatStartTime,
  parsePsLstart,
  procStartTimeToEpochMs,
} from "./daemon-liveness.js";

/**
 * Undo a zone-skewed `parsePsLstart` using this process as the reference.
 *
 * `offset = ownParsedMs - ownTrueStartMs`. Subtract that from the target
 * parse so a 7h PDT-vs-UTC bun-test skew (Kern #1708) cancels out.
 */
export function applyLstartZoneOffset(
  targetParsedMs: number,
  ownParsedMs: number,
  ownTrueStartMs: number,
): number {
  return targetParsedMs - (ownParsedMs - ownTrueStartMs);
}

function readPsLstart(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      env: { ...(process.env as Record<string, string>), LC_ALL: "C" },
      timeout: 2000,
    });
  } catch {
    return null;
  }
}

export function readProcessStartTimeMs(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      const starttime = parseProcStatStartTime(stat);
      if (starttime === null) return null;
      const uptimeRaw = readFileSync("/proc/uptime", "utf-8").trim().split(/\s+/)[0];
      const uptime = Number(uptimeRaw);
      if (!Number.isFinite(uptime)) return null;
      return procStartTimeToEpochMs(starttime, uptime, Date.now());
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const targetRaw = readPsLstart(pid);
    if (targetRaw === null) return null;
    const targetParsed = parsePsLstart(targetRaw);
    if (targetParsed === null) return null;
    const ownRaw = pid === process.pid ? targetRaw : readPsLstart(process.pid);
    if (ownRaw === null) return null;
    const ownParsed = parsePsLstart(ownRaw);
    if (ownParsed === null) return null;
    const ownTrueStartMs = Date.now() - process.uptime() * 1000;
    return applyLstartZoneOffset(targetParsed, ownParsed, ownTrueStartMs);
  }
  return null;
}
