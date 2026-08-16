#!/usr/bin/env bun
/**
 * run.ts — LongMemEval_s Layer 2 harness CLI (#1216-b).
 *
 *   bun run test/bench/longmemeval/run.ts verify-judge [--repeats 3]
 *       Prove the pinned gemma4 judge returns the CORRECT ternary verdict, and
 *       returns it DETERMINISTICALLY (identical across repeats at temp 0), on a
 *       set of known (answer, gold) pairs spanning every task + abstention.
 *
 *   bun run test/bench/longmemeval/run.ts run --dataset <path> [--n 24] [--seed 0] [--runs 2] [--out <dir>]
 *       Run the four arms over a slice; emit the content-addressed artifact.
 *       Pins the dataset (sha256), the reader + judge (digest), num_ctx, and all
 *       configs. Produces a number; NEVER publishes one (artifact.ts NOTICE).
 *
 * Reproducibility: `ollama pull` the pinned digests + fetch the pinned dataset
 * (see README) and anyone re-runs the exact number locally — no OpenAI key.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  OLLAMA_HOST, JUDGE, READER, DATASET, RETRIEVAL, FULL_CONTEXT,
  assertCrossFamily, configManifest, hashConfig,
} from "./config";
import { assertModelPinned, pingOllama, generate, OllamaError } from "./ollama";
import { buildJudgePrompt, parseVerdict, type LmeTask, type Verdict } from "./judge";
import { loadDataset, selectSlice, abilityOf, isAbstention } from "./dataset";
import { runOnce } from "./eval";
import { aggregateArmAcrossRuns, type ArmRunMetrics } from "./metrics";
import { buildArtifact, writeArtifact, verifyArtifactHash } from "./artifact";
import { ALL_ARMS, type Arm } from "./arms";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function arg(flag: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const hasFlag = (f: string) => process.argv.includes(f);
const fmt = (x: number, d = 3) => x.toFixed(d);
const pct = (x: number) => (x * 100).toFixed(1) + "%";

function gitCommit(): string | null {
  try { return execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim(); } catch { return null; }
}

function assertBuilt(): void {
  const marker = path.join(REPO_ROOT, "dist", "resources", "SemanticSearch.js");
  if (!existsSync(marker)) {
    console.error(`FATAL: ${marker} not found — Harper serves resources from dist/. Run \`bun run build\` first.`);
    process.exit(2);
  }
}

// ── verify-judge: the load-bearing judge determinism + correctness proof ──────
interface JudgeProbe { name: string; task: LmeTask; question: string; answer: string; response: string; abstention: boolean; expect: Verdict }
const JUDGE_PROBES: JudgeProbe[] = [
  { name: "ie-correct", task: "single-session-user", question: "What degree did I graduate with?", answer: "Business Administration", response: "You graduated with a degree in Business Administration.", abstention: false, expect: "CORRECT" },
  { name: "ie-incorrect", task: "single-session-user", question: "What degree did I graduate with?", answer: "Business Administration", response: "You graduated in Computer Science.", abstention: false, expect: "INCORRECT" },
  { name: "ie-not-attempted", task: "single-session-user", question: "What degree did I graduate with?", answer: "Business Administration", response: "I don't have enough information in our conversations to answer that.", abstention: false, expect: "NOT_ATTEMPTED" },
  { name: "temporal-off-by-one", task: "temporal-reasoning", question: "How many days passed between my two trips?", answer: "18 days", response: "There were 19 days between them.", abstention: false, expect: "CORRECT" },
  { name: "knowledge-update", task: "knowledge-update", question: "What is my current phone number?", answer: "555-1234", response: "You previously used 555-0000, but your current number is 555-1234.", abstention: false, expect: "CORRECT" },
  { name: "multi-session-subset", task: "multi-session", question: "Which three cities did I visit last year?", answer: "Paris, Rome, and Tokyo", response: "You visited Paris.", abstention: false, expect: "INCORRECT" },
  { name: "preference-correct", task: "single-session-preference", question: "Recommend a restaurant for dinner.", answer: "The user is vegan; the response should recommend vegan-friendly options.", response: "Since you're vegan, try the plant-based tasting menu at Green Table.", abstention: false, expect: "CORRECT" },
  { name: "abstention-correct", task: "single-session-user", question: "What did I say about my sister's wedding?", answer: "The user never mentioned a sister or a wedding in any session.", response: "I don't have any information about your sister's wedding in our conversations.", abstention: true, expect: "CORRECT" },
  { name: "abstention-hallucination", task: "single-session-user", question: "What did I say about my sister's wedding?", answer: "The user never mentioned a sister or a wedding in any session.", response: "You mentioned your sister's wedding is scheduled for June.", abstention: true, expect: "INCORRECT" },
];

async function verifyJudge(host: string, repeats: number): Promise<void> {
  console.log(`\n=== verify-judge: ${JUDGE.model} @ temp ${JUDGE.temperature}, ${repeats} repeats each ===\n`);
  await assertModelPinned(host, JUDGE);
  let failures = 0;
  for (const p of JUDGE_PROBES) {
    const { prompt, allowed } = buildJudgePrompt(p);
    const verdicts: string[] = [];
    for (let i = 0; i < repeats; i++) {
      const g = await generate(host, JUDGE, prompt);
      let v: string;
      try { v = parseVerdict(g.response, allowed); } catch (e) { v = `PARSE_ERROR(${JSON.stringify(g.response).slice(0, 40)})`; }
      verdicts.push(v);
    }
    const deterministic = verdicts.every((v) => v === verdicts[0]);
    const correct = verdicts[0] === p.expect;
    const ok = deterministic && correct;
    if (!ok) failures++;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${p.name.padEnd(24)} expect=${p.expect.padEnd(14)} got=${verdicts[0]!.padEnd(14)} ` +
      `${deterministic ? "deterministic" : "NON-DETERMINISTIC " + JSON.stringify(verdicts)}`,
    );
  }
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} — ${JUDGE_PROBES.length} probes × ${repeats} repeats\n`);
  if (failures > 0) process.exit(1);
}

// ── run: the slice ───────────────────────────────────────────────────────────
async function runSlice(): Promise<void> {
  assertBuilt();
  assertCrossFamily();
  const host = arg("--host", OLLAMA_HOST)!;
  const datasetPath = arg("--dataset");
  if (!datasetPath) { console.error("run requires --dataset <path to longmemeval_s.json>"); process.exit(2); }
  const n = parseInt(arg("--n", "24")!, 10);
  const seed = parseInt(arg("--seed", "0")!, 10);
  const runs = parseInt(arg("--runs", "2")!, 10);
  const outDir = arg("--out", path.join(REPO_ROOT, "longmemeval-artifacts"))!;
  const allowUnpinned = hasFlag("--allow-unpinned");
  const validationSlice = !hasFlag("--full-run");

  console.log(`\n=== LongMemEval_s Layer 2 — ${validationSlice ? "VALIDATION SLICE" : "run"} ===`);
  console.log(`host=${host}  n=${n}  seed=${seed}  runs=${runs}`);

  // Pin gates: reachability + digest match (fail loud, tags are mutable).
  await pingOllama(host);
  await assertModelPinned(host, READER);
  await assertModelPinned(host, JUDGE);
  console.log(`reader=${READER.model} (${READER.family})  judge=${JUDGE.model} (${JUDGE.family})  [digests verified]`);

  const entries = loadDataset(datasetPath!, { allowUnpinned });
  console.log(`dataset ${DATASET.name} loaded: ${entries.length} questions (sha256 ${allowUnpinned ? "UNVERIFIED" : "verified"})`);
  const slice = selectSlice(entries, n, seed);
  const abilityCounts: Record<string, number> = {};
  for (const e of slice) abilityCounts[abilityOf(e)] = (abilityCounts[abilityOf(e)] ?? 0) + 1;
  console.log(`slice: ${slice.length} questions across abilities: ${JSON.stringify(abilityCounts)}`);

  const manifest = configManifest({ n, seed, runs, questionIds: slice.map((e) => e.question_id) });
  const configHash = hashConfig(manifest);
  console.log(`configHash: ${configHash}\n`);

  const perArmRuns = new Map<Arm, ArmRunMetrics[]>(ALL_ARMS.map((a) => [a, []]));
  const runHashes: string[] = [];
  for (let i = 1; i <= runs; i++) {
    const r = await runOnce(i, slice, { repoRoot: REPO_ROOT, host, log: (s) => console.log(s) });
    runHashes.push(r.runHash);
    for (const m of r.armMetrics) perArmRuns.get(m.arm)!.push(m);
  }

  const aggregate = ALL_ARMS.map((a) => aggregateArmAcrossRuns(a, perArmRuns.get(a)!));
  const artifact = buildArtifact({
    configHash, config: manifest, runHashes, aggregate,
    gitCommit: gitCommit(), ollamaHost: host, benchHost: "rockit", validationSlice,
  });
  const artifactPath = writeArtifact(artifact, outDir);

  // ── report ──
  console.log(`\n${"═".repeat(64)}\n  RESULTS (${validationSlice ? "VALIDATION SLICE — NOT PUBLISHABLE" : "run"}) — ${runs} run(s), mean±std\n${"═".repeat(64)}`);
  for (const a of aggregate) {
    console.log(`\n[${a.arm}]  overall accuracy: ${pct(a.overallAccuracy.mean)} ± ${pct(a.overallAccuracy.std)}   (runs: ${a.overallAccuracy.runs.map((x) => pct(x)).join(", ")})`);
    console.log(`    ${"overall (answerable only)".padEnd(28)} ${pct(a.overallAccuracyAnswerable.mean)} ± ${pct(a.overallAccuracyAnswerable.std)}`);
    for (const [ab, msd] of Object.entries(a.perAbility)) {
      console.log(`    ${ab.padEnd(28)} ${pct(msd!.mean)} ± ${pct(msd!.std)}`);
    }
    console.log(`    ${"abstention (broken out)".padEnd(28)} ${pct(a.abstentionAccuracy.mean)} ± ${pct(a.abstentionAccuracy.std)}`);
    console.log(`    ${"not-attempted (answerable)".padEnd(28)} ${pct(a.notAttemptedRateAnswerable.mean)}`);
    console.log(`    ${"factual F1 (cross-check)".padEnd(28)} ${fmt(a.factualF1.mean)}   containment-EM ${fmt(a.factualContainmentEM.mean)}`);
    console.log(`    ${"tokens/query (mean)".padEnd(28)} ${a.tokensPerQueryMean.mean.toFixed(0)}`);
    console.log(`    ${"latency p50 / p95 (ms)".padEnd(28)} ${a.latencyP50Ms.mean.toFixed(0)} / ${a.latencyP95Ms.mean.toFixed(0)}`);
    if (a.judgeErrorsTotal > 0) console.log(`    !! judge errors: ${a.judgeErrorsTotal} (unparseable verdicts — NOT counted as pass)`);
  }
  const nc = aggregate.find((a) => a.arm === "no-context")!;
  const fl = aggregate.find((a) => a.arm === "flair")!;
  const fc = aggregate.find((a) => a.arm === "full-context")!;
  console.log(`\n── contamination / validity reads (ANSWERABLE questions only) ──`);
  console.log(`  no-context accuracy = ${pct(nc.overallAccuracyAnswerable.mean)}  (HIGH ⇒ reader prior knowledge / contamination — number suspect)`);
  console.log(`    (measured on answerable questions — an abstention question is trivially correct with no context, so it is excluded here)`);
  console.log(`  full-context − flair = ${pct(fc.overallAccuracyAnswerable.mean - fl.overallAccuracyAnswerable.mean)}  (≈0 ⇒ measuring long-context not memory; large ⇒ retrieval losing info)`);
  console.log(`\nartifactHash: ${artifact.artifactHash}`);
  console.log(`artifact self-verifies: ${verifyArtifactHash(artifact)}`);
  console.log(`written: ${artifactPath}`);
  console.log(`\nNOTICE: ${artifact.notice}\n`);
}

async function main() {
  const cmd = process.argv[2];
  try {
    if (cmd === "verify-judge") {
      await verifyJudge(arg("--host", OLLAMA_HOST)!, parseInt(arg("--repeats", "3")!, 10));
    } else if (cmd === "run") {
      await runSlice();
    } else {
      console.log("usage: run.ts <verify-judge|run> [options] — see file header");
      process.exit(2);
    }
  } catch (err) {
    if (err instanceof OllamaError) console.error(`\nOLLAMA/JUDGE SEAM: ${err.message}\n`);
    else console.error(err);
    process.exit(1);
  }
}
main();
