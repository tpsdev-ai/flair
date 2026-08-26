/**
 * eval.ts — the LongMemEval_s Layer 2 pipeline orchestration.
 *
 * Per question: ingest its multi-session haystack into Flair (shared per-event
 * ingest), retrieve context (shared BM25+RRF retrieval at documented defaults),
 * a PINNED reader answers from the retrieved memories, and the PINNED gemma4
 * judge grades the answer with the ternary rubric. Four arms; the reader/judge
 * are the SAME across all arms — only the context differs (Kern §5a).
 *
 * A "run" is independent (Kern §7a): a FRESH ephemeral Harper is spawned per
 * (run, Harper-arm), re-ingested, re-retrieved — so the ≥-run std reflects real
 * run-to-run variance, not carried state. The ephemeral Harper HOME-isolates
 * itself (harper-lifecycle sets HOME=<temp dir>), so ingest NEVER touches prod
 * ~/.flair / :9926.
 */
import {
  startHarper, stopHarper, type HarperInstance,
} from "../../helpers/harper-lifecycle";
import {
  mkAgent, registerAgent, ingestSessionHistory, retrieveContext, adminOp, signedFetch,
  type BenchClient, type TestAgent, type RetrievedContext,
} from "../../../packages/flair-bench/lib/index";
import {
  measureEvidenceCoverage, type EvidenceCoverageRecord,
} from "./evidence-coverage";
import { OLLAMA_HOST, READER, JUDGE, RETRIEVAL, FULL_CONTEXT } from "./config";
import { generate, type OllamaModelSpec } from "./ollama";
import { buildJudgePrompt, parseVerdict, JudgeParseError, type LmeTask } from "./judge";
import { buildReaderPrompt, formatRetrieved, formatFullContext, HARPER_ARMS, ALL_ARMS, type Arm } from "./arms";
import { writeFileSync, rmSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { scoreExtraction } from "./extraction";
import {
  entryToSessions, toSessionHistories, abilityOf, isAbstention, FACTUAL_ABILITIES,
  type LmeEntry,
} from "./dataset";
import { aggregateArmRun, type QuestionArmResult, type ArmRunMetrics } from "./metrics";
import { hashRunResults } from "./artifact";

export interface RunOptions {
  repoRoot: string;
  host?: string;
  /** Log progress lines. */
  log?: (s: string) => void;
}

const clean = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

// ═══════════════════════════════════════════════════════════════════════════
// ARTIFACT-AFFECTING vs OPERATIONAL-ONLY (flair#1366)
//
// Everything below was ported from tps-bench, where it was written DURING the
// headline runs. Each knob is classified, and the test that decides it is:
//
//   ARTIFACT-AFFECTING — under CORRECT operation, two runs that differ only in
//     this setting can legitimately report different numbers. It must enter the
//     hashed config, or the two runs collide on one configHash and the artifact
//     stops identifying what was measured.
//
//   OPERATIONAL-ONLY — under CORRECT operation it cannot change the measured
//     quantity. It governs whether the run COMPLETES, how long it takes, and
//     what telemetry is emitted. If one of these ever does change a number,
//     that is a BUG to fix, not a variant to hash — hashing it would mint a
//     fresh content-address for a broken run and hide the breakage.
//
// The distinction is not "does it touch the run" (all of them do). It is
// "can it change the answer while everything is working".
//
//   ARTIFACT-AFFECTING   SELECTED_ARMS            -> manifest.arms (run.ts)
//                        shared-store ingest-reuse -> manifest.ingestion
//                                                     .harperStoreSharing
//                        model profile             -> manifest.judge/.reader
//                                                     (config.ts, via the pins)
//
//   OPERATIONAL-ONLY     INGEST_CONCURRENCY, RECORDS_JSONL journal (+ its
//                        rankedIds/retrievalMs/cfg/latencyMs/evidenceCoverage
//                        fields), LME_RESUME, PROGRESS_FILE, readiness deadline /
//                        restart-retry / nonce probe, 429+5xx backoff
//                        (ollama.ts), LME_FLAIR_PKG_DIR / LME_HARPER_BIN_DIR /
//                        LME_BENCH_HOST path+provenance overrides (run.ts).
//
// Each declaration below states its own reasoning; see also the README table.
// ═══════════════════════════════════════════════════════════════════════════

// ── Arm selection (2026-08-21, headline run): LME_ARMS=comma,list ────────────
// ARTIFACT-AFFECTING — recorded as manifest.arms by run.ts. A 3-arm run and a
// 4-arm run are different measurements over the same dataset (different
// aggregate content, and the contamination/ceiling reads that depend on the
// missing arms simply do not exist), so they must not share a configHash.
//
// Default = all four arms (zero behavior change when unset). An unknown arm
// name is a FATAL config error — a typo must never silently skip an arm, which
// would otherwise be indistinguishable from a deliberate subset.
// Canonical ALL_ARMS order is preserved regardless of list order.
export const SELECTED_ARMS: Arm[] = (() => {
  const raw = (process.env.LME_ARMS ?? ALL_ARMS.join(","))
    .split(",").map((s) => s.trim()).filter(Boolean);
  for (const a of raw) {
    if (!(ALL_ARMS as string[]).includes(a)) {
      throw new Error(`LME_ARMS contains unknown arm "${a}" (valid: ${ALL_ARMS.join(", ")})`);
    }
  }
  return ALL_ARMS.filter((a) => raw.includes(a));
})();

// ── Ingest client concurrency (2026-08-21, resize prep): LME_INGEST_CONCURRENCY
// OPERATIONAL-ONLY. Parallel PUT workers for ingestSessionHistory (lib default
// 6). Throughput only: the memories are fully determined by the dataset (ids,
// content and timestamps all come from the entry, none are generated at write
// time), so the store END-STATE is identical at any concurrency. What varies is
// the interleaving of writes within a batch window — and that nondeterminism
// already exists at the shipped default of 6, so pinning it would advertise a
// determinism the harness has never had. Logged rather than hashed.
// Raise to ~2× cores on bigger VMs.
const INGEST_CONCURRENCY = Math.max(1, parseInt(process.env.LME_INGEST_CONCURRENCY ?? "6", 10) || 6);

// ── Per-eval journal (take-4 post-mortem, 2026-08-22): LME_RECORDS_JSONL ─────
// OPERATIONAL-ONLY, and the cleanest case of it: this is a pure WRITE-SIDE
// observer. It appends a line describing a result that already exists; nothing
// downstream of the eval reads it during a normal run, so no field it records
// — rankedIds, retrievalMs, cfg, latencyMs — can feed back into an answer, a
// verdict, or a metric. Adding a field to the journal cannot move a number,
// which is exactly why the journal is free to be verbose.
//
// Take-4 died 13h in with every per-question result held in-memory only —
// unrecoverable. When set, every eval is appended as one JSON line the moment
// it exists, so a crashed run's completed evals survive on disk.
const RECORDS_JSONL = process.env.LME_RECORDS_JSONL;

// configHash carried on every new journal line (take-5 gap: lines had no
// config identity; resume validation had to fall back to dataset spot-checks).
// Journal metadata only — never read back into a result.
let JOURNAL_CFG = "";
export function setJournalContext(configHash: string): void { JOURNAL_CFG = configHash.slice(0, 16); }

// ── Resume (take-5 crash, 2026-08-22): LME_RESUME=1 ─────────────────────────
// OPERATIONAL-ONLY with one honest caveat, stated precisely because a reviewer
// should be able to check it rather than take it on faith.
//
// Resume loads the per-eval journal, SKIPS (question, arm) pairs already
// recorded, and replays the banked lines into results. A skipped pair is never
// re-evaluated, so no answer or verdict is regenerated — a resumed run and an
// uninterrupted run produce the SAME set of decisions. `runHash` content-
// addresses exactly those decisions (answer/verdict/tokensFed/extraction, see
// runOnce below) and is therefore resume-invariant.
//
// CAVEAT: `artifactHash` covers the whole aggregate, which includes
// latencyP50Ms/latencyP95Ms — wall clock. Banked lines carry their original
// `latencyMs`, so a journal written by this code replays latency faithfully;
// but a line from BEFORE the journal recorded latencyMs falls back to 0 and
// would drag those percentiles down. Accuracy metrics are exact either way.
// Note this is a property of artifactHash generally, not of resume:
// `artifactHash` IS A SEAL, NOT A PROOF — it detects post-hoc modification of a
// signed-off artifact and was never a reproducibility claim, even locally.
// `configHash` is the re-derivable anchor; `runHash` re-derives under the
// `local` profile (unmeasured) and is statistical under `cloud`. See the
// README section "What 'reproducible' does and does not mean here".
// (Tracked as a separate finding on #1366.)
//
// Extraction is recomputed from the dataset rather than journalled, so an
// extraction-method change cannot be silently inherited from an old journal.
interface BankedLine {
  questionId: string; arm: Arm; ability: string; isAbstention: boolean;
  answer: string; verdict: string | null; judgeError: string | null; tokensFed: number;
  evidenceCoverage?: EvidenceCoverageRecord;
}
export function loadResumeJournal(path: string): Map<string, Map<Arm, BankedLine>> {
  const out = new Map<string, Map<Arm, BankedLine>>();
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  for (const [i, raw] of lines.entries()) {
    let l: BankedLine;
    try { l = JSON.parse(raw); } catch { throw new Error(`resume: journal line ${i + 1} unparseable`); }
    if (!l.questionId || !l.arm) throw new Error(`resume: journal line ${i + 1} missing questionId/arm`);
    if (!out.has(l.questionId)) out.set(l.questionId, new Map());
    const arms = out.get(l.questionId)!;
    if (arms.has(l.arm)) throw new Error(`resume: duplicate (${l.questionId}, ${l.arm}) at journal line ${i + 1}`);
    arms.set(l.arm, l);
  }
  return out;
}

// ── Machine-readable progress (2026-08-21, headline run): LME_PROGRESS_FILE ──
// OPERATIONAL-ONLY — write-only telemetry for a watcher; never read back.
// Written after EVERY (question, arm) evaluation, and stamped done:true (with
// the artifact path) by run.ts after the artifact is written. `questionsDone`
// counts (question, arm) units; `totalQuestions` is questions × selected arms
// (unit recorded in the file so a watcher never misreads the denominator).
const PROGRESS_FILE = process.env.LME_PROGRESS_FILE;
const progressState = {
  startedAt: new Date().toISOString(),
  unit: "question-arm",
  totalQuestions: 0,
  questionsDone: 0,
  arm: "",
  verdictCounts: { CORRECT: 0, INCORRECT: 0, NOT_ATTEMPTED: 0 } as Record<string, number>,
  errors: 0,
  done: false,
  artifactPath: null as string | null,
  updatedAt: "",
};
export function writeProgress(patch: Partial<typeof progressState> = {}): void {
  if (!PROGRESS_FILE) return;
  Object.assign(progressState, patch);
  progressState.updatedAt = new Date().toISOString();
  try { writeFileSync(PROGRESS_FILE, JSON.stringify(progressState, null, 2)); } catch { /* progress is best-effort */ }
}

/**
 * The FULLY RESOLVED reader request for one (question, arm): the model pin, its
 * sampling parameters, the effective num_ctx, and the assembled prompt — in one
 * object.
 *
 * This exists so the harness has exactly ONE definition of "what a reader call
 * is". `readerAnswer()` below issues it, and the reader-determinism probe
 * (determinism.ts, flair#1368) issues the SAME object rather than assembling a
 * second one out of its own parameters.
 *
 * That is deliberate and it is the whole reason the probe is trustworthy. A
 * probe that quietly used a different temperature, seed, num_ctx or prompt
 * shape would be measuring a DIFFERENT system, and its numbers would be worse
 * than no numbers at all because they would look authoritative. The drift is
 * removed by SHAPE — the probe takes no reader parameters, so there is nothing
 * for a future edit to set on one path and forget on the other — rather than by
 * a comment asking the next editor to keep two call sites in step.
 */
export interface ReaderRequest {
  /** The pinned reader spec — model, manifest digest, temperature, seed,
   *  num_ctx, num_predict. Identical object for every arm (Kern §5a: the reader
   *  is pinned across arms; only the CONTEXT differs). */
  spec: OllamaModelSpec;
  /** The assembled prompt, exactly as it goes on the wire. */
  prompt: string;
  /** Per-call overrides. Only the full-context arm sets one, and it is still
   *  fixed and still hashed (config.FULL_CONTEXT). */
  opts: { numCtxOverride?: number };
}

export function buildReaderRequest(
  question: string, questionDate: string, context: string, arm: Arm,
): ReaderRequest {
  return {
    spec: READER,
    prompt: buildReaderPrompt(question, questionDate, context),
    opts: { numCtxOverride: arm === "full-context" ? FULL_CONTEXT.numCtx : undefined },
  };
}

/** One reader call for a given assembled context. Exported so the determinism
 *  probe repeats THIS call rather than a lookalike of it. */
export async function readerAnswer(
  host: string, question: string, questionDate: string, context: string, arm: Arm,
): Promise<{ answer: string; tokensFed: number; latencyMs: number }> {
  const req = buildReaderRequest(question, questionDate, context, arm);
  const g = await generate(host, req.spec, req.prompt, req.opts);
  return { answer: clean(g.response), tokensFed: g.promptTokens, latencyMs: g.latencyMs };
}

/** One judge call. Returns verdict=null + judgeError on an unparseable verdict
 *  (never a silent pass). Exported for the same reason as readerAnswer: the
 *  determinism probe scores its N completions through the run's OWN judge path,
 *  not a re-implementation of it. */
export async function judgeOne(
  host: string, task: LmeTask, question: string, answer: string, response: string, abstention: boolean,
): Promise<{ verdict: QuestionArmResult["verdict"]; judgeError?: string }> {
  const { prompt, allowed } = buildJudgePrompt({ task, question, answer, response, abstention });
  const g = await generate(host, JUDGE, prompt);
  try {
    return { verdict: parseVerdict(g.response, allowed) };
  } catch (err) {
    if (err instanceof JudgeParseError) return { verdict: null, judgeError: err.message };
    throw err;
  }
}

function extractionFor(entry: LmeEntry, answer: string) {
  const ability = abilityOf(entry);
  if (!FACTUAL_ABILITIES.includes(ability)) return undefined;
  return scoreExtraction(answer, entry.answer);
}

/** flair#1358 — coverage from a Harper retrieval. formatRetrieved includes
 *  every ranked item, so the handoff set is the item ids (not a substring
 *  scan of the prompt — overlapping event text would otherwise count a
 *  truncated event as present). */
function coverageForRetrieved(
  entry: LmeEntry, arm: Arm, ctx: RetrievedContext,
): EvidenceCoverageRecord {
  return measureEvidenceCoverage({
    entry, arm,
    stages: {
      pool: ctx.legs ?? { bm25: [], hnsw: [], fused: ctx.rankedIds },
      topK: ctx.rankedIds,
      readerContext: ctx.items.map((i) => i.id),
    },
    topKItems: ctx.items,
  });
}

function coverageForFullContext(entry: LmeEntry, includedEventIds: string[]): EvidenceCoverageRecord {
  const events = entryToSessions(entry).flatMap((s) => s.events);
  const allIds = events.map((e) => e.id);
  return measureEvidenceCoverage({
    entry, arm: "full-context",
    stages: {
      pool: { bm25: [], hnsw: [], fused: allIds },
      topK: allIds,
      readerContext: includedEventIds,
    },
    topKItems: events,
  });
}

function coverageForNoContext(entry: LmeEntry): EvidenceCoverageRecord {
  return measureEvidenceCoverage({
    entry, arm: "no-context",
    stages: { pool: { bm25: [], hnsw: [], fused: [] }, topK: [], readerContext: [] },
  });
}

/** Evaluate one (question, arm) end to end (reader → judge). `context` and any
 *  retrieval metadata are supplied by the caller (Harper arms retrieve first). */
async function evalOne(
  host: string, entry: LmeEntry, arm: Arm, context: string,
  extra: { retrievalMs?: number; truncated?: boolean; rankedIds?: string[]; evidenceCoverage?: EvidenceCoverageRecord },
): Promise<QuestionArmResult> {
  const r = await readerAnswer(host, entry.question, entry.question_date, context, arm);
  const abstention = isAbstention(entry);
  const j = await judgeOne(host, entry.question_type, entry.question, entry.answer, r.answer, abstention);
  if (j.verdict) progressState.verdictCounts[j.verdict] = (progressState.verdictCounts[j.verdict] ?? 0) + 1;
  else progressState.errors++;
  writeProgress({ questionsDone: progressState.questionsDone + 1, arm });
  if (RECORDS_JSONL) {
    try {
      appendFileSync(RECORDS_JSONL, JSON.stringify({
        questionId: entry.question_id, arm, ability: abilityOf(entry), isAbstention: abstention,
        answer: r.answer, verdict: j.verdict, judgeError: j.judgeError ?? null,
        tokensFed: r.tokensFed, latencyMs: r.latencyMs + (extra.retrievalMs ?? 0),
        // Journal-completeness (2026-08-23): retrieval wall-clock SEPARATE from
        // reader latency, and the retrieved ids in final rank order — without
        // these a wrong answer can't be attributed retrieval-vs-reader, nor
        // retrieval latency separated, from the journal alone.
        retrievalMs: extra.retrievalMs ?? null, rankedIds: extra.rankedIds ?? null,
        evidenceCoverage: extra.evidenceCoverage ?? null,
        cfg: JOURNAL_CFG, at: new Date().toISOString(),
      }) + "\n");
    } catch { /* journal is best-effort */ }
  }
  return {
    questionId: entry.question_id,
    ability: abilityOf(entry),
    isAbstention: abstention,
    arm,
    answer: r.answer,
    verdict: j.verdict,
    judgeError: j.judgeError,
    extraction: extractionFor(entry, r.answer),
    tokensFed: r.tokensFed,
    latencyMs: r.latencyMs + (extra.retrievalMs ?? 0),
    retrievalMs: extra.retrievalMs,
    rankedIds: extra.rankedIds,
    truncated: extra.truncated,
    evidenceCoverage: extra.evidenceCoverage,
  };
}

/** The no-Harper arms: full-context (whole haystack) and no-context (nothing).
 *  Each runs only when selected (LME_ARMS). */
async function runNoHarperArms(
  host: string, entries: LmeEntry[], log: (s: string) => void,
  isDone: (qid: string, arm: Arm) => boolean = () => false,
): Promise<QuestionArmResult[]> {
  const doFc = SELECTED_ARMS.includes("full-context");
  const doNc = SELECTED_ARMS.includes("no-context");
  const out: QuestionArmResult[] = [];
  for (const entry of entries) {
    if (doFc && !isDone(entry.question_id, "full-context")) {
      const sessions = entryToSessions(entry);
      const fc = formatFullContext(sessions, FULL_CONTEXT.charBudget);
      out.push(await evalOne(host, entry, "full-context", fc.text, {
        truncated: fc.truncated,
        evidenceCoverage: coverageForFullContext(entry, fc.includedEventIds),
      }));
    }
    // no-context (the contamination probe): zero memory
    if (doNc && !isDone(entry.question_id, "no-context")) {
      out.push(await evalOne(host, entry, "no-context", "", {
        evidenceCoverage: coverageForNoContext(entry),
      }));
    }
  }
  log(`  no-Harper arms done (${entries.length} q × ${(doFc ? 1 : 0) + (doNc ? 1 : 0)} arms)`);
  return out;
}

/** A Harper arm: spawn a fresh ephemeral Harper with hybrid on/off, then per
 *  question ingest → wait searchable → retrieve → read → judge. */
async function runHarperArm(
  arm: Arm, hybrid: boolean, entries: LmeEntry[], opts: RunOptions, host: string,
): Promise<QuestionArmResult[]> {
  const log = opts.log ?? (() => {});
  const prev = process.env.FLAIR_HYBRID_RETRIEVAL;
  process.env.FLAIR_HYBRID_RETRIEVAL = hybrid ? "true" : "false";
  let harper: HarperInstance | undefined;
  const out: QuestionArmResult[] = [];
  try {
    log(`  [${arm}] spawning ephemeral Harper (hybrid=${hybrid})...`);
    harper = await startHarper({
      // tps-bench: cwd => the npm-installed published @tpsdev-ai/flair package
      // (the system under test), harperBinDir => the install root (npm hoists
      // harper there). Unset => original worktree behavior.
      cwd: process.env.LME_FLAIR_PKG_DIR ?? opts.repoRoot,
      harperBinDir: process.env.LME_HARPER_BIN_DIR ?? opts.repoRoot,
    });
    for (let qi = 0; qi < entries.length; qi++) {
      const entry = entries[qi]!;
      const agent = mkAgent(`lme-${arm}-${entry.question_id}`);
      await registerAgent(harper, agent);
      const client: BenchClient = { harper, agent };
      const sessions = entryToSessions(entry);
      const ingest = await ingestSessionHistory(client, toSessionHistories(sessions), { concurrency: INGEST_CONCURRENCY });
      await waitSearchable(client, sessions);
      const t0 = performance.now();
      const ctx = await retrieveContext(client, entry.question, {
        limit: RETRIEVAL.readerTopK, scoring: RETRIEVAL.scoring, includeLegs: true,
      });
      const retrievalMs = performance.now() - t0;
      const context = formatRetrieved(ctx.items);
      out.push(await evalOne(host, entry, arm, context, {
        retrievalMs, rankedIds: ctx.rankedIds,
        evidenceCoverage: coverageForRetrieved(entry, arm, ctx),
      }));
      if ((qi + 1) % 5 === 0 || qi === entries.length - 1) {
        log(`  [${arm}] ${qi + 1}/${entries.length} (last ingest ${ingest.written} events, ${ingest.elapsedMs.toFixed(0)}ms)`);
      }
    }
  } finally {
    if (harper) await stopHarper(harper, { keepInstallDir: false });
    if (prev === undefined) delete process.env.FLAIR_HYBRID_RETRIEVAL;
    else process.env.FLAIR_HYBRID_RETRIEVAL = prev;
  }
  return out;
}

/**
 * Ingest-reuse mode (take-2, 2026-08-21): ONE ingest per question serves BOTH
 * Harper arms.
 *
 * ARTIFACT-AFFECTING — recorded by run.ts as
 * `ingestion.harperStoreSharing = "ingest-once-shared-store-alternating-mode"`
 * (vs "per-arm-store"), and it MUST be, for a reason that is the opposite of
 * bookkeeping: this is not an optimisation that happens to be observable, it is
 * a MEASUREMENT-VALIDITY property. The two topologies genuinely measure
 * different things, and the per-arm topology measures the wrong one.
 *
 * Under the old whole-arm phasing, the flair arm ran first over a store that
 * GREW question by question, then the vector-only arm ran over a store that was
 * already full size. Filtered-ANN candidate recall degrades as the HNSW graph
 * grows, so vector-only was being asked a systematically harder question than
 * flair was — an index-state asymmetry biased FOR flair, i.e. biased toward the
 * result we would most like to be true. Alternating per question removes it:
 * both arms query the byte-identical store state (memories 1..i).
 *
 * So a shared-store run and a per-arm-store run must never share a configHash.
 * They are not the same experiment reported at two speeds; one of them contains
 * a confound. Hashing the topology is what stops a reader from comparing them
 * as if they were interchangeable.
 *
 * (It is also ~2× faster — ingest is embedding compute, ~95% of arm time;
 * measured 99% 4-core saturation, libuv embed workers hot, JS main thread idle.
 * That is the reason it was reachable, not the reason it is correct.)
 *
 * Design constraint that shapes the loop: hybrid on/off is a Harper
 * PROCESS-level env (read per-call server-side, but not per-request), and the
 * HNSW index grows as questions accumulate. A naive "flair phase then
 * vector-only phase" would have vector-only querying a full-size index while
 * flair queried a growing one — a systematic index-state asymmetry biased FOR
 * flair (filtered-ANN candidate recall degrades as the graph grows). So we
 * ALTERNATE the Harper's mode per question over ONE shared store
 * (StartHarperOptions.installDir reuse — the lifecycle's documented shape).
 * Each phase: the arm matching the current mode (1) queries the question
 * ingested in the PREVIOUS phase (query-only, ZERO ingest), then (2) ingests
 * and queries the NEXT question; then the store restarts with the mode
 * flipped.
 *
 * Effect: every question is ingested exactly once, and BOTH arms query it
 * against the byte-identical store state (memories 1..i) — exact per-question
 * index parity, 1 restart per question (~10-20s each vs ~700s saved per
 * question). Queries are agent-scoped (one agent per question, keypair held
 * in-memory across restarts), so results never see other questions' memories.
 */
async function runHarperArmsShared(
  entries: LmeEntry[], opts: RunOptions, host: string,
  isDone: (qid: string, arm: Arm) => boolean = () => false,
): Promise<QuestionArmResult[]> {
  const log = opts.log ?? (() => {});
  const prev = process.env.FLAIR_HYBRID_RETRIEVAL;
  const startOpts = () => ({
    cwd: process.env.LME_FLAIR_PKG_DIR ?? opts.repoRoot,
    harperBinDir: process.env.LME_HARPER_BIN_DIR ?? opts.repoRoot,
  });
  const countProbe = process.env.LME_SHARED_COUNT_PROBE === "1";
  const out: QuestionArmResult[] = [];
  const agents = new Map<string, TestAgent>();
  const restartMs: number[] = [];
  let ingests = 0;
  const phaseIngests: Record<string, number> = { flair: 0, "vector-only": 0 };
  let hybrid = true;
  process.env.FLAIR_HYBRID_RETRIEVAL = "true";
  log(`  [shared] ingest-reuse: one ingest/question serves both Harper arms; alternating mode flip (1 restart/question) keeps exact per-question index parity`);
  let harper = await startHarper(startOpts());
  const installDir = harper.installDir;
  log(`  [shared] store: ${installDir}`);

  /** Memory row count via the ops API — smoke-mode proof that both arms query
   *  the same corpus and that a query-only phase ingested nothing. */
  async function memoryRows(): Promise<number | string> {
    const res = await adminOp(harper, { operation: "sql", sql: "SELECT COUNT(*) AS n FROM flair.Memory" });
    if (!res.ok) return `probe-failed HTTP ${res.status}`;
    const j: any = await res.json().catch(() => null);
    const row = Array.isArray(j) ? j[0] : j;
    return row?.n ?? row?.["COUNT(*)"] ?? JSON.stringify(row).slice(0, 60);
  }

  // ── Readiness hardening (take-4 post-mortem, 2026-08-22) ──────────────────
  // OPERATIONAL-ONLY — and this is the classification most worth challenging,
  // so here is the argument in full.
  //
  // A readiness gate obviously CAN move a number: pass too early and the arm
  // queries a half-indexed corpus and scores as a retrieval miss. The reason it
  // is still operational-only is that the gate is a CORRECTNESS PRECONDITION,
  // not a measurement parameter. Its contract is binary — "this question's
  // corpus is fully persisted and embedded" — and it is applied per question,
  // before EITHER arm queries, so it cannot tilt one arm against the other. A
  // gate that passes early does not produce a different valid measurement; it
  // produces an INVALID one. Hashing the deadline would content-address the
  // breakage and make a broken run look like a legitimate variant.
  //
  // What makes that argument hold in practice is the shape of the gate itself
  // (see "Readiness gate v2" below): the hard gate is a DETERMINISTIC,
  // SCALE-INDEPENDENT predicate — the row exists and its embeddingModel stamp
  // is set — so there is no threshold to tune and nothing for a reviewer to
  // suspect of having been tuned toward a nicer result. The one gate that WAS
  // scale-sensitive and ranking-based got demoted to non-fatal telemetry for
  // exactly this reason.
  //
  // The deadline and the restart-retry are therefore about not dying, not about
  // when to look: they bound how long we wait for that predicate to go true.
  //
  // Post-restart index readiness lags /health and GROWS with store size (fixed
  // 45s deadline died at ~66k rows, 13h in). Deadline scales from MEASURED
  // waits: 6× the max observed, floor 90s, cap 20min. On a blown deadline: ONE
  // same-mode store restart (flushes/reloads index pipelines) and one retry at
  // the same deadline before failing the run — then it FAILS, loudly. There is
  // no "give up and query anyway" path, which is what would make this
  // artifact-affecting.
  let maxSearchWaitMs = 5_000; // scaling floor
  const searchDeadlineMs = () => Math.min(1_200_000, Math.max(90_000, 6 * maxSearchWaitMs));
  async function restartSameMode(): Promise<void> {
    const t0 = performance.now();
    await stopHarper(harper, { keepInstallDir: true });
    harper = await startHarper({ ...startOpts(), installDir });
    restartMs.push(performance.now() - t0);
  }
  // ── Readiness gate v2 (take-5 post-mortem, 2026-08-22) ────────────────────
  // Take-4/5 both died at q133's PENDING-path check in vector-only mode. Repro
  // (repro-canary.ts): in a fresh single-question store the same canary ranks
  // 1-2 in BOTH modes — it was indexed all along. The failure needs the ~66k-
  // row store: agent-filtered ANN candidate recall collapses at scale for
  // generic content in pure-vector mode. Conclusion: ANY readiness gate built
  // on search RANKING can starve at scale — including a nonce self-match. So:
  //   HARD GATE (deterministic, scale-independent): ops-API SQL — the canary
  //     row EXISTS and its embeddingModel stamp is set (persisted + embedded).
  //   SOFT PROBE (telemetry, never fatal): nonce self-query under a separate
  //     probe agent — watches the search path; logged WARN on miss.
  // Scaled deadline + one same-mode restart-retry kept as backstops.
  async function canaryStamped(entry: LmeEntry): Promise<{ ready: boolean; detail: string }> {
    const events = entryToSessions(entry).flatMap((s) => s.events);
    const canary = events[events.length - 1];
    if (!canary) return { ready: true, detail: "no events" };
    const res = await adminOp(harper, { operation: "sql", sql: `SELECT id, embeddingModel FROM flair.Memory WHERE id = '${canary.id}'` });
    if (!res.ok) return { ready: false, detail: `sql HTTP ${res.status}` };
    const j: any = await res.json().catch(() => null);
    const row = Array.isArray(j) ? j[0] : null;
    if (!row) return { ready: false, detail: `row ${canary.id} absent` };
    if (!row.embeddingModel) return { ready: false, detail: `row ${canary.id} embedding unstamped` };
    return { ready: true, detail: "persisted+stamped" };
  }
  async function pollStamped(entry: LmeEntry, deadlineMs: number): Promise<number> {
    const t0 = Date.now();
    let last = "";
    while (Date.now() - t0 < deadlineMs) {
      const r = await canaryStamped(entry);
      if (r.ready) return Date.now() - t0;
      last = r.detail;
      await new Promise((res) => setTimeout(res, 1000));
    }
    throw new Error(`readiness gate: canary for ${entry.question_id} not persisted+stamped within ${deadlineMs}ms (last: ${last})`);
  }
  let probeAgent: TestAgent | null = null;
  async function softSearchProbe(tag: string): Promise<void> {
    try {
      if (!probeAgent) {
        probeAgent = mkAgent(`lme-readiness-probe`);
        await registerAgent(harper, probeAgent);
      }
      const nonce = `readiness-canary readiness-nonce-${randomUUID()}`;
      const pid = `probe__${Date.now()}__${Math.floor(Math.random() * 1e6)}`;
      const w = await signedFetch(
        harper, probeAgent, "PUT", `/Memory/${pid}`,
        { id: pid, agentId: probeAgent.id, content: nonce, durability: "standard", createdAt: new Date().toISOString() },
      );
      if (!w.ok) { log(`  [shared][probe-warn] ${tag}: nonce write HTTP ${w.status}`); return; }
      const t0 = Date.now();
      while (Date.now() - t0 < 20_000) {
        const ctx = await retrieveContext({ harper, agent: probeAgent }, nonce, { limit: 20 });
        if (ctx.rankedIds.includes(pid)) return; // search path serving
        await new Promise((res) => setTimeout(res, 1000));
      }
      log(`  [shared][probe-warn] ${tag}: nonce not surfacing via search within 20s (hard gate passed; search-path telemetry only)`);
    } catch (err) {
      log(`  [shared][probe-warn] ${tag}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    }
  }
  async function ensureSearchable(entry: LmeEntry): Promise<void> {
    const deadline = searchDeadlineMs();
    try {
      maxSearchWaitMs = Math.max(maxSearchWaitMs, await pollStamped(entry, deadline));
    } catch (err) {
      log(`  [shared] !! readiness timeout (${deadline}ms) for ${entry.question_id} — one same-mode restart+retry: ${err instanceof Error ? err.message.slice(0, 140) : String(err)}`);
      await restartSameMode();
      maxSearchWaitMs = Math.max(maxSearchWaitMs, await pollStamped(entry, deadline));
      log(`  [shared] recovered after restart: ${entry.question_id} ready`);
    }
    await softSearchProbe(entry.question_id);
  }

  /** Query + eval one entry under the CURRENT mode (no ingest here). */
  async function queryEval(entry: LmeEntry, arm: Arm): Promise<void> {
    const agent = agents.get(entry.question_id)!;
    const client: BenchClient = { harper, agent };
    if (countProbe) log(`  [shared][probe] Memory rows before ${arm} query of ${entry.question_id}: ${await memoryRows()}`);
    const t0 = performance.now();
    const ctx = await retrieveContext(client, entry.question, {
      limit: RETRIEVAL.readerTopK, scoring: RETRIEVAL.scoring, includeLegs: true,
    });
    const retrievalMs = performance.now() - t0;
    const context = formatRetrieved(ctx.items);
    out.push(await evalOne(host, entry, arm, context, {
      retrievalMs, rankedIds: ctx.rankedIds,
      evidenceCoverage: coverageForRetrieved(entry, arm, ctx),
    }));
  }

  async function flipMode(): Promise<void> {
    const t0 = performance.now();
    await stopHarper(harper, { keepInstallDir: true });
    hybrid = !hybrid;
    process.env.FLAIR_HYBRID_RETRIEVAL = hybrid ? "true" : "false";
    harper = await startHarper({ ...startOpts(), installDir });
    restartMs.push(performance.now() - t0);
  }

  // Resume partitioning: fully-banked questions are skipped outright; a
  // question with exactly ONE arm banked (the crash boundary) gets its corpus
  // ingested and ONLY the missing arm queried; the rest run the normal
  // alternation.
  const singles: Array<{ entry: LmeEntry; missing: Arm }> = [];
  const todo: LmeEntry[] = [];
  for (const e of entries) {
    const f = isDone(e.question_id, "flair");
    const v = isDone(e.question_id, "vector-only");
    if (f && v) continue;
    if (f || v) singles.push({ entry: e, missing: f ? "vector-only" : "flair" });
    else todo.push(e);
  }
  if (singles.length || entries.length !== todo.length) {
    log(`  [shared] resume partition: ${entries.length - todo.length - singles.length} fully banked, ${singles.length} single-arm, ${todo.length} to run`);
  }

  try {
    for (const { entry, missing } of singles) {
      const needHybrid = missing === "flair";
      if (hybrid !== needHybrid) await flipMode();
      const agent = mkAgent(`lme-shared-${entry.question_id}`);
      agents.set(entry.question_id, agent);
      await registerAgent(harper, agent);
      const client: BenchClient = { harper, agent };
      const sessions = entryToSessions(entry);
      await ingestSessionHistory(client, toSessionHistories(sessions), { concurrency: INGEST_CONCURRENCY });
      ingests++; phaseIngests[missing]! += 1;
      await ensureSearchable(entry);
      await queryEval(entry, missing);
      log(`  [shared] single-arm resume: ${entry.question_id} ${missing} done`);
    }

    let idx = 0;
    let pending: LmeEntry | null = null; // ingested last phase; other arm still owes its query
    entries = todo;
    while (idx < entries.length || pending) {
      const arm: Arm = hybrid ? "flair" : "vector-only";
      // (a) the pending question: QUERY-ONLY under this mode — zero ingest.
      if (pending) {
        const entry = pending; pending = null;
        // canary re-check after restart: index must still serve this corpus
        await ensureSearchable(entry);
        await queryEval(entry, arm);
      }
      // (b) next question: ingest ONCE + query under this same mode.
      if (idx < entries.length) {
        const entry = entries[idx++]!;
        const agent = mkAgent(`lme-shared-${entry.question_id}`);
        agents.set(entry.question_id, agent);
        await registerAgent(harper, agent);
        const client: BenchClient = { harper, agent };
        const sessions = entryToSessions(entry);
        const ingest = await ingestSessionHistory(client, toSessionHistories(sessions), { concurrency: INGEST_CONCURRENCY });
        ingests++; phaseIngests[arm]! += 1;
        await ensureSearchable(entry);
        await queryEval(entry, arm);
        pending = entry;
        if (idx % 5 === 0 || idx === entries.length) {
          const mr = restartMs.length ? (restartMs.reduce((a, b) => a + b, 0) / restartMs.length / 1000).toFixed(1) : "n/a";
          log(`  [shared] ${idx}/${entries.length} ingested (last: ${ingest.written} events, ${ingest.elapsedMs.toFixed(0)}ms; ingests ${ingests}; restarts ${restartMs.length}, mean ${mr}s; searchWait max ${(maxSearchWaitMs / 1000).toFixed(1)}s, next deadline ${(searchDeadlineMs() / 1000).toFixed(0)}s)`);
        }
      }
      // (c) flip the mode if any work remains.
      if (idx < entries.length || pending) await flipMode();
    }
    log(`  [shared] complete: ${ingests} ingests for ${entries.length} questions × 2 arms = ${out.length} evals ` +
        `(flair-phase ingests ${phaseIngests.flair}, vector-phase ingests ${phaseIngests["vector-only"]}); ` +
        `${restartMs.length} restarts, mean ${(restartMs.reduce((a, b) => a + b, 0) / Math.max(1, restartMs.length) / 1000).toFixed(1)}s`);
  } finally {
    await stopHarper(harper, { keepInstallDir: false });
    try { rmSync(installDir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* best effort */ }
    if (prev === undefined) delete process.env.FLAIR_HYBRID_RETRIEVAL;
    else process.env.FLAIR_HYBRID_RETRIEVAL = prev;
  }
  return out;
}

/** After ingesting a question's haystack, poll until it is actually searchable
 *  so a not-yet-indexed corpus never scores as a retrieval miss. Canary = the
 *  last ingested event's own content; wait until its id surfaces.
 *  Returns the observed wait in ms so callers can SCALE future deadlines from
 *  measured readiness latency (take-4 post-mortem: a fixed 45s deadline died
 *  13h in — post-restart index readiness lags /health and grows with store
 *  size; ~66k rows crossed 45s). */
async function waitSearchable(client: BenchClient, sessions: ReturnType<typeof entryToSessions>, timeoutMs = 45_000): Promise<number> {
  const allEvents = sessions.flatMap((s) => s.events);
  const canary = allEvents[allEvents.length - 1];
  if (!canary) return 0;
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  while (Date.now() < deadline) {
    const ctx = await retrieveContext(client, canary.content.slice(0, 200), { limit: 20 });
    if (ctx.rankedIds.includes(canary.id)) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`waitSearchable: canary event ${canary.id} never surfaced within ${timeoutMs}ms (embedding engine slow/down?)`);
}

export interface OneRunResult {
  runIndex: number;
  results: QuestionArmResult[];
  armMetrics: ArmRunMetrics[];
  runHash: string;
}

/** Run ALL arms once over the slice. Fresh Harper per Harper-arm. */
export async function runOnce(runIndex: number, entries: LmeEntry[], opts: RunOptions): Promise<OneRunResult> {
  const host = opts.host ?? OLLAMA_HOST;
  const log = opts.log ?? (() => {});
  log(`[run ${runIndex}] starting (${entries.length} questions × ${SELECTED_ARMS.length} arms: ${SELECTED_ARMS.join(", ")})`);
  writeProgress({ totalQuestions: entries.length * SELECTED_ARMS.length });

  const results: QuestionArmResult[] = [];

  // ── Resume: fold banked journal evals into results, skip their pairs. ─────
  let isDone: (qid: string, arm: Arm) => boolean = () => false;
  if (process.env.LME_RESUME === "1") {
    if (!RECORDS_JSONL || !existsSync(RECORDS_JSONL)) {
      throw new Error(`LME_RESUME=1 but journal ${RECORDS_JSONL ?? "(LME_RECORDS_JSONL unset)"} does not exist`);
    }
    const banked = loadResumeJournal(RECORDS_JSONL);
    const byId = new Map(entries.map((e) => [e.question_id, e]));
    let n = 0;
    for (const [qid, arms] of banked) {
      const entry = byId.get(qid);
      if (!entry) throw new Error(`resume: journal question ${qid} not in this run's slice — journal/config mismatch`);
      for (const [arm, l] of arms) {
        if (!(SELECTED_ARMS as string[]).includes(arm)) continue;
        results.push({
          questionId: qid, ability: abilityOf(entry), isAbstention: l.isAbstention, arm,
          answer: l.answer, verdict: (l.verdict ?? null) as QuestionArmResult["verdict"],
          judgeError: l.judgeError ?? undefined, extraction: extractionFor(entry, l.answer),
          tokensFed: l.tokensFed, latencyMs: (l as any).latencyMs ?? 0,
          evidenceCoverage: l.evidenceCoverage,
        });
        if (l.verdict) progressState.verdictCounts[l.verdict] = (progressState.verdictCounts[l.verdict] ?? 0) + 1;
        else progressState.errors++;
        n++;
      }
    }
    progressState.questionsDone = n;
    isDone = (qid, arm) => banked.get(qid)?.has(arm) ?? false;
    log(`[resume] ${n} banked evals folded in from ${RECORDS_JSONL}; their (question,arm) pairs will be skipped`);
    writeProgress({});
  }

  if (SELECTED_ARMS.includes("full-context") || SELECTED_ARMS.includes("no-context")) {
    results.push(...(await runNoHarperArms(host, entries, log, isDone)));
  }
  const sharedStore = SELECTED_ARMS.includes("flair") && SELECTED_ARMS.includes("vector-only");
  if (sharedStore) {
    // Ingest-reuse: one ingest per question serves both Harper arms.
    results.push(...(await runHarperArmsShared(entries, opts, host, isDone)));
  } else {
    if (process.env.LME_RESUME === "1" && (SELECTED_ARMS.includes("flair") || SELECTED_ARMS.includes("vector-only"))) {
      throw new Error("LME_RESUME=1 is only supported for the shared-store (flair+vector-only) path — a single Harper arm would re-run banked pairs and duplicate results");
    }
    if (SELECTED_ARMS.includes("flair")) {
      results.push(...(await runHarperArm("flair", true, entries, opts, host)));
    }
    if (SELECTED_ARMS.includes("vector-only")) {
      results.push(...(await runHarperArm("vector-only", false, entries, opts, host)));
    }
  }

  const armMetrics = SELECTED_ARMS.map((a) => aggregateArmRun(a, results));

  // Content-address the run by its DECISIONS (answer/verdict/tokens/extraction),
  // NOT wall-clock latency.
  //
  // What re-derives, precisely (Sherlock's tier 2, flair#1368): because the
  // answer TEXT is in here, this hash re-derives only where the reader is
  // bitwise-stable. Under `local` that is expected but UNMEASURED, so it is not
  // claimed. Under `cloud` it does not hold — batched inference is not
  // bitwise-stable at temperature 0 / seed 0 — so a cloud accuracy is a
  // statistical result to be compared within variance, and determinism.ts
  // publishes the variance to compare against.
  const decisions = results
    .map((r) => ({
      questionId: r.questionId, arm: r.arm, answer: r.answer,
      verdict: r.verdict, judgeError: r.judgeError ?? null,
      tokensFed: r.tokensFed, extraction: r.extraction ?? null,
    }))
    .sort((a, b) => (a.arm + a.questionId).localeCompare(b.arm + b.questionId));
  const runHash = hashRunResults(decisions);

  log(`[run ${runIndex}] done — runHash ${runHash.slice(0, 16)}`);
  return { runIndex, results, armMetrics, runHash };
}
