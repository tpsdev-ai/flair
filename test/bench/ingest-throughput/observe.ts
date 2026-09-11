/**
 * observe.ts — read the thread count and peak RSS that the embedder actually
 * used. Requested ≠ used; if the count is unreadable the run REFUSES
 * (flair#1436). Linux uses /proc/<pid>/status; Darwin uses `ps`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface ProcessStatus {
  threads: number;
  rssBytes: number;
  source: "proc" | "darwin-ps" | "linux-ps";
}

export function parseLinuxProcStatus(raw: string): { threads: number; rssBytes: number } {
  const threads = Number(/^Threads:\s+(\d+)/m.exec(raw)?.[1]);
  const vmHWMkB = Number(/^VmHWM:\s+(\d+)/m.exec(raw)?.[1]);
  return {
    threads: Number.isFinite(threads) ? threads : Number.NaN,
    rssBytes: Number.isFinite(vmHWMkB) ? vmHWMkB * 1024 : Number.NaN,
  };
}

/** Darwin `ps -o thcount=` — a single integer, possibly padded. */
export function parseDarwinThcount(raw: string): number {
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? n : Number.NaN;
}

/**
 * Darwin `ps -M -p PID`: header line plus one line per thread. Count
 * non-header lines that look like thread rows.
 */
export function parseDarwinPsM(raw: string): number {
  const lines = String(raw).split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return Number.NaN;
  const data = /^USER\b|^UID\b/i.test(lines[0]!) ? lines.slice(1) : lines;
  return data.length > 0 ? data.length : Number.NaN;
}

/** `ps -o rss=` — kilobytes on both Linux and Darwin. */
export function parsePsRssKb(raw: string): number {
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 ? n * 1024 : Number.NaN;
}

function execPs(args: string[]): string {
  return execFileSync("ps", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
}

export function readProcessStatus(pid: number): ProcessStatus {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`observe: pid ${pid} is not a live process id — cannot read threads`);
  }

  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/status`, "utf8");
      const parsed = parseLinuxProcStatus(raw);
      if (!Number.isFinite(parsed.threads) || parsed.threads <= 0) {
        throw new Error(`observe: /proc/${pid}/status Threads: unreadable`);
      }
      return { threads: parsed.threads, rssBytes: parsed.rssBytes, source: "proc" };
    } catch (err) {
      // Fall through to ps(1) only when /proc itself is missing; a parse
      // failure on a present file is still unreadable → refuse.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
    const nlwp = Number(execPs(["-o", "nlwp=", "-p", String(pid)]).trim());
    const rss = parsePsRssKb(execPs(["-o", "rss=", "-p", String(pid)]));
    if (!Number.isFinite(nlwp) || nlwp <= 0) {
      throw new Error(`observe: ps nlwp unreadable for pid ${pid}`);
    }
    return { threads: nlwp, rssBytes: rss, source: "linux-ps" };
  }

  if (process.platform === "darwin") {
    let threads = Number.NaN;
    try {
      threads = parseDarwinThcount(execPs(["-o", "thcount=", "-p", String(pid)]));
    } catch {
      threads = Number.NaN;
    }
    if (!Number.isFinite(threads) || threads <= 0) {
      try {
        threads = parseDarwinPsM(execPs(["-M", "-p", String(pid)]));
      } catch {
        threads = Number.NaN;
      }
    }
    if (!Number.isFinite(threads) || threads <= 0) {
      throw new Error(
        `observe: Darwin thread count unreadable for pid ${pid} ` +
        `(ps -o thcount= and ps -M both failed) — refusing`,
      );
    }
    let rssBytes = Number.NaN;
    try {
      rssBytes = parsePsRssKb(execPs(["-o", "rss=", "-p", String(pid)]));
    } catch {
      rssBytes = Number.NaN;
    }
    return { threads, rssBytes, source: "darwin-ps" };
  }

  throw new Error(
    `observe: no thread-count source on ${process.platform} — ` +
    `this harness reads /proc/<pid>/status (Linux) or ps (Darwin). Refusing.`,
  );
}

export function observedThreadDelta(baseline: number, postWarmup: number): number {
  if (!Number.isFinite(baseline) || !Number.isFinite(postWarmup)) {
    throw new Error(
      `observe: thread counts unreadable (baseline=${baseline} post=${postWarmup}) — refusing`,
    );
  }
  const delta = postWarmup - baseline;
  if (!Number.isFinite(delta) || delta <= 0) {
    throw new Error(
      `observe: embedder thread delta is ${delta} ` +
      `(${baseline} → ${postWarmup}) — refusing to attribute a setting that did not appear`,
    );
  }
  return delta;
}
