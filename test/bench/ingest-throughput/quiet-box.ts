/**
 * quiet-box.ts — paired-bench discipline for the ingest-throughput harness
 * (flair#1436 Flint addendum). Check pgrep/CPU for background load FIRST.
 * A background embed job has been measured to swing the gpu-vs-cpu ratio
 * (1.26× then 1.10×); a dirty box must caveat or refuse.
 */
import { execFileSync } from "node:child_process";
import { availableParallelism, loadavg } from "node:os";
import {
  decideQuietBox, parseCompetingFromPs,
  type QuietBoxDecision, type QuietBoxInput,
} from "../../unit/ingest-throughput-control";

export interface QuietBoxSnapshot extends QuietBoxDecision {
  load1: number;
  cores: number;
  competing: Array<{ pid: number; cmd: string }>;
  inspectedAt: string;
}

function listProcessTable(): string {
  try {
    return execFileSync("ps", ["-eo", "pid=,args="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  } catch (err) {
    throw new Error(
      `quiet-box: process table unreadable (${(err as Error)?.message ?? err}) — ` +
      `refusing to claim the box is quiet`,
    );
  }
}

export function inspectQuietBox(opts: {
  selfPid?: number;
  cores?: number;
  load1?: number;
  psOutput?: string;
} = {}): QuietBoxSnapshot {
  const selfPid = opts.selfPid ?? process.pid;
  const cores = opts.cores ?? availableParallelism();
  const load1 = opts.load1 ?? loadavg()[0] ?? 0;
  const psOutput = opts.psOutput ?? listProcessTable();
  const competing = parseCompetingFromPs(psOutput, selfPid);
  const input: QuietBoxInput = { load1, cores, competing };
  const decision = decideQuietBox(input);
  return {
    ...decision,
    load1,
    cores,
    competing,
    inspectedAt: new Date().toISOString(),
  };
}
