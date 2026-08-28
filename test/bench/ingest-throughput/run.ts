#!/usr/bin/env bun
/**
 * run.ts — ingest-only throughput benchmark CLI (flair#1436).
 *
 *   bun run test/bench/ingest-throughput/run.ts run --dataset <path> [--n 500] [--seed 0] [--runs 3] [--out <dir>]
 *
 * Measures the FLAIR_EMBED_THREADS axis on the ingest path only. Runs the
 * NEGATIVE CONTROL first (FLAIR_EMBED_THREADS=1 vs 8): if 1 is not materially
 * slower than 8, the env var is not reaching the embedder and the run aborts
 * (BLOCKED) rather than emitting a misleading sweep. Only then does it sweep
 * {6, 7, 8} plus the default (unset) path.
 *
 * Emits a content-addressed artifact (artifact.ts). Produces a number; NEVER
 * publishes one.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  DEFAULT_RUNS, DEFAULT_SLICE_N, DEFAULT_SEED, INGEST_CONCURRENCY,
  NEGATIVE_CONTROL, THREAD_SWEEP, configManifest, hashConfig,
} from "./config";
import { loadDataset, selectSlice } from "../longmemeval/dataset";
import { measureSetting, type SettingMetrics } from "./measure";
import {
  buildArtifact, writeArtifact, verifyArtifactHash, hashRunResults,
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

function gitCommit(): string | null {
  try { return execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim(); } catch { return null; }
}

/** low is "materially slower" than high when its mean tok/s is below this
 *  fraction of high's. 0.75 ⇒ low must be ≥25% slower. On a real host the
 *  ratio is far lower (1 vs 8 threads ≈ 0.125); 0.75 is a conservative floor
 *  that still cleanly separates "env var reaches the embedder" from "ignored"
 *  (ignored ⇒ both settings use the default ⇒ ratio ≈ 1.0). */
const NEGATIVE_CONTROL_THRESHOLD = 0.75;

function aggregate(runs: SettingMetrics[]): SettingAggregate {
  const mean = (f: (m: SettingMetrics) => number) => runs.reduce((s, m) => s + f(m), 0) / runs.length;
  return {
    requestedThreads: runs[0]!.requestedThreads,
    runs,
    meanObservedThreads: mean((m) => m.observedThreads),
    meanWallClockMs: mean((m) => m.wallClockMs),
    meanTokensIngested: mean((m) => m.tokensIngested),
    meanTokPerSec: mean((m) => m.tokPerSec),
    meanTokPerSecPerCore: mean((m) => m.tokPerSecPerCore),
    meanPeakRssBytes: mean((m) => m.peakRssBytes),
  };
}

function checkNegativeControl(low: SettingAggregate, high: SettingAggregate): NegativeControlResult {
  const ratio = low.meanTokPerSec / high.meanTokPerSec;
  return {
    low: NEGATIVE_CONTROL.low,
    high: NEGATIVE_CONTROL.high,
    ratio,
    passed: ratio < NEGATIVE_CONTROL_THRESHOLD,
    threshold: NEGATIVE_CONTROL_THRESHOLD,
  };
}

async function measureWithRuns(
  entries: ReturnType<typeof selectSlice>,
  threads: number | "default",
  runs: number,
  log: (m: string) => void,
): Promise<SettingAggregate> {
  const metrics: SettingMetrics[] = [];
  for (let r = 0; r < runs; r++) {
    log(`  [threads=${threads}] run ${r + 1}/${runs}...`);
    metrics.push(await measureSetting(entries, threads, {
      repoRoot: REPO_ROOT, concurrency: INGEST_CONCURRENCY, log,
    }));
  }
  return aggregate(metrics);
}

async function run(): Promise<void> {
  const datasetPath = arg("--dataset");
  if (!datasetPath || !existsSync(datasetPath)) {
    console.error("usage: run.ts run --dataset <path> [--n 500] [--seed 0] [--runs 3] [--out <dir>]");
    console.error("  --dataset: path to the LongMemEval_s dataset file (pinned by sha256)");
    process.exit(2);
  }
  const n = Number(arg("--n", String(DEFAULT_SLICE_N)));
  const seed = Number(arg("--seed", String(DEFAULT_SEED)));
  const runs = Number(arg("--runs", String(DEFAULT_RUNS)));
  const outDir = arg("--out", path.join(REPO_ROOT, "test/bench/ingest-throughput/artifacts"));
  const benchHost = process.env.INGEST_BENCH_HOST ?? "rockit";

  const log = (m: string) => console.error(m);

  log(`loading dataset ${datasetPath}...`);
  const entries = selectSlice(loadDataset(datasetPath), n, seed);
  log(`slice: n=${n} seed=${seed} -> ${entries.length} entries`);

  const manifest = configManifest({ n, seed, runs });
  const configHash = hashConfig(manifest);
  log(`configHash: ${configHash}`);

  const settings: SettingAggregate[] = [];
  const runHashes: string[] = [];

  // ── NEGATIVE CONTROL FIRST ────────────────────────────────────────────────
  log(`\nNEGATIVE CONTROL: FLAIR_EMBED_THREADS=${NEGATIVE_CONTROL.low} vs ${NEGATIVE_CONTROL.high}`);
  const low = await measureWithRuns(entries, NEGATIVE_CONTROL.low, runs, log);
  const high = await measureWithRuns(entries, NEGATIVE_CONTROL.high, runs, log);
  const nc = checkNegativeControl(low, high);
  log(`  low  tok/s = ${low.meanTokPerSec.toFixed(1)} (${low.meanObservedThreads} threads)`);
  log(`  high tok/s = ${high.meanTokPerSec.toFixed(1)} (${high.meanObservedThreads} threads)`);
  log(`  ratio = ${nc.ratio.toFixed(3)} (threshold ${nc.threshold})`);

  if (!nc.passed) {
    console.error(
      `\nBLOCKED: negative control failed — FLAIR_EMBED_THREADS=${NEGATIVE_CONTROL.low} is NOT ` +
      `materially slower than ${NEGATIVE_CONTROL.high} (ratio ${nc.ratio.toFixed(3)} >= ${nc.threshold}). ` +
      `The env var is not reaching the embedder; the sweep would be untrustworthy.`,
    );
    process.exit(1);
  }
  log(`  negative control PASSED (${NEGATIVE_CONTROL.low} is materially slower than ${NEGATIVE_CONTROL.high})\n`);

  settings.push(low, high);
  for (const m of [low, high]) for (const r of m.runs) runHashes.push(hashRunResults(r));

  // ── SWEEP {6, 7, 8} + default ────────────────────────────────────────────
  log(`SWEEP: FLAIR_EMBED_THREADS in {${THREAD_SWEEP.join(", ")}} + default`);
  for (const t of [...THREAD_SWEEP, "default"] as const) {
    if (t === NEGATIVE_CONTROL.high) continue; // already measured as the control's high
    const agg = await measureWithRuns(entries, t, runs, log);
    settings.push(agg);
    for (const r of agg.runs) runHashes.push(hashRunResults(r));
    log(`  threads=${t}: ${agg.meanTokPerSec.toFixed(1)} tok/s, ${agg.meanTokPerSecPerCore.toFixed(1)} tok/s/core (${agg.meanObservedThreads} threads)`);
  }

  const art = buildArtifact({
    configHash,
    config: manifest,
    runHashes,
    settings,
    negativeControl: nc,
    gitCommit: gitCommit(),
    benchHost,
  });
  const outPath = writeArtifact(art, outDir);
  if (!verifyArtifactHash(art)) {
    console.error("BLOCKED: artifact hash verification failed after write");
    process.exit(1);
  }
  console.log(`\nartifact: ${outPath}`);
  console.log(`artifactHash: ${art.artifactHash}`);
  console.log(`gitCommit: ${art.gitCommit ?? "null"}`);
  console.log(`\nPer-setting summary (mean over ${runs} runs):`);
  for (const s of settings) {
    console.log(
      `  threads=${String(s.requestedThreads).padEnd(7)} observed=${s.meanObservedThreads} ` +
      `tok/s=${s.meanTokPerSec.toFixed(1)} tok/s/core=${s.meanTokPerSecPerCore.toFixed(1)} ` +
      `wall=${s.meanWallClockMs.toFixed(0)}ms tokens=${s.meanTokensIngested.toFixed(0)} rss=${(s.meanPeakRssBytes / 1e6).toFixed(0)}MB`,
    );
  }
}

const cmd = process.argv[2];
if (cmd === "run") {
  run().catch((err) => {
    console.error(`\nBLOCKED: ${err?.stack ?? err}`);
    process.exit(1);
  });
} else {
  console.error("usage: run.ts run --dataset <path> [--n 500] [--seed 0] [--runs 3] [--out <dir>]");
  process.exit(2);
}
