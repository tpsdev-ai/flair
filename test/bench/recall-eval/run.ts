#!/usr/bin/env bun
/**
 * run.ts — Layer 1 deterministic recall eval runner (#17 fix, #1216-a).
 *
 * Spawns a FRESH ephemeral Harper per run (independent: fresh HNSW build +
 * embedding warmup), ingests the curated corpus via the shared plumbing,
 * retrieves every labelled query through Flair's real BM25+RRF at documented
 * defaults, and reports recall@1/5/10, nDCG@10, MRR — plus the run-to-run
 * SPREAD, which is the load-bearing number: a "deterministic" metric is only
 * deterministic if you ran it enough times to see the spread is ~0.
 *
 * This is the recall-QUALITY instrument. It reports fixed-metric floors and
 * fails (exit 1) if any metric falls below its floor — the same numbers the CI
 * gate (test/integration/recall-eval-gate.test.ts) asserts. It is NOT the
 * composite-vs-raw scoring DIAGNOSTIC — that is the sibling recall-harness
 * (../recall-harness/run.ts), a different question (does a scoring config
 * regress), left in place.
 *
 * USAGE:
 *   bun run test/bench/recall-eval/run.ts                 # 3 runs (default)
 *   bun run test/bench/recall-eval/run.ts --runs 5        # more runs
 *   bun run test/bench/recall-eval/run.ts --no-floor-check # measure only
 *
 * Reuse a pre-downloaded embedding model (read-only) to skip a HuggingFace
 * pull: export FLAIR_MODELS_DIR=/path/to/an/existing/flair/checkout/models
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../../helpers/harper-lifecycle";
import { mkAgent, registerAgent, type BenchClient } from "../../../packages/flair-bench/lib/index";
import { runRecallEval, LABELLED_QUERIES } from "./eval";
import { AGENT_ID, FLOORS } from "./labels";
import { CORPUS } from "../recall-harness/corpus";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function assertBuilt(): void {
  const marker = path.join(REPO_ROOT, "dist", "resources", "SemanticSearch.js");
  if (!existsSync(marker)) {
    console.error(`FATAL: ${marker} not found. Harper serves resources from dist/, not TypeScript source.`);
    console.error(`Run \`bun run build\` in ${REPO_ROOT} first, then re-run this eval.`);
    process.exit(2);
  }
}

function argVal(flag: string, dflt: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
}
const RUNS = Math.max(1, parseInt(argVal("--runs", "3"), 10) || 3);
const CHECK_FLOORS = !process.argv.includes("--no-floor-check");

type MetricKey = "recallAt1" | "recallAt5" | "recallAt10" | "ndcgAt10" | "mrr";
const METRICS: MetricKey[] = ["recallAt1", "recallAt5", "recallAt10", "ndcgAt10", "mrr"];
const fmt = (x: number, d = 3) => x.toFixed(d);

async function oneRun(runIdx: number): Promise<Record<MetricKey, number>> {
  const label = `[run ${runIdx}/${RUNS}]`;
  const prevHybrid = process.env.FLAIR_HYBRID_RETRIEVAL;
  process.env.FLAIR_HYBRID_RETRIEVAL = "true"; // documented default: hybrid BM25+RRF on
  let harper: HarperInstance | undefined;
  try {
    console.log(`${label} spawning ephemeral Harper...`);
    harper = await startHarper({ cwd: REPO_ROOT, harperBinDir: REPO_ROOT });
    const agent = mkAgent(AGENT_ID);
    await registerAgent(harper, agent);
    const client: BenchClient = { harper, agent };
    console.log(`${label} ingesting ${CORPUS.length} records, then measuring ${LABELLED_QUERIES.length} queries...`);
    const res = await runRecallEval(client);
    const a = res.aggregate;
    console.log(
      `${label} recall@1=${fmt(a.recallAt1)} recall@5=${fmt(a.recallAt5)} recall@10=${fmt(a.recallAt10)} nDCG@10=${fmt(a.ndcgAt10)} MRR=${fmt(a.mrr)}  (ingest ${res.ingest.elapsedMs.toFixed(0)}ms, retrieval mean ${res.retrievalLatencyMeanMs.toFixed(1)}ms/q)`,
    );
    if (res.ingest.syntheticTimestamps) console.warn(`${label} WARNING: some events had synthetic timestamps — corpus should carry its own.`);
    return { recallAt1: a.recallAt1, recallAt5: a.recallAt5, recallAt10: a.recallAt10, ndcgAt10: a.ndcgAt10, mrr: a.mrr };
  } finally {
    if (harper) await stopHarper(harper, { keepInstallDir: false });
    if (prevHybrid === undefined) delete process.env.FLAIR_HYBRID_RETRIEVAL;
    else process.env.FLAIR_HYBRID_RETRIEVAL = prevHybrid;
  }
}

async function main() {
  assertBuilt();
  console.log(`recall-eval (Layer 1, #17) — ${CORPUS.length} records / ${LABELLED_QUERIES.length} labelled queries, ${RUNS} independent run(s)`);
  console.log(`retrieval: hybrid BM25+RRF on, scoring=raw (documented defaults)`);
  if (process.env.FLAIR_MODELS_DIR) console.log(`FLAIR_MODELS_DIR=${process.env.FLAIR_MODELS_DIR}`);
  console.log();

  const runs: Record<MetricKey, number>[] = [];
  for (let i = 1; i <= RUNS; i++) runs.push(await oneRun(i));

  console.log(`\n══ AGGREGATE over ${RUNS} run(s) ══\n`);
  const mean: Record<string, number> = {};
  const spread: Record<string, number> = {};
  for (const m of METRICS) {
    const vals = runs.map((r) => r[m]);
    const mn = vals.reduce((s, x) => s + x, 0) / vals.length;
    const sp = Math.max(...vals) - Math.min(...vals);
    mean[m] = mn;
    spread[m] = sp;
    console.log(`  ${m.padEnd(10)} mean=${fmt(mn)}  spread(max−min)=${fmt(sp)}  floor=${fmt(FLOORS[m])}  [${vals.map((v) => fmt(v)).join(", ")}]`);
  }
  const maxSpread = Math.max(...METRICS.map((m) => spread[m]!));
  console.log(`\n  noise band (max spread across all metrics over ${RUNS} runs): ${fmt(maxSpread)}`);

  if (!CHECK_FLOORS) {
    console.log(`\n(--no-floor-check: floors not enforced)`);
    return;
  }
  const breaches = METRICS.filter((m) => mean[m]! < FLOORS[m]);
  if (breaches.length) {
    console.error(`\nFLOOR BREACH on ${breaches.length} metric(s):`);
    for (const m of breaches) console.error(`  ${m}: mean ${fmt(mean[m]!)} < floor ${fmt(FLOORS[m])}`);
    process.exit(1);
  }
  console.log(`\nAll ${METRICS.length} metrics clear their floors.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
