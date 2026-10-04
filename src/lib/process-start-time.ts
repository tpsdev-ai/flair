/**
 * Live-process start time in epoch ms.
 *
 * Parsers and the ±2s match live in `daemon-liveness.ts` (pure). This file
 * is the I/O adapter those parsers need: Linux `/proc/<pid>/stat` field 22
 * plus `/proc/stat` btime (whole seconds) or `/proc/uptime` (full ms), and
 * macOS `ps -o lstart=`. One reader for the production
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

let cachedClockTicksPerSecond: number | undefined;

function clockTicksPerSecond(): number | null {
  if (cachedClockTicksPerSecond !== undefined) return cachedClockTicksPerSecond;
  try {
    const raw = execFileSync("getconf", ["CLK_TCK"], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (/^[1-9][0-9]*$/.test(raw)) {
      const ticks = Number(raw);
      if (Number.isSafeInteger(ticks)) return (cachedClockTicksPerSecond = ticks);
    }
  } catch {
    // Unknown rate cannot establish a process's start time.
  }
  // Retry on a later read: getconf failure may be transient. Cache only a
  // verified positive rate, never a guessed value.
  return null;
}

/**
 * Linux's whole start second from `/proc/stat` boot time and `/proc` start
 * ticks when the host tick rate is known. `/proc/uptime` plus `Date.now()`
 * is sampled at two different moments, so its reconstructed boot epoch can
 * move across a second boundary between reads of the same pid.
 *
 * `/proc/<pid>/stat` reports starttime in USER_HZ ticks, and
 * `/proc/stat` reports btime in whole epoch seconds. Truncate the tick count
 * before adding btime so the answer is stable across sampling and wall-clock
 * second boundaries while btime is unchanged.
 */
export function procStartSecondMsFromStat(processStat: string, systemStat: string, clkTck: number): number | null {
  const starttimeTicks = parseProcStatStartTime(processStat);
  const bootTimeMatch = /^btime[ \t]+([0-9]+)[ \t]*$/m.exec(systemStat);
  if (starttimeTicks === null || !Number.isSafeInteger(starttimeTicks) || starttimeTicks < 0 || bootTimeMatch === null || !Number.isSafeInteger(clkTck) || clkTck <= 0) return null;
  const bootTimeSeconds = Number(bootTimeMatch[1]);
  if (!Number.isSafeInteger(bootTimeSeconds) || bootTimeSeconds <= 0) return null;
  const startSecondMs = (bootTimeSeconds + Math.floor(starttimeTicks / clkTck)) * 1000;
  return Number.isSafeInteger(startSecondMs) ? startSecondMs : null;
}

/**
 * The pid's start time truncated to a whole second, in epoch ms when readable
 * (flair#2056).
 *
 * macOS: the second `ps -o lstart=` reports. The zone correction is the
 * `applyLstartZoneOffset` offset rounded to a whole minute: that offset is the
 * parser's zone error (whole minutes) minus this process's sub-second start
 * fraction, and the rounding drops the fraction. Linux: btime plus the
 * `/proc` start ticks truncated to the second, only with a verified CLK_TCK.
 */
export function readProcessStartSecondMs(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const clkTck = clockTicksPerSecond();
      if (clkTck === null) return null;
      return procStartSecondMsFromStat(
        readFileSync(`/proc/${pid}/stat`, "utf-8"),
        readFileSync("/proc/stat", "utf-8"),
        clkTck,
      );
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
    const zoneErrorMs = Math.round((ownParsed - ownTrueStartMs) / 60_000) * 60_000;
    return targetParsed - zoneErrorMs;
  }
  return null;
}

export function readProcessStartTimeMs(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const clkTck = clockTicksPerSecond();
      if (clkTck === null) return null;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      const starttime = parseProcStatStartTime(stat);
      if (starttime === null) return null;
      const uptimeRaw = readFileSync("/proc/uptime", "utf-8").trim().split(/\s+/)[0];
      const uptime = Number(uptimeRaw);
      if (!Number.isFinite(uptime)) return null;
      return procStartTimeToEpochMs(starttime, uptime, Date.now(), clkTck);
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
