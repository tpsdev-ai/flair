/**
 * metrics.ts — pure aggregation over graded questions. No I/O, no model, no
 * Harper: given per-(question,arm) outcomes, compute per-ability accuracy (the
 * 5 abilities), abstention BROKEN OUT separately, overall accuracy, the
 * independent F1/EM cross-check on the factual subset, tokens/query, and
 * p50/p95 latency — then mean±std across runs (pass^k, not best-of).
 *
 * Grading uses the SimpleQA ternary. LongMemEval headline accuracy = CORRECT /
 * judged: NOT_ATTEMPTED and INCORRECT are both not-correct. NOT_ATTEMPTED on an
 * answerable question is reported SEPARATELY (the abstention-aware breakout) so
 * a reader that correctly declines isn't silently lumped with one that's wrong.
 *
 * Judge errors (an unparseable verdict — never a silent pass) are counted and
 * surfaced; accuracy is computed over successfully-judged questions, so a judge
 * error neither inflates nor deflates the number, but its COUNT is always
 * reported and a nonzero count flags the run.
 */
import type { Verdict } from "./judge";
import type { Ability } from "./dataset";
import { FACTUAL_ABILITIES } from "./dataset";
import type { Arm } from "./arms";
import type { ExtractionScore } from "./extraction";

export interface QuestionArmResult {
  questionId: string;
  ability: Ability;
  isAbstention: boolean;
  arm: Arm;
  answer: string;
  verdict: Verdict | null;   // null ⇒ judge error
  judgeError?: string;
  extraction?: ExtractionScore; // present only for factual-subset questions
  tokensFed: number;
  latencyMs: number;
  /** Retrieval wall-clock, separate from reader latency (Harper arms only). */
  retrievalMs?: number;
  /** Retrieved memory ids in final rank order (Harper arms only) — closes the
   *  journal blind spot where a wrong answer can't be attributed to retrieval
   *  vs the reader without re-running the query. */
  rankedIds?: string[];
  truncated?: boolean;
}

export interface AbilityMetric { n: number; judged: number; correct: number; accuracy: number }

export interface ArmRunMetrics {
  arm: Arm;
  n: number;
  judged: number;
  judgeErrors: number;
  overallAccuracy: number;
  /** Accuracy over ANSWERABLE questions only (abstention excluded). This is the
   *  number the no-context contamination probe must read: an abstention
   *  question is trivially "correct" with no context (no memory ⇒ "I don't
   *  know" ⇒ correct abstention), so including it would mask contamination. */
  overallAccuracyAnswerable: number;
  answerableJudged: number;
  perAbility: Partial<Record<Ability, AbilityMetric>>;
  abstention: AbilityMetric;              // correct-abstention rate on _abs questions
  notAttemptedRateAnswerable: number;     // C-rate on answerable questions
  incorrectRateAnswerable: number;
  factual: { n: number; f1: number; containmentEM: number; strictEM: number };
  tokensPerQueryMean: number;
  tokensPerQueryP50: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  retrievalP50Ms: number | null;
  anyTruncated: boolean;
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
/**
 * Sample std (n-1). **null for n<2 — the spread was never measured** (#1376).
 *
 * The obvious sentinel here is `0`, and it is wrong: a single run has no
 * spread to report, but `0` is the value that reads as the STRONGEST possible
 * claim — "we ran it repeatedly and it agreed perfectly". An unknown must never
 * resolve to the most confident-looking number. `null` forces every consumer to
 * decide what to do about the absence instead of inheriting a fabricated zero,
 * and the type says so.
 */
export function std(xs: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
}
/** Nearest-rank percentile (p in [0,100]). */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))]!;
}

/** Aggregate one run's results for ONE arm. */
export function aggregateArmRun(arm: Arm, results: QuestionArmResult[]): ArmRunMetrics {
  const rs = results.filter((r) => r.arm === arm);
  const n = rs.length;
  const judged = rs.filter((r) => r.verdict !== null);
  const judgeErrors = n - judged.length;
  const correct = judged.filter((r) => r.verdict === "CORRECT").length;

  const perAbility: Partial<Record<Ability, AbilityMetric>> = {};
  const abilities = new Set(rs.map((r) => r.ability));
  for (const ab of abilities) {
    if (ab === "abstention") continue; // broken out separately
    const abRs = rs.filter((r) => r.ability === ab);
    const abJudged = abRs.filter((r) => r.verdict !== null);
    const abCorrect = abJudged.filter((r) => r.verdict === "CORRECT").length;
    perAbility[ab] = {
      n: abRs.length,
      judged: abJudged.length,
      correct: abCorrect,
      accuracy: abJudged.length ? abCorrect / abJudged.length : 0,
    };
  }

  const absRs = rs.filter((r) => r.isAbstention);
  const absJudged = absRs.filter((r) => r.verdict !== null);
  const absCorrect = absJudged.filter((r) => r.verdict === "CORRECT").length;
  const abstention: AbilityMetric = {
    n: absRs.length,
    judged: absJudged.length,
    correct: absCorrect,
    accuracy: absJudged.length ? absCorrect / absJudged.length : 0,
  };

  const answerable = rs.filter((r) => !r.isAbstention && r.verdict !== null);
  const notAttempted = answerable.filter((r) => r.verdict === "NOT_ATTEMPTED").length;
  const incorrect = answerable.filter((r) => r.verdict === "INCORRECT").length;
  const answerableCorrect = answerable.filter((r) => r.verdict === "CORRECT").length;

  const factualRs = rs.filter((r) => FACTUAL_ABILITIES.includes(r.ability) && r.extraction);
  const factual = {
    n: factualRs.length,
    f1: mean(factualRs.map((r) => r.extraction!.f1)),
    containmentEM: mean(factualRs.map((r) => r.extraction!.containmentEM)),
    strictEM: mean(factualRs.map((r) => r.extraction!.strictEM)),
  };

  const tokens = rs.map((r) => r.tokensFed);
  const latencies = rs.map((r) => r.latencyMs);
  const retr = rs.filter((r) => r.retrievalMs !== undefined).map((r) => r.retrievalMs!);

  return {
    arm,
    n,
    judged: judged.length,
    judgeErrors,
    overallAccuracy: judged.length ? correct / judged.length : 0,
    overallAccuracyAnswerable: answerable.length ? answerableCorrect / answerable.length : 0,
    answerableJudged: answerable.length,
    perAbility,
    abstention,
    notAttemptedRateAnswerable: answerable.length ? notAttempted / answerable.length : 0,
    incorrectRateAnswerable: answerable.length ? incorrect / answerable.length : 0,
    factual,
    tokensPerQueryMean: mean(tokens),
    tokensPerQueryP50: percentile(tokens, 50),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    retrievalP50Ms: retr.length ? percentile(retr, 50) : null,
    anyTruncated: rs.some((r) => r.truncated),
  };
}

/** `std: null` means the variance was NOT measured (fewer than 2 runs) — it does
 *  NOT mean the variance was zero. Consumers must render the two differently
 *  (#1376). `runs` carries the underlying values either way. */
export interface MeanStd { mean: number; std: number | null; runs: number[] }
function ms(runs: number[]): MeanStd { return { mean: mean(runs), std: std(runs), runs }; }

export interface ArmAggregate {
  arm: Arm;
  runs: number;
  /** False when this aggregate came from a single run: every `std` below is
   *  `null` because nothing was measured twice. Carried as its own boolean so a
   *  downstream consumer reading the artifact cannot mistake an absent spread
   *  for a measured one, without having to reason about null-vs-zero (#1376). */
  varianceMeasured: boolean;
  overallAccuracy: MeanStd;
  /** Answerable-only accuracy across runs — the contamination-probe number. */
  overallAccuracyAnswerable: MeanStd;
  perAbility: Partial<Record<Ability, MeanStd>>;
  abstentionAccuracy: MeanStd;
  notAttemptedRateAnswerable: MeanStd;
  factualF1: MeanStd;
  factualContainmentEM: MeanStd;
  tokensPerQueryMean: MeanStd;
  latencyP50Ms: MeanStd;
  latencyP95Ms: MeanStd;
  judgeErrorsTotal: number;
}

/** Aggregate an arm across ≥1 runs (mean±std). Per-ability std is reported too
 *  (Kern §7c). */
export function aggregateArmAcrossRuns(arm: Arm, perRun: ArmRunMetrics[]): ArmAggregate {
  const allAbilities = new Set<Ability>();
  for (const r of perRun) for (const k of Object.keys(r.perAbility)) allAbilities.add(k as Ability);
  const perAbility: Partial<Record<Ability, MeanStd>> = {};
  for (const ab of allAbilities) {
    perAbility[ab] = ms(perRun.map((r) => r.perAbility[ab]?.accuracy ?? 0));
  }
  return {
    arm,
    runs: perRun.length,
    varianceMeasured: perRun.length >= 2,
    overallAccuracy: ms(perRun.map((r) => r.overallAccuracy)),
    overallAccuracyAnswerable: ms(perRun.map((r) => r.overallAccuracyAnswerable)),
    perAbility,
    abstentionAccuracy: ms(perRun.map((r) => r.abstention.accuracy)),
    notAttemptedRateAnswerable: ms(perRun.map((r) => r.notAttemptedRateAnswerable)),
    factualF1: ms(perRun.map((r) => r.factual.f1)),
    factualContainmentEM: ms(perRun.map((r) => r.factual.containmentEM)),
    tokensPerQueryMean: ms(perRun.map((r) => r.tokensPerQueryMean)),
    latencyP50Ms: ms(perRun.map((r) => r.latencyP50Ms)),
    latencyP95Ms: ms(perRun.map((r) => r.latencyP95Ms)),
    judgeErrorsTotal: perRun.reduce((a, r) => a + r.judgeErrors, 0),
  };
}
