import { describe, test, expect } from "bun:test";
import { formatReport } from "../bench/longmemeval/report";
import { aggregateArmRun, aggregateArmAcrossRuns, type QuestionArmResult } from "../bench/longmemeval/metrics";
import type { Arm } from "../bench/longmemeval/arms";

/**
 * The report is where a measured number becomes a claim (flair#1376).
 *
 * At `runs: 1` the sample std is undefined — nothing was measured twice, so
 * there is no spread to report. The harness used to substitute `0` for that
 * absence and print `66.0% ± 0.0%`, which reads to any human as "we ran it
 * repeatedly and it agreed perfectly" when it actually means "we never looked".
 * An absence must not render as the strongest possible claim.
 *
 * These tests assert the rendering directly, because the rendering IS the
 * defect: the artifact already carried `runs: [0.66]` alongside, and nobody
 * reads the array.
 */

/** One question outcome, with the fields the metrics layer reads. */
function q(over: Partial<QuestionArmResult>): QuestionArmResult {
  return {
    questionId: "q", ability: "information-extraction", isAbstention: false, arm: "flair",
    answer: "", verdict: "CORRECT", tokensFed: 1234, latencyMs: 210, ...over,
  };
}

/**
 * An 11-question run. Every derived number is deliberately non-zero AND chosen
 * so that no legitimate value RENDERS as a string containing "0.0%" — which is
 * what makes the `not.toContain("0.0%")` assertion below mean what it says. (A
 * fixture accuracy of 70.0% would contain "0.0%" as a substring and the check
 * would fire on a correct render; every percentage here avoids a whole ten.)
 * In this fixture the only way "0.0%" can reach the output is a fabricated std.
 *
 *   overall            8/11 = 72.7%      answerable         6/8  = 75.0%
 *   information-extr.  3/4  = 75.0%      multi-session      3/4  = 75.0%
 *   abstention         2/3  = 66.7%      not-attempted      1/8  = 12.5%
 *   factual F1 0.750, containment-EM 0.750, tokens 1234, latency 210/640
 *
 * `flip` swaps one verdict so a second run differs and the std is genuinely
 * non-zero — the positive control.
 */
function runResults(flip: boolean): QuestionArmResult[] {
  const ex = (f1: number, cem: number) => ({ f1, containmentEM: cem, strictEM: 0 });
  return [
    q({ questionId: "e1", verdict: "CORRECT", extraction: ex(0.9, 1), latencyMs: 640 }),
    q({ questionId: "e2", verdict: "CORRECT", extraction: ex(0.8, 1) }),
    q({ questionId: "e3", verdict: "CORRECT", extraction: ex(0.7, 0) }),
    q({ questionId: "e4", verdict: "INCORRECT", extraction: ex(0.6, 1) }),
    q({ questionId: "m1", ability: "multi-session", verdict: "CORRECT" }),
    q({ questionId: "m2", ability: "multi-session", verdict: flip ? "INCORRECT" : "CORRECT" }),
    q({ questionId: "m3", ability: "multi-session", verdict: "CORRECT" }),
    q({ questionId: "m4", ability: "multi-session", verdict: "NOT_ATTEMPTED" }),
    q({ questionId: "a1_abs", ability: "abstention", isAbstention: true, verdict: "CORRECT" }),
    q({ questionId: "a2_abs", ability: "abstention", isAbstention: true, verdict: "CORRECT" }),
    q({ questionId: "a3_abs", ability: "abstention", isAbstention: true, verdict: "INCORRECT" }),
  ];
}

function render(nRuns: 1 | 2): string {
  const perRun = Array.from({ length: nRuns }, (_, i) => aggregateArmRun("flair", runResults(i === 1)));
  const aggregate = [aggregateArmAcrossRuns("flair", perRun)];
  return formatReport({
    aggregate, runs: nRuns, validationSlice: false, selectedArms: ["flair"] as Arm[],
  }).join("\n");
}

describe("longmemeval report — an unmeasured spread must not render as a measured zero (#1376)", () => {
  test("a SINGLE-run report prints no ± and no 0.0% anywhere", () => {
    const out = render(1);
    // Guard against a vacuous pass: a formatter returning "" would satisfy
    // both negatives below. The report has to actually be a report.
    expect(out).toContain("[flair]");
    expect(out).toContain("72.7%"); // the measured mean IS printed

    // The defect, stated as the two things a reader would misread.
    expect(out).not.toContain("±");
    expect(out).not.toContain("0.0%");
  });

  test("a SINGLE-run report says the variance was not measured, in the headline", () => {
    const out = render(1);
    const headline = out.split("\n").find((l) => l.includes("overall accuracy:"))!;
    expect(headline).toContain("single run");
    expect(headline).toContain("unmeasured");
    // Recoverable-from-a-field is not a mitigation: it has to be on the line
    // a human reads, next to the number it qualifies.
    expect(headline).toContain("72.7%");
  });

  test("POSITIVE CONTROL — a TWO-run report does print mean ± std", () => {
    // Without this, "no ±" could be satisfied by a formatter that never prints
    // a spread at all, and the fix would silently delete a real measurement.
    const out = render(2);
    expect(out).toContain("±");
    const headline = out.split("\n").find((l) => l.includes("overall accuracy:"))!;
    // runs of 8/11 and 7/11 → mean 68.2%, sample std (1/11)/√2 = 6.4%
    expect(headline).toContain("68.2% ± 6.4%");
    expect(headline).not.toContain("unmeasured");
  });

  test("the single-run and two-run reports differ in exactly this respect", () => {
    // The two renders come from the same fixture shape; if they were identical
    // the assertions above would be measuring nothing.
    expect(render(1)).not.toBe(render(2));
  });
});
