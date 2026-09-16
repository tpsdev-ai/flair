/**
 * Live-process start time in epoch ms.
 *
 * Parsers and the ±2s match live in `daemon-liveness.ts` (pure). This file
 * is the I/O adapter those parsers need: Linux `/proc/<pid>/stat` field 22
 * plus `/proc/uptime`, macOS `ps -o lstart=`. One reader for the production
 * daemon identity check and the harness scratch-owner stamp (flair#1372).
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
    try {
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf-8",
        env: { ...(process.env as Record<string, string>), LC_ALL: "C" },
        timeout: 2000,
      });
      return parsePsLstart(out);
    } catch {
      return null;
    }
  }
  return null;
}
