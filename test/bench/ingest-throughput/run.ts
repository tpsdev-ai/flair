#!/usr/bin/env bun
/**
 * run.ts — ingest-only throughput benchmark CLI (flair#1436).
 *
 *   bun run test/bench/ingest-throughput/run.ts run \
 *     --dataset <path> [--n 500] [--seed 0] [--runs 3] [--out <dir>] \
 *     [--gpu-layers auto|0|0,99] [--allow-noisy]
 *
 * Ingest path only: no reader, no judge, no provider. Sweeps
 * FLAIR_EMBED_THREADS {6,7,8} × gpuLayers {0,99} (99 only on Metal
 * mac-arm64, or when forced). Refuses rather than ranks when a gate fails.
 *
 * Does NOT change any product default. #1437 is the default-change decision.
 */
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolveBenchGitCommit } from "../git-commit";
import {
  DEFAULT_RUNS, DEFAULT_SLICE_N, DEFAULT_SEED, INGEST_CONCURRENCY,
  NEGATIVE_CONTROL, NEGATIVE_CONTROL_MIN_SLOWDOWN, THREAD_SWEEP,
  configManifest, hashConfig,
} from "./config";
import { loadDataset, selectSlice } from "../longmemeval/dataset";
import { measureSetting, type SettingMetrics } from "./measure";
import {
  cellKey, decideNegativeControl, decidePositiveControl, isMetalCapablePlatform,
  rankCells, resolveGpuLayerSweep,
} from "../../unit/ingest-throughput-control";
import { inspectQuietBox } from "./quiet-box";
import {
  aggregate, buildArtifact, writeArtifact, verifyArtifactHash, hashRunResults,
  type SettingAggregate, type NegativeControlResult,
} from "./artifact";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function arg(flag: string): string | undefined;
function arg(flag: string, dflt: string): string;
function arg(flag: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const hasFlag = (f: string) => process.argv.includes(f);

function parseGpuLayersFlag(raw: string | undefined): number[] | "auto" {
  if (!raw || raw === "auto") return "auto";
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`--gpu-layers must be auto or a comma list of non-negative integers (got ${raw})`);
  }
  return parts;
}

async function measureWithRuns(
  entries: ReturnType<typeof selectSlice>,
  threads: number | "default",
  gpuLayers: number,
  runs: number,
  log: (m: string) => void,
): Promise<SettingAggregate> {
  const metrics: SettingMetrics[] = [];
  for (let r = 0; r < runs; r++) {
    log(`  [${cellKey(threads, gpuLayers)}] run ${r + 1}/${runs}...`);
    metrics.push(await measureSetting(entries, { threads, gpuLayers }, {
      repoRoot: REPO_ROOT, concurrency: INGEST_CONCURRENCY, log,
    }));
  }
  return aggregate(metrics);
}

function printCellTable(settings: SettingAggregate[]): void {
  const header = [
    "threads".padEnd(8),
    "gpu".padEnd(5),
    "obs".padEnd(5),
    "doc/s".padEnd(10),
    "spread".padEnd(18),
    "tok/s".padEnd(10),
    "tok/s/core".padEnd(11),
    "metal",
  ].join(" ");
  console.log(`\n${header}`);
  console.log("-".repeat(header.length));
  for (const s of settings) {
    const spread = `${s.docsPerSecSpread.min.toFixed(2)}–${s.docsPerSecSpread.max.toFixed(2)}`;
    console.log(
      `${String(s.requestedThreads).padEnd(8)} ` +
      `${String(s.requestedGpuLayers).padEnd(5)} ` +
      `${s.meanObservedThreads.toFixed(0).padEnd(5)} ` +
      `${s.meanDocsPerSec.toFixed(2).padEnd(10)} ` +
      `${spread.padEnd(18)} ` +
      `${s.meanTokPerSec.toFixed(1).padEnd(10)} ` +
      `${s.meanTokPerSecPerCore.toFixed(1).padEnd(11)} ` +
      `${s.requestedGpuLayers > 0 ? (s.metalEngaged ? "yes" : "NO") : "—"}`,
    );
  }
}

function buildRankings(settings: SettingAggregate[]): Record<string, ReturnType<typeof rankCells>> {
  const ranking: Record<string, ReturnType<typeof rankCells>> = {};
  const byGpu = new Map<number, SettingAggregate[]>();
  for (const s of settings) {
    const arr = byGpu.get(s.requestedGpuLayers) ?? [];
    arr.push(s);
    byGpu.set(s.requestedGpuLayers, arr);
  }
  for (const [gpu, cells] of byGpu) {
    const sweepCells = cells.filter((c) => THREAD_SWEEP.includes(c.requestedThreads as 6 | 7 | 8));
    if (sweepCells.length >= 2) {
      ranking[`threads@gpu=${gpu}`] = rankCells(
        sweepCells.map((c) => ({
          id: cellKey(c.requestedThreads, c.requestedGpuLayers),
          values: c.runs.map((r) => r.docsPerSec),
        })),
      );
    }
  }
  const byThreads = new Map<string, SettingAggregate[]>();
  for (const s of settings) {
    const k = String(s.requestedThreads);
    const arr = byThreads.get(k) ?? [];
    arr.push(s);
    byThreads.set(k, arr);
  }
  for (const [threads, cells] of byThreads) {
    const gpuPair = cells.filter((c) => c.requestedGpuLayers === 0 || c.requestedGpuLayers === 99);
    if (gpuPair.length >= 2) {
      ranking[`gpu@threads=${threads}`] = rankCells(
        gpuPair.map((c) => ({
          id: cellKey(c.requestedThreads, c.requestedGpuLayers),
          values: c.runs.map((r) => r.docsPerSec),
        })),
      );
    }
  }
  return ranking;
}

async function run(): Promise<void> {
  const datasetPath = arg("--dataset");
  if (!datasetPath || !existsSync(datasetPath)) {
    console.error(
      "usage: run.ts run --dataset <path> [--n 500] [--seed 0] [--runs 3] [--out <dir>] " +
      "[--gpu-layers auto|0|0,99] [--allow-noisy]",
    );
    console.error("  --dataset: path to the LongMemEval_s dataset file (pinned by sha256)");
    process.exit(2);
  }

  const n = Number(arg("--n", String(DEFAULT_SLICE_N)));
  const seed = Number(arg("--seed", String(DEFAULT_SEED)));
  const runs = Number(arg("--runs", String(DEFAULT_RUNS)));
  const outDir = arg("--out", path.join(REPO_ROOT, "test/bench/ingest-throughput/artifacts"));
  const benchHost = process.env.INGEST_BENCH_HOST ?? "local";
  const allowNoisy = hasFlag("--allow-noisy");
  const gpuFlag = parseGpuLayersFlag(arg("--gpu-layers", "auto"));
  const gpuSweep = resolveGpuLayerSweep({ requested: gpuFlag });
  const metalCapable = isMetalCapablePlatform();
  const gitCommit = resolveBenchGitCommit(REPO_ROOT);
  const log = (m: string) => console.error(m);

  // ── QUIET BOX FIRST (paired-bench discipline) ────────────────────────────
  log("QUIET BOX: pgrep/CPU before any Harper spawn");
  const quietBox = inspectQuietBox();
  log(`  ${quietBox.reason}`);
  if (quietBox.blocked && !allowNoisy) {
    console.error(
      `\nBLOCKED: box is not quiet. ${quietBox.reason}\n` +
      `Re-run on a quiet host, or pass --allow-noisy to measure with ranking refused.`,
    );
    process.exit(1);
  }
  if (!quietBox.quiet) {
    log("  CAVEAT: proceeding with --allow-noisy; ranking will be refused.");
  }

  log(`loading dataset ${datasetPath}...`);
  const entries = selectSlice(loadDataset(datasetPath), n, seed);
  log(`slice: n=${n} seed=${seed} -> ${entries.length} entries`);
  log(`gpu sweep: [${gpuSweep.sweep.join(", ")}] (${gpuSweep.reason})`);
  log(`host: ${process.platform}/${process.arch} cores=${availableParallelism()} metalCapable=${metalCapable}`);

  const manifest = configManifest({ n, seed, runs }, gpuSweep.sweep);
  const configHash = hashConfig(manifest);
  log(`configHash: ${configHash}`);
  log(`gitCommit: ${gitCommit}`);

  const settings: SettingAggregate[] = [];
  const runHashes: string[] = [];
  const seen = new Set<string>();

  const record = (agg: SettingAggregate) => {
    const key = cellKey(agg.requestedThreads, agg.requestedGpuLayers);
    if (seen.has(key)) return;
    seen.add(key);
    settings.push(agg);
    for (const r of agg.runs) runHashes.push(hashRunResults(r));
  };

  // ── NEGATIVE CONTROL FIRST (gpu=0) ───────────────────────────────────────
  log(`\nNEGATIVE CONTROL: FLAIR_EMBED_THREADS=${NEGATIVE_CONTROL.low} vs ${NEGATIVE_CONTROL.high} @ gpu=0`);
  const low = await measureWithRuns(entries, NEGATIVE_CONTROL.low, 0, runs, log);
  const high = await measureWithRuns(entries, NEGATIVE_CONTROL.high, 0, runs, log);
  const ncDecision = decideNegativeControl(
    low.meanTokPerSec,
    high.meanTokPerSec,
    NEGATIVE_CONTROL_MIN_SLOWDOWN,
  );
  const nc: NegativeControlResult = {
    ...ncDecision,
    low: NEGATIVE_CONTROL.low,
    high: NEGATIVE_CONTROL.high,
    gpuLayers: 0,
  };
  log(`  low  tok/s = ${low.meanTokPerSec.toFixed(1)} (observed ${low.meanObservedThreads})`);
  log(`  high tok/s = ${high.meanTokPerSec.toFixed(1)} (observed ${high.meanObservedThreads})`);
  log(`  slowdown = ${nc.slowdown.toFixed(3)}× (need ≥ ${nc.minSlowdown}×)`);

  if (!nc.passed) {
    console.error(
      `\nBLOCKED: negative control failed — FLAIR_EMBED_THREADS=${NEGATIVE_CONTROL.low} is NOT ` +
      `≥${nc.minSlowdown}× slower than ${NEGATIVE_CONTROL.high} (slowdown ${nc.slowdown.toFixed(3)}). ` +
      `The env var is not reaching the embedder; refusing to print a ranking.`,
    );
    process.exit(1);
  }
  log(`  negative control PASSED (${NEGATIVE_CONTROL.low} is ${nc.slowdown.toFixed(2)}× slower than ${NEGATIVE_CONTROL.high})\n`);
  record(low);
  record(high);

  // ── SWEEP threads × gpuLayers ────────────────────────────────────────────
  log(`SWEEP: threads {${THREAD_SWEEP.join(", ")}, default} × gpuLayers {${gpuSweep.sweep.join(", ")}}`);
  for (const gpu of gpuSweep.sweep) {
    for (const t of [...THREAD_SWEEP, "default"] as const) {
      const key = cellKey(t, gpu);
      if (seen.has(key)) {
        log(`  ${key}: already measured`);
        continue;
      }
      const agg = await measureWithRuns(entries, t, gpu, runs, log);
      record(agg);
      log(
        `  ${key}: ${agg.meanDocsPerSec.toFixed(2)} doc/s ` +
        `[${agg.docsPerSecSpread.min.toFixed(2)}–${agg.docsPerSecSpread.max.toFixed(2)}] ` +
        `${agg.meanTokPerSec.toFixed(1)} tok/s ` +
        `(observed ${agg.meanObservedThreads})`,
      );
    }
  }

  // ── POSITIVE CONTROL (Linux x86_64 8-core default cell only) ─────────────
  // 159 tok/s/core is the tps-bench Linux x86_64 baseline. Darwin / other
  // arches skip — do not invent a Darwin number, do not BLOCK a Metal run.
  const defaultCpu = settings.find((s) => s.requestedThreads === "default" && s.requestedGpuLayers === 0);
  const hostCores = defaultCpu?.runs[0]?.hostCores ?? availableParallelism();
  const positiveControl = decidePositiveControl({
    hostCores,
    platform: process.platform,
    arch: process.arch,
    tokPerSecPerCoreRuns: defaultCpu?.runs.map((r) => r.tokPerSecPerCore) ?? [],
  });
  log(`\nPOSITIVE CONTROL: ${positiveControl.reason}`);
  if (positiveControl.blocked) {
    console.error(`\nBLOCKED: ${positiveControl.reason}`);
    process.exit(1);
  }

  // ── RANKING ──────────────────────────────────────────────────────────────
  let ranking = buildRankings(settings);
  if (!quietBox.quiet) {
    const refused = Object.fromEntries(
      Object.entries(ranking).map(([k, v]) => [k, {
        ...v,
        winner: null,
        verdict: "refused" as const,
        reason: `quiet-box caveat — ${quietBox.reason}`,
      }]),
    );
    ranking = refused;
    log("RANKING refused: box was not quiet.");
  } else {
    for (const [k, v] of Object.entries(ranking)) {
      log(`RANKING ${k}: ${v.verdict}${v.winner ? ` → ${v.winner}` : ""} (${v.reason})`);
    }
  }

  const art = buildArtifact({
    configHash,
    config: manifest,
    runHashes,
    settings,
    negativeControl: nc,
    positiveControl,
    ranking,
    gpuSweep,
    gitCommit,
    benchHost,
    platform: process.platform,
    arch: process.arch,
    metalCapable,
    quietBox,
  });
  const outPath = writeArtifact(art, outDir);
  if (!verifyArtifactHash(art)) {
    console.error("BLOCKED: artifact hash verification failed after write");
    process.exit(1);
  }
  console.log(`\nartifact: ${outPath}`);
  console.log(`artifactHash: ${art.artifactHash}`);
  console.log(`gitCommit: ${art.gitCommit}`);
  printCellTable(settings);
  console.log(`\nnegativeControl: ${nc.slowdown.toFixed(2)}× (need ≥ ${nc.minSlowdown}×) ${nc.passed ? "PASS" : "FAIL"}`);
  console.log(`positiveControl: ${positiveControl.reason}`);
  console.log(`quietBox: ${quietBox.quiet ? "quiet" : "NOT QUIET"} — ${quietBox.reason}`);
  for (const [k, v] of Object.entries(ranking)) {
    console.log(`ranking ${k}: ${v.verdict}${v.winner ? ` ${v.winner}` : ""}`);
  }
}

const cmd = process.argv[2];
if (cmd === "run") {
  run().catch((err) => {
    console.error(`\nBLOCKED: ${err?.stack ?? err}`);
    process.exit(1);
  });
} else {
  console.error(
    "usage: run.ts run --dataset <path> [--n 500] [--seed 0] [--runs 3] [--out <dir>] " +
    "[--gpu-layers auto|0|0,99] [--allow-noisy]",
  );
  process.exit(2);
}
