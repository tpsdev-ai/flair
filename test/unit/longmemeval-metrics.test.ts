import { describe, test, expect } from "bun:test";
import {
  aggregateArmRun, aggregateArmAcrossRuns, mean, std, percentile, type QuestionArmResult,
} from "../bench/longmemeval/metrics";
import type { Verdict } from "../bench/longmemeval/judge";
import type { Ability } from "../bench/longmemeval/dataset";

function r(over: Partial<QuestionArmResult>): QuestionArmResult {
  return {
    questionId: "q", ability: "information-extraction", isAbstention: false, arm: "flair",
    answer: "", verdict: "CORRECT", tokensFed: 100, latencyMs: 10, ...over,
  };
}

describe("stats helpers", () => {
  test("mean / sample-std / percentile", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(std([2, 2, 2])).toBe(0);
    expect(std([1])).toBe(0);            // n<2 → 0, never NaN
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([], 95)).toBe(0);
  });
});

describe("aggregateArmRun — accuracy + abstention breakout", () => {
  const results: QuestionArmResult[] = [
    r({ questionId: "q1", verdict: "CORRECT", ability: "information-extraction" }),
    r({ questionId: "q2", verdict: "INCORRECT", ability: "information-extraction" }),
    r({ questionId: "q3", verdict: "NOT_ATTEMPTED", ability: "multi-session" }),
    r({ questionId: "q4", verdict: "CORRECT", ability: "multi-session" }),
    // abstention questions (broken out separately)
    r({ questionId: "q5_abs", verdict: "CORRECT", isAbstention: true, ability: "abstention" }),
    r({ questionId: "q6_abs", verdict: "INCORRECT", isAbstention: true, ability: "abstention" }),
  ];

  test("overall accuracy = CORRECT / judged (NOT_ATTEMPTED counts as not-correct)", () => {
    const m = aggregateArmRun("flair", results);
    // 3 CORRECT of 6 judged
    expect(m.overallAccuracy).toBeCloseTo(3 / 6, 10);
    expect(m.judged).toBe(6);
    expect(m.judgeErrors).toBe(0);
  });

  test("answerable-only accuracy EXCLUDES abstention (the contamination-probe number)", () => {
    // An abstention question is trivially correct with no context — including it
    // would mask contamination. overallAccuracyAnswerable must ignore it.
    const m = aggregateArmRun("flair", results);
    // answerable q1..q4: 2 CORRECT of 4
    expect(m.overallAccuracyAnswerable).toBeCloseTo(2 / 4, 10);
    expect(m.answerableJudged).toBe(4);
    // overall (incl. abstention) is different: 3 of 6
    expect(m.overallAccuracy).toBeCloseTo(3 / 6, 10);
  });

  test("abstention is broken out and NOT in perAbility", () => {
    const m = aggregateArmRun("flair", results);
    expect(m.abstention.n).toBe(2);
    expect(m.abstention.accuracy).toBeCloseTo(1 / 2, 10);
    expect((m.perAbility as any).abstention).toBeUndefined();
  });

  test("NOT_ATTEMPTED on answerable is reported separately, not as correct", () => {
    const m = aggregateArmRun("flair", results);
    // answerable = q1..q4; one NOT_ATTEMPTED
    expect(m.notAttemptedRateAnswerable).toBeCloseTo(1 / 4, 10);
    expect(m.incorrectRateAnswerable).toBeCloseTo(1 / 4, 10);
  });

  test("a judge error is excluded from the accuracy denominator but COUNTED", () => {
    const withErr = [...results, r({ questionId: "q7", verdict: null, judgeError: "unparseable" })];
    const m = aggregateArmRun("flair", withErr);
    expect(m.judgeErrors).toBe(1);
    expect(m.judged).toBe(6);                       // the error is not judged
    expect(m.overallAccuracy).toBeCloseTo(3 / 6, 10); // denominator excludes it
  });

  test("factual F1 only over factual-subset questions that carry extraction", () => {
    const withF1 = [
      r({ questionId: "f1", ability: "information-extraction", extraction: { f1: 1, containmentEM: 1, strictEM: 1 } }),
      r({ questionId: "f2", ability: "temporal-reasoning", extraction: { f1: 0.5, containmentEM: 0, strictEM: 0 } }),
      // preference has no extraction — excluded from the cross-check
      r({ questionId: "p1", ability: "single-session-preference", verdict: "CORRECT" }),
    ];
    const m = aggregateArmRun("flair", withF1);
    expect(m.factual.n).toBe(2);
    expect(m.factual.f1).toBeCloseTo(0.75, 10);
  });
});

describe("aggregateArmAcrossRuns — mean±std (pass^k)", () => {
  test("aggregates overall accuracy across runs with a spread", () => {
    const run1 = aggregateArmRun("flair", [r({ verdict: "CORRECT" }), r({ verdict: "INCORRECT" })]);
    const run2 = aggregateArmRun("flair", [r({ verdict: "CORRECT" }), r({ verdict: "CORRECT" })]);
    const agg = aggregateArmAcrossRuns("flair", [run1, run2]);
    expect(agg.runs).toBe(2);
    expect(agg.overallAccuracy.mean).toBeCloseTo((0.5 + 1) / 2, 10);
    expect(agg.overallAccuracy.std).toBeGreaterThan(0);
    expect(agg.overallAccuracy.runs).toEqual([0.5, 1]);
  });
});
