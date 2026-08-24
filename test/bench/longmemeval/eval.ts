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
  mkAgent, registerAgent, ingestSessionHistory, retrieveContext, type BenchClient,
} from "../../../packages/flair-bench/lib/index";
import { OLLAMA_HOST, READER, JUDGE, RETRIEVAL, FULL_CONTEXT } from "./config";
import { generate } from "./ollama";
import { buildJudgePrompt, parseVerdict, JudgeParseError, type LmeTask } from "./judge";
import { buildReaderPrompt, formatRetrieved, formatFullContext, HARPER_ARMS, type Arm } from "./arms";
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

/** One reader call for a given assembled context. */
async function readerAnswer(
  host: string, question: string, questionDate: string, context: string, arm: Arm,
): Promise<{ answer: string; tokensFed: number; latencyMs: number }> {
  const prompt = buildReaderPrompt(question, questionDate, context);
  const numCtxOverride = arm === "full-context" ? FULL_CONTEXT.numCtx : undefined;
  const g = await generate(host, READER, prompt, { numCtxOverride });
  return { answer: clean(g.response), tokensFed: g.promptTokens, latencyMs: g.latencyMs };
}

/** One judge call. Returns verdict=null + judgeError on an unparseable verdict
 *  (never a silent pass). */
async function judgeOne(
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

/** Evaluate one (question, arm) end to end (reader → judge). `context` and any
 *  retrieval metadata are supplied by the caller (Harper arms retrieve first). */
async function evalOne(
  host: string, entry: LmeEntry, arm: Arm, context: string,
  extra: { retrievalMs?: number; truncated?: boolean; rankedIds?: string[] },
): Promise<QuestionArmResult> {
  const r = await readerAnswer(host, entry.question, entry.question_date, context, arm);
  const abstention = isAbstention(entry);
  const j = await judgeOne(host, entry.question_type, entry.question, entry.answer, r.answer, abstention);
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
  };
}

/** The no-Harper arms: full-context (whole haystack) and no-context (nothing). */
async function runNoHarperArms(host: string, entries: LmeEntry[], log: (s: string) => void): Promise<QuestionArmResult[]> {
  const out: QuestionArmResult[] = [];
  for (const entry of entries) {
    const sessions = entryToSessions(entry);
    // full-context
    const fc = formatFullContext(sessions, FULL_CONTEXT.charBudget);
    out.push(await evalOne(host, entry, "full-context", fc.text, { truncated: fc.truncated }));
    // no-context (the contamination probe): zero memory
    out.push(await evalOne(host, entry, "no-context", "", {}));
  }
  log(`  no-Harper arms done (${entries.length} q × 2 arms)`);
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
    harper = await startHarper({ cwd: opts.repoRoot, harperBinDir: opts.repoRoot });
    for (let qi = 0; qi < entries.length; qi++) {
      const entry = entries[qi]!;
      const agent = mkAgent(`lme-${arm}-${entry.question_id}`);
      await registerAgent(harper, agent);
      const client: BenchClient = { harper, agent };
      const sessions = entryToSessions(entry);
      const ingest = await ingestSessionHistory(client, toSessionHistories(sessions));
      await waitSearchable(client, sessions);
      const t0 = performance.now();
      const ctx = await retrieveContext(client, entry.question, { limit: RETRIEVAL.readerTopK, scoring: RETRIEVAL.scoring });
      const retrievalMs = performance.now() - t0;
      const context = formatRetrieved(ctx.items);
      out.push(await evalOne(host, entry, arm, context, { retrievalMs, rankedIds: ctx.rankedIds }));
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

/** After ingesting a question's haystack, poll until it is actually searchable
 *  so a not-yet-indexed corpus never scores as a retrieval miss. Canary = the
 *  last ingested event's own content; wait until its id surfaces. */
async function waitSearchable(client: BenchClient, sessions: ReturnType<typeof entryToSessions>, timeoutMs = 45_000): Promise<void> {
  const allEvents = sessions.flatMap((s) => s.events);
  const canary = allEvents[allEvents.length - 1];
  if (!canary) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ctx = await retrieveContext(client, canary.content.slice(0, 200), { limit: 20 });
    if (ctx.rankedIds.includes(canary.id)) return;
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
  log(`[run ${runIndex}] starting (${entries.length} questions × 4 arms)`);

  const results: QuestionArmResult[] = [];
  results.push(...(await runNoHarperArms(host, entries, log)));
  results.push(...(await runHarperArm("flair", true, entries, opts, host)));
  results.push(...(await runHarperArm("vector-only", false, entries, opts, host)));

  const arms: Arm[] = ["flair", "vector-only", "full-context", "no-context"];
  const armMetrics = arms.map((a) => aggregateArmRun(a, results));

  // Content-address the run by its DECISIONS (answer/verdict/tokens/extraction),
  // NOT wall-clock latency — a faithful re-run reproduces this hash.
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
