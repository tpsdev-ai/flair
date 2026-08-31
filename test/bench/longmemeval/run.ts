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
 * What a re-runner can verify: `ollama pull` the pinned digests + fetch the
 * pinned dataset (see README) and anyone re-derives the `configHash` exactly —
 * that is the anchor, and it is what "did they run what they said they ran"
 * rests on, together with the exact prompts, the dataset selection and the judge
 * rubric. No OpenAI key, no spend.
 *
 * The NUMBERS are a different claim. `runHash` re-derives only where the reader
 * is bitwise-stable (expected under `local`, not under `cloud`), and
 * `artifactHash` is a SEAL — tamper-evidence for a signed-off artifact — not a
 * reproducibility proof. Under `cloud`, accuracy is a statistical result: re-run
 * and compare within variance, using the reader-determinism probe this command
 * records in the artifact's provenance as the variance to compare against.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolveBenchGitCommit } from "../git-commit";
import {
  OLLAMA_HOST, JUDGE, READER, DATASET, RETRIEVAL, FULL_CONTEXT, INGESTION,
  assertCrossFamily, configManifest, hashConfig,
} from "./config";
import { assertModelPinned, pingOllama, generate, OllamaError } from "./ollama";
import { buildJudgePrompt, parseVerdict, type LmeTask, type Verdict } from "./judge";
import { loadDataset, selectSlice, abilityOf, isAbstention } from "./dataset";
import { runOnce, SELECTED_ARMS, writeProgress, setJournalContext } from "./eval";
import { aggregateArmAcrossRuns, type ArmRunMetrics } from "./metrics";
import { buildArtifact, writeArtifact, verifyArtifactHash } from "./artifact";
import { collectEvidenceCoverage } from "./evidence-coverage";
import { formatReport } from "./report";
import {
  probeReaderDeterminism, failedProbe, printReaderDeterminism, type ReaderDeterminism,
} from "./determinism";
import { ALL_ARMS, type Arm } from "./arms";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function arg(flag: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const hasFlag = (f: string) => process.argv.includes(f);

// The flair code under test: an npm-installed / exported package when
// LME_FLAIR_PKG_DIR is set, otherwise this checkout. gitCommit is resolved from
// THIS directory (checkout HEAD, else its dist/build-info.json stamp), never
// from process.cwd(), and FAILS CLOSED if it cannot — see ../git-commit.ts.
const FLAIR_DIR = process.env.LME_FLAIR_PKG_DIR ?? REPO_ROOT;

// LME_FLAIR_PKG_DIR / LME_HARPER_BIN_DIR (ported from tps-bench): point the
// harness at an npm-installed published @tpsdev-ai/flair instead of the
// worktree, so the bench can run on a VM that has the package but not the repo.
//
// OPERATIONAL-ONLY: these do not change the harness's behavior at all — they
// only say WHERE the system under test lives. When that is a non-checkout
// export, the build identity comes from the package's dist/build-info.json
// commit stamp (flair#1076); a run that can resolve NO commit refuses to write
// an artifact rather than recording gitCommit: null (flair#1432).
function assertBuilt(): void {
  const marker = path.join(FLAIR_DIR, "dist", "resources", "SemanticSearch.js");
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
  // Fail CLOSED before spending a multi-hour run (and shared inference quota):
  // a run whose code cannot be named is not reproducible, so refuse up front
  // rather than after the loop. resolveBenchGitCommit throws with an actionable
  // message; it never returns null (flair#1432).
  const gitCommit = resolveBenchGitCommit(FLAIR_DIR);
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
  // ── The two ARTIFACT-AFFECTING overrides (flair#1366) ─────────────────────
  // Both of these are settings that can change what is measured while the
  // harness is working correctly, so both must enter the hashed config. See the
  // classification header in eval.ts for the test being applied.

  // (1) The arms ACTUALLY run (LME_ARMS subset). A 3-arm run must never hash
  // identically to a 4-arm run: the aggregate contains different arms, and the
  // contamination / ceiling reads that need the missing arms do not exist.
  (manifest as { arms: Arm[] }).arms = SELECTED_ARMS;

  // (2) The Harper-store topology. When both Harper arms run, one ingest per
  // question serves both over a shared store with a per-question mode flip
  // (take-2 ingest-reuse). This is a MEASUREMENT-VALIDITY difference, not a
  // speed one: per-arm stores gave the vector-only arm a full-size HNSW graph
  // while flair queried a growing one — a confound biased FOR flair. A
  // shared-store run and a per-arm-store run therefore must never share a
  // configHash even though models, dataset and prompts are identical.
  const sharedStore = SELECTED_ARMS.includes("flair") && SELECTED_ARMS.includes("vector-only");
  (manifest as { ingestion: unknown }).ingestion = {
    ...INGESTION,
    harperStoreSharing: sharedStore ? "ingest-once-shared-store-alternating-mode" : "per-arm-store",
  };
  const configHash = hashConfig(manifest);
  setJournalContext(configHash); // journal lines carry cfg identity from now on
  if (process.env.LME_RESUME === "1") console.log(`resume: LME_RESUME=1 — banked (question,arm) pairs from ${process.env.LME_RECORDS_JSONL} will be skipped`);
  console.log(`arms: ${SELECTED_ARMS.join(", ")}`);
  if (sharedStore) {
    console.log(`ingest-reuse (take-2): one ingest per question serves flair + vector-only over a shared store with per-question mode flip. configHash intentionally differs from per-arm-store runs (ingestion.harperStoreSharing is hashed).`);
  }
  console.log(`configHash: ${configHash}\n`);

  // ── Reader-determinism probe (flair#1368) ──────────────────────────────────
  // Runs BEFORE the measurement runs, on a FIXED question sample independent of
  // the slice, so its numbers are comparable across every run this harness ever
  // publishes. Its result lands in the artifact's UNHASHED provenance partition:
  // determinism legitimately differs run to run, and hashing it would make every
  // honest re-run look like tampering.
  //
  // A probe failure does NOT abort the run — the probe characterises the reader,
  // it does not gate the measurement, and killing a multi-hour run over it would
  // be the wrong trade. It is recorded as an error in the artifact instead, so
  // "we did not probe" can never be mistaken for "we probed and found nothing".
  let readerDeterminism: ReaderDeterminism;
  try {
    readerDeterminism = await probeReaderDeterminism(host, entries, { log: (s) => console.log(s) });
  } catch (err) {
    readerDeterminism = failedProbe(host, err);
    console.error(`\n!! reader-determinism probe FAILED: ${readerDeterminism.error}`);
    console.error(`   Recorded as an error in the artifact provenance; the run continues.\n`);
  }
  printReaderDeterminism(readerDeterminism);

  const perArmRuns = new Map<Arm, ArmRunMetrics[]>(SELECTED_ARMS.map((a) => [a, []]));
  const runHashes: string[] = [];
  const coverageRuns: Array<{ runIndex: number; results: Awaited<ReturnType<typeof runOnce>>["results"] }> = [];
  for (let i = 1; i <= runs; i++) {
    const r = await runOnce(i, slice, { repoRoot: REPO_ROOT, host, log: (s) => console.log(s) });
    runHashes.push(r.runHash);
    coverageRuns.push({ runIndex: r.runIndex, results: r.results });
    for (const m of r.armMetrics) perArmRuns.get(m.arm)!.push(m);
  }

  const aggregate = SELECTED_ARMS.map((a) => aggregateArmAcrossRuns(a, perArmRuns.get(a)!));
  const artifact = buildArtifact({
    configHash, config: manifest, runHashes, aggregate,
    gitCommit, ollamaHost: host, benchHost: process.env.LME_BENCH_HOST ?? "rockit", validationSlice,
    readerDeterminism,
    evidenceCoverage: collectEvidenceCoverage(coverageRuns),
  });
  const artifactPath = writeArtifact(artifact, outDir);

  // ── report ── (formatting lives in report.ts so it can be tested)
  for (const line of formatReport({ aggregate, runs, validationSlice, selectedArms: SELECTED_ARMS })) {
    console.log(line);
  }
  writeProgress({ done: true, artifactPath });
  console.log(`\nconfigHash (THE ANCHOR — re-derivable by anyone with the repo): ${configHash}`);
  console.log(`artifactHash (A SEAL — tamper-evidence, not a reproducibility proof): ${artifact.artifactHash}`);
  console.log(`artifact self-verifies (unmodified since it was written): ${verifyArtifactHash(artifact)}`);
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
