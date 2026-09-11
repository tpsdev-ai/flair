/**
 * ingest-throughput-control.ts — refuse-rather-than-lie gates for the
 * ingest-only throughput bench (flair#1436, Flint addendum).
 *
 * Extracted so every gate is unit-testable with pure inputs — no Harper, no
 * model, no CI lane. A control that can only pass is the same defect this
 * harness exists to prevent. Each function fails toward BLOCKED / inconclusive,
 * never toward a fabricated ranking.
 */

/** FLAIR_EMBED_THREADS=1 must be at least this many times slower than 8
 *  (tok/s_8 / tok/s_1 >= 1.3). A sweep over a setting that never applied
 *  must refuse to print a ranking. */
export const NEGATIVE_CONTROL_MIN_SLOWDOWN = 1.3;

/** Published 8-core CPU baseline from the v0.50.0 n=500 run (issue #1436). */
export const POSITIVE_CONTROL_TOK_PER_SEC_PER_CORE = 159;
export const POSITIVE_CONTROL_HOST_CORES = 8;

export interface NegativeControlDecision {
  /** low.tokPerSec / high.tokPerSec. < 1 means low is slower. */
  ratio: number;
  /** high.tokPerSec / low.tokPerSec. >= minSlowdown means 1 is materially slower. */
  slowdown: number;
  /** True when high/low >= minSlowdown. */
  passed: boolean;
  /** True when the run must abort (BLOCKED). */
  blocked: boolean;
  minSlowdown: number;
}

/**
 * Negative control: FLAIR_EMBED_THREADS=1 must be ≥ minSlowdown× slower
 * than the high setting (default 8). Non-finite measurements BLOCK.
 */
export function decideNegativeControl(
  lowTokPerSec: number,
  highTokPerSec: number,
  minSlowdown: number = NEGATIVE_CONTROL_MIN_SLOWDOWN,
): NegativeControlDecision {
  const ratio = lowTokPerSec / highTokPerSec;
  const slowdown = highTokPerSec / lowTokPerSec;
  const passed = Number.isFinite(slowdown) && slowdown >= minSlowdown;
  return { ratio, slowdown, passed, blocked: !passed, minSlowdown };
}

export interface ObservedThreadsDecision {
  passed: boolean;
  blocked: boolean;
  reason: string;
}

/**
 * Assert the thread count that was USED. Unreadable / non-positive /
 * non-finite → BLOCKED. Requested ≠ used is recorded by the caller; this
 * gate only answers "can we attribute a number to a real thread count".
 */
export function decideObservedThreads(
  observed: number | null | undefined,
): ObservedThreadsDecision {
  if (observed == null || !Number.isFinite(observed) || observed <= 0) {
    return {
      passed: false,
      blocked: true,
      reason:
        `observed threads are unreadable (${String(observed)}) — refusing to ` +
        `attribute throughput to a setting that cannot be confirmed (flair#1436)`,
    };
  }
  return { passed: true, blocked: false, reason: `observed=${observed}` };
}

export interface Interval {
  min: number;
  max: number;
  mean: number;
}

export function intervalOf(values: number[]): Interval {
  if (values.length === 0 || values.some((v) => !Number.isFinite(v))) {
    return { min: Number.NaN, max: Number.NaN, mean: Number.NaN };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return { min, max, mean };
}

export function intervalsOverlap(a: Interval, b: Interval): boolean {
  if (![a.min, a.max, b.min, b.max].every(Number.isFinite)) return true;
  return a.min <= b.max && b.min <= a.max;
}

export interface CellKey {
  requestedThreads: number | "default";
  requestedGpuLayers: number;
}

export function cellKey(threads: number | "default", gpuLayers: number): string {
  return `threads=${String(threads)} gpu=${gpuLayers}`;
}

export interface RankingCell {
  id: string;
  values: number[];
}

export interface RankingResult {
  /** Set only when one cell's interval is entirely above every other. */
  winner: string | null;
  verdict: "winner" | "inconclusive" | "refused";
  reason: string;
  intervals: Record<string, Interval>;
  overlappingPairs: Array<{ a: string; b: string }>;
}

/**
 * Rank cells by a metric (doc/s or tok/s). Overlapping [min, max] intervals
 * → inconclusive — do not pick a winner. Empty / non-finite → refused.
 */
export function rankCells(cells: RankingCell[]): RankingResult {
  const intervals: Record<string, Interval> = {};
  for (const c of cells) intervals[c.id] = intervalOf(c.values);

  const usable = cells.filter((c) => Number.isFinite(intervals[c.id]!.mean));
  if (usable.length === 0) {
    return {
      winner: null,
      verdict: "refused",
      reason: "no finite measurements to rank",
      intervals,
      overlappingPairs: [],
    };
  }
  if (usable.length === 1) {
    return {
      winner: usable[0]!.id,
      verdict: "winner",
      reason: `only one cell (${usable[0]!.id}) has a finite interval`,
      intervals,
      overlappingPairs: [],
    };
  }

  const overlappingPairs: Array<{ a: string; b: string }> = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i]!.id;
      const b = usable[j]!.id;
      if (intervalsOverlap(intervals[a]!, intervals[b]!)) {
        overlappingPairs.push({ a, b });
      }
    }
  }

  if (overlappingPairs.length > 0) {
    return {
      winner: null,
      verdict: "inconclusive",
      reason:
        `overlapping intervals — refusing to pick a winner ` +
        `(${overlappingPairs.map((p) => `${p.a} ∩ ${p.b}`).join("; ")})`,
      intervals,
      overlappingPairs,
    };
  }

  const sorted = [...usable].sort(
    (a, b) => intervals[b.id]!.mean - intervals[a.id]!.mean,
  );
  const top = sorted[0]!;
  return {
    winner: top.id,
    verdict: "winner",
    reason: `${top.id} interval is entirely above every other cell`,
    intervals,
    overlappingPairs,
  };
}

export interface PositiveControlDecision {
  applicable: boolean;
  passed: boolean;
  blocked: boolean;
  reason: string;
  expected: number;
  measured: Interval;
}

/**
 * Positive control: on an 8-core host the unset-default cell must reproduce
 * ~159 tok/s/core within the measured run interval. Not applicable on any
 * other core count (skip, do not refuse). On 8-core, 159 must fall inside
 * [min, max] of the default cell or the run is BLOCKED.
 */
export function decidePositiveControl(opts: {
  hostCores: number;
  tokPerSecPerCoreRuns: number[];
  expected?: number;
  requiredCores?: number;
}): PositiveControlDecision {
  const expected = opts.expected ?? POSITIVE_CONTROL_TOK_PER_SEC_PER_CORE;
  const requiredCores = opts.requiredCores ?? POSITIVE_CONTROL_HOST_CORES;
  const measured = intervalOf(opts.tokPerSecPerCoreRuns);
  if (opts.hostCores !== requiredCores) {
    return {
      applicable: false,
      passed: true,
      blocked: false,
      reason: `positive control is 8-core only (hostCores=${opts.hostCores})`,
      expected,
      measured,
    };
  }
  if (!Number.isFinite(measured.min) || !Number.isFinite(measured.max)) {
    return {
      applicable: true,
      passed: false,
      blocked: true,
      reason: "positive control: default-cell tok/s/core is unreadable",
      expected,
      measured,
    };
  }
  const contains = measured.min <= expected && expected <= measured.max;
  if (contains) {
    return {
      applicable: true,
      passed: true,
      blocked: false,
      reason: `default tok/s/core interval [${measured.min.toFixed(1)}, ${measured.max.toFixed(1)}] contains ${expected}`,
      expected,
      measured,
    };
  }
  return {
    applicable: true,
    passed: false,
    blocked: true,
    reason:
      `positive control failed: expected ${expected} tok/s/core on ${requiredCores}-core, ` +
      `measured [${measured.min.toFixed(1)}, ${measured.max.toFixed(1)}] ` +
      `(mean ${measured.mean.toFixed(1)}) — not within variance`,
    expected,
    measured,
  };
}

const METAL_INIT_RE = /ggml_metal_init/i;
const METAL_BUFFER_RE = /compute[- ]buffer/i;

export interface MetalReadback {
  engaged: boolean;
  hasInit: boolean;
  hasComputeBuffer: boolean;
  evidence: string[];
}

/** Prove GPU engagement from the engine log. Requested ≠ used. */
export function parseMetalEngaged(log: string): MetalReadback {
  const lines = (log ?? "").split(/\r?\n/);
  const evidence = lines.filter((l) => METAL_INIT_RE.test(l) || METAL_BUFFER_RE.test(l));
  const hasInit = evidence.some((l) => METAL_INIT_RE.test(l));
  const hasComputeBuffer = evidence.some((l) => METAL_BUFFER_RE.test(l));
  return {
    engaged: hasInit && hasComputeBuffer,
    hasInit,
    hasComputeBuffer,
    evidence: evidence.slice(0, 12),
  };
}

export interface MetalGateDecision {
  required: boolean;
  passed: boolean;
  blocked: boolean;
  reason: string;
  readback: MetalReadback;
}

/**
 * gpuLayers=99 must show ggml_metal_init AND a compute-buffer line.
 * gpuLayers=0 does not require Metal. Missing readback on gpu=99 → BLOCKED
 * (do not invent a GPU throughput number).
 */
export function decideMetalGate(
  requestedGpuLayers: number,
  log: string,
): MetalGateDecision {
  const readback = parseMetalEngaged(log);
  if (requestedGpuLayers <= 0) {
    return {
      required: false,
      passed: true,
      blocked: false,
      reason: "gpuLayers<=0 — Metal readback not required",
      readback,
    };
  }
  if (readback.engaged) {
    return {
      required: true,
      passed: true,
      blocked: false,
      reason: "Metal engaged (ggml_metal_init + compute-buffer)",
      readback,
    };
  }
  return {
    required: true,
    passed: false,
    blocked: true,
    reason:
      `gpuLayers=${requestedGpuLayers} but Metal readback failed ` +
      `(ggml_metal_init=${readback.hasInit}, compute-buffer=${readback.hasComputeBuffer}) ` +
      `— refusing to attribute throughput to a GPU that was not proven engaged`,
    readback,
  };
}

export interface QuietBoxInput {
  load1: number;
  cores: number;
  competing: Array<{ pid: number; cmd: string }>;
}

export interface QuietBoxDecision {
  quiet: boolean;
  passed: boolean;
  blocked: boolean;
  caveat: boolean;
  reason: string;
}

/** 1-min loadavg above this fraction of cores is "not idle". */
export const QUIET_LOAD_REFUSE = 0.75;
export const QUIET_LOAD_CAVEAT = 0.30;

/**
 * Paired-bench quiet-box gate. Competing harper/llama/embed processes →
 * refuse. Saturated load → refuse. Elevated but empty-of-competitors load
 * → caveat (caller may still measure but must refuse ranking).
 */
export function decideQuietBox(input: QuietBoxInput): QuietBoxDecision {
  const cores = Number.isFinite(input.cores) && input.cores > 0 ? input.cores : 1;
  const loadFrac = input.load1 / cores;
  if (input.competing.length > 0) {
    const who = input.competing
      .slice(0, 5)
      .map((p) => `${p.pid}:${p.cmd.slice(0, 60)}`)
      .join("; ");
    return {
      quiet: false,
      passed: false,
      blocked: true,
      caveat: true,
      reason:
        `quiet-box refused: competing embed/harper process(es) — ${who}. ` +
        `A background embed job has been measured to swing the gpu-vs-cpu ratio ` +
        `(1.26× then 1.10×). Quieten the box and re-run.`,
    };
  }
  if (loadFrac >= QUIET_LOAD_REFUSE) {
    return {
      quiet: false,
      passed: false,
      blocked: true,
      caveat: true,
      reason:
        `quiet-box refused: 1-min loadavg ${input.load1.toFixed(2)} is ` +
        `${loadFrac.toFixed(2)}× cores=${cores} (refuse threshold ${QUIET_LOAD_REFUSE})`,
    };
  }
  if (loadFrac >= QUIET_LOAD_CAVEAT) {
    return {
      quiet: false,
      passed: false,
      blocked: false,
      caveat: true,
      reason:
        `quiet-box caveat: 1-min loadavg ${input.load1.toFixed(2)} is ` +
        `${loadFrac.toFixed(2)}× cores=${cores} — ranking refused, numbers caveated`,
    };
  }
  return {
    quiet: true,
    passed: true,
    blocked: false,
    caveat: false,
    reason: `quiet: load1=${input.load1.toFixed(2)} cores=${cores} no competing embed/harper`,
  };
}

/** Process-table lines that count as competing ingest load. */
export const COMPETING_CMD_RE =
  /\b(harper|llama-cli|llama-server|embed-server|node-llama-cpp)\b/i;

export function parseCompetingFromPs(
  psOutput: string,
  selfPid: number,
): Array<{ pid: number; cmd: string }> {
  const out: Array<{ pid: number; cmd: string }> = [];
  for (const line of (psOutput ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2] ?? "";
    if (!Number.isFinite(pid) || pid === selfPid) continue;
    if (COMPETING_CMD_RE.test(cmd)) out.push({ pid, cmd });
  }
  return out;
}

export function isMetalCapablePlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): boolean {
  return platform === "darwin" && arch === "arm64";
}

export function resolveGpuLayerSweep(opts: {
  platform?: string;
  arch?: string;
  /** Explicit list from --gpu-layers. */
  requested?: number[] | "auto";
}): { sweep: number[]; skipped: boolean; reason: string } {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const requested = opts.requested ?? "auto";
  if (requested !== "auto") {
    const sweep = [...new Set(requested)].sort((a, b) => a - b);
    return {
      sweep,
      skipped: !sweep.includes(99),
      reason: sweep.includes(99)
        ? `--gpu-layers ${sweep.join(",")} (explicit; gpu=99 cells still require Metal readback)`
        : `--gpu-layers ${sweep.join(",")} (CPU only)`,
    };
  }
  if (isMetalCapablePlatform(platform, arch)) {
    return {
      sweep: [0, 99],
      skipped: false,
      reason: "auto: darwin-arm64 → {0, 99}",
    };
  }
  return {
    sweep: [0],
    skipped: true,
    reason:
      `auto: not Metal mac-arm64 (${platform}/${arch}) — gpuLayers=99 skipped. ` +
      `Run on Darwin arm64 with --gpu-layers 0,99. Do not invent GPU numbers.`,
  };
}
