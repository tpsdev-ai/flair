/**
 * torn-read-sampler.ts — the shared reader for the flair#1778 atomic-write
 * fixtures (d2's T1a/T2 and d3's P1).
 *
 * Each of those fixtures races a production config writer against a reader and
 * asserts the reader never observes a half-written file. Two signals are
 * needed:
 *
 *  - COVERAGE: proof the reader actually sampled INSIDE the writer's
 *    [start, end] window — without it the tear check could not fire, so an
 *    uncovered race is a NAMED failure, never a pass. Coverage samples must NOT
 *    be starved by the reader's own (slow) content reads, so they come from a
 *    DEDICATED sampler PROCESS that only stats the file at a steady high rate,
 *    on its own core, off the test process's event loop.
 *  - TEARS: a content read whose length is not one of the complete states.
 *    These come from the test process itself.
 *
 * An uncovered race is RETRIED (bounded); it is a named coverage failure only
 * when coverage cannot be achieved within the budget. A tear on a COVERED race
 * is an immediate failure.
 *
 * HONEST LIMIT: the writer's window spans its WHOLE production call
 * (parse + stringify + temp write + fsync + rename included), so an in-window
 * sample does NOT prove a sample fell inside the destructive truncate-then-write
 * gap. On a pre-fix (raw-writer) baseline the tear RED is EMPIRICAL and
 * host-dependent, not deterministic.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Window {
  start: number;
  end: number;
}

const SAMPLE_INTERVAL_MS = 0.1; // ~10k samples/s — enough to span a few-ms window
const SAMPLE_CAP = 2_000_000;

/** The dedicated sampler child: stat `path` at a steady rate, record the
 *  wall-clock ms of each sample, report them as JSON when `stop` appears. */
const SAMPLER_SRC = [
  'import { existsSync, statSync } from "node:fs";',
  'import { performance } from "node:perf_hooks";',
  "const path = process.argv[2];",
  "const stop = process.argv[3];",
  "const ts = [];",
  "let next = performance.now();",
  "let i = 0;",
  `while (ts.length < ${SAMPLE_CAP}) {`,
  "  if ((i++ % 200) === 0 && existsSync(stop)) break;",
  "  const now = performance.now();",
  "  if (now >= next) {",
  "    try { statSync(path); } catch { /* transient */ }",
  "    ts.push(Date.now());",
  `    next = now + ${SAMPLE_INTERVAL_MS};`,
  "  }",
  "}",
  "process.stdout.write(JSON.stringify(ts));",
].join("\n");

export class CoverageSampler {
  private dir: string;
  private stopFile: string;
  private child: ChildProcess;
  private out = "";
  private closed: Promise<void>;

  private constructor(dir: string, stopFile: string, child: ChildProcess) {
    this.dir = dir;
    this.stopFile = stopFile;
    this.child = child;
    this.closed = new Promise((r) => child.on("close", () => r()));
    child.stdout?.on("data", (d) => (this.out += d.toString()));
  }

  /** Start sampling `path`. Call before the writers start. */
  static start(path: string): CoverageSampler {
    const dir = mkdtempSync(join(tmpdir(), "torn-sampler-"));
    const script = join(dir, "sampler.mjs");
    writeFileSync(script, SAMPLER_SRC, "utf-8");
    const stopFile = join(dir, "stop");
    const child = spawn("bun", [script, path, stopFile], { stdio: ["ignore", "pipe", "ignore"] });
    return new CoverageSampler(dir, stopFile, child);
  }

  /** Stop the sampler and return the timestamps it observed. */
  async stop(): Promise<number[]> {
    writeFileSync(this.stopFile, "1");
    await this.closed;
    try {
      const parsed = JSON.parse(this.out);
      return Array.isArray(parsed) ? (parsed as number[]) : [];
    } catch {
      return [];
    }
  }

  /** Kill the sampler if it is still running (a failed race must not leak it). */
  kill(): void {
    try { this.child.kill("SIGKILL"); } catch { /* already gone */ }
  }

  dispose(): void {
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Count coverage samples that fall inside ANY of the writers' windows. */
export function countInWindows(coverTs: number[], windows: Window[]): number {
  return coverTs.filter((t) => windows.some((w) => t >= w.start && t <= w.end)).length;
}

/** Parse a writer child's `{start,end}` window from its stdout. */
export function parseWindow(stdout: string): Window | null {
  const m = stdout.match(/\{[^}]*"start"[^}]*\}/);
  if (!m) return null;
  const o = JSON.parse(m[0]);
  return typeof o.start === "number" && typeof o.end === "number" ? { start: o.start, end: o.end } : null;
}

/** Count content samples whose length is not one of the complete states. */
export function countTears(contentLens: number[], completeLens: Iterable<number>): number {
  const complete = new Set(completeLens);
  return contentLens.filter((l) => !complete.has(l)).length;
}

export interface RaceOutcome {
  /** True when the dedicated sampler observed at least one sample in the window. */
  covered: boolean;
  /** Content samples not in the complete set (only meaningful when covered). */
  tears: number;
  detail: string;
}

export interface CoverageOutcome {
  tears: number;
  coverageFailure: boolean;
  attempts: number;
  details: string[];
}

/**
 * Run a race, RETRYING (bounded) while the sampler misses the window: coverage
 * is not a pass, it must actually be achieved. A tear on a covered race returns
 * immediately (the tear is the finding); an uncovered set of attempts is a named
 * coverage failure.
 */
export async function runRaceWithCoverage(
  runOnce: () => Promise<RaceOutcome>,
  attempts = 5,
): Promise<CoverageOutcome> {
  const details: string[] = [];
  for (let i = 1; i <= attempts; i++) {
    const r = await runOnce();
    details.push(`attempt ${i}: ${r.detail}`);
    if (!r.covered) continue; // retry — a coverage miss is not a pass
    return { tears: r.tears, coverageFailure: false, attempts: i, details };
  }
  return { tears: 0, coverageFailure: true, attempts, details };
}

/** True when a path is a regular file (a cheap pre-check for fixtures). */
export function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}
