/**
 * report.ts — the human-facing console report for a bench run, as a PURE
 * function over the aggregate.
 *
 * Extracted verbatim from run.ts so the report can be TESTED. run.ts calls the
 * harness and then prints; the printing itself is where a measured number
 * becomes a claim a reader acts on, and that deserves coverage of its own.
 */
import type { ArmAggregate, MeanStd } from "./metrics";
import type { Arm } from "./arms";

export const fmt = (x: number, d = 3) => x.toFixed(d);
export const pct = (x: number) => (x * 100).toFixed(1) + "%";

/**
 * Render `mean ± std` — or, when the spread was never measured, SAY SO rather
 * than printing an interval that does not exist (#1376).
 *
 * `std === null` means fewer than two runs. The old code substituted `0` and
 * printed `66.0% ± 0.0%`, which any reader takes as "we ran it repeatedly and
 * it agreed perfectly" — the strongest possible claim, standing in for no claim
 * at all. The absence has to be visible right next to the number, not left to
 * be recovered from a field nobody inspects.
 */
function spread(m: MeanStd, f: (x: number) => string, style: "headline" | "row"): string {
  if (m.std !== null) return `${f(m.mean)} ± ${f(m.std)}`;
  if (style === "row") return `${f(m.mean)} (unmeasured)`;
  const n = m.runs.length === 1 ? "single run" : `${m.runs.length} runs`;
  return `${f(m.mean)} (${n} — variance unmeasured)`;
}

export interface ReportInput {
  aggregate: ArmAggregate[];
  runs: number;
  validationSlice: boolean;
  selectedArms: readonly Arm[];
}

/** Render the results report as lines. Pure: no console, no I/O. */
export function formatReport({ aggregate, runs, validationSlice, selectedArms }: ReportInput): string[] {
  const out: string[] = [];
  // Derived from the aggregate, not from the requested run count: the banner
  // describes what was actually measured.
  const measured = aggregate.length > 0 ? aggregate.every((a) => a.varianceMeasured) : runs >= 2;
  const basis = measured ? ", mean±std" : " — variance NOT measured (needs ≥2 runs)";
  out.push(`\n${"═".repeat(64)}\n  RESULTS (${validationSlice ? "VALIDATION SLICE — NOT PUBLISHABLE" : "run"}) — ${runs} run(s)${basis}\n${"═".repeat(64)}`);
  for (const a of aggregate) {
    out.push(`\n[${a.arm}]  overall accuracy: ${spread(a.overallAccuracy, pct, "headline")}   (runs: ${a.overallAccuracy.runs.map((x) => pct(x)).join(", ")})`);
    out.push(`    ${"overall (answerable only)".padEnd(28)} ${spread(a.overallAccuracyAnswerable, pct, "row")}`);
    for (const [ab, msd] of Object.entries(a.perAbility)) {
      out.push(`    ${ab.padEnd(28)} ${spread(msd!, pct, "row")}`);
    }
    out.push(`    ${"abstention (broken out)".padEnd(28)} ${spread(a.abstentionAccuracy, pct, "row")}`);
    out.push(`    ${"not-attempted (answerable)".padEnd(28)} ${pct(a.notAttemptedRateAnswerable.mean)}`);
    out.push(`    ${"factual F1 (cross-check)".padEnd(28)} ${fmt(a.factualF1.mean)}   containment-EM ${fmt(a.factualContainmentEM.mean)}`);
    out.push(`    ${"tokens/query (mean)".padEnd(28)} ${a.tokensPerQueryMean.mean.toFixed(0)}`);
    out.push(`    ${"latency p50 / p95 (ms)".padEnd(28)} ${a.latencyP50Ms.mean.toFixed(0)} / ${a.latencyP95Ms.mean.toFixed(0)}`);
    if (a.judgeErrorsTotal > 0) out.push(`    !! judge errors: ${a.judgeErrorsTotal} (unparseable verdicts — NOT counted as pass)`);
  }
  // Contamination / validity reads — each only when its arm(s) ran.
  const nc = aggregate.find((a) => a.arm === "no-context");
  const fl = aggregate.find((a) => a.arm === "flair");
  const fc = aggregate.find((a) => a.arm === "full-context");
  out.push(`\n── contamination / validity reads (ANSWERABLE questions only) ──`);
  if (nc) {
    out.push(`  no-context accuracy = ${pct(nc.overallAccuracyAnswerable.mean)}  (HIGH ⇒ reader prior knowledge / contamination — number suspect)`);
    out.push(`    (measured on answerable questions — an abstention question is trivially correct with no context, so it is excluded here)`);
  }
  if (fc && fl) {
    out.push(`  full-context − flair = ${pct(fc.overallAccuracyAnswerable.mean - fl.overallAccuracyAnswerable.mean)}  (≈0 ⇒ measuring long-context not memory; large ⇒ retrieval losing info)`);
  } else {
    out.push(`  full-context − flair: NOT AVAILABLE (full-context arm not run — LME_ARMS=${selectedArms.join(",")})`);
  }
  return out;
}
