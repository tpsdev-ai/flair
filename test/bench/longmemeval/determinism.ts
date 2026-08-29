/**
 * determinism.ts — the READER-DETERMINISM PROBE (flair#1368).
 *
 * WHY THIS EXISTS. Under the `cloud` profile the reader is not bitwise-stable
 * at temperature 0 / seed 0: batched inference (MoE routing, mixed-precision
 * kernels) is not reproducible across batch composition. So a published cloud
 * accuracy is a STATISTICAL result, and the honest claim about it is "re-run
 * and compare within variance."
 *
 * That instruction is EMPTY unless we publish the variance to compare against.
 * Someone re-running this benchmark against the same cloud reader will get
 * different completion text than we did, and without a published determinism
 * measurement they cannot tell whether their divergence is normal or evidence
 * that we got something wrong. This probe is what makes the instruction
 * checkable: it records what OUR reader's nondeterminism measured, in the same
 * units a re-runner can measure their own.
 *
 * WHAT IT RECORDS, per probed question:
 *   samples               N — repeated calls with a BYTE-IDENTICAL prompt
 *   distinctCompletions   M — unique completion strings across the N calls
 *   commonPrefixLength    chars every completion shares before any two diverge
 *   verdictAgreementRate  fraction of the N calls the judge scored the same way
 *
 * FOUR PROPERTIES THAT ARE EASY TO GET WRONG, and how each is enforced here:
 *
 * 1. IDENTICAL READER CONFIGURATION. The probe issues `buildReaderRequest()`
 *    from eval.ts — the single definition of a reader call that the main run
 *    also issues — and calls `readerAnswer()` / `judgeOne()` themselves. It
 *    accepts NO reader parameters of its own: no model, no temperature, no
 *    seed, no num_ctx, no prompt template. There is therefore nothing for a
 *    later edit to change on one path and forget on the other. A probe that
 *    quietly measured a different configuration would be worse than no probe,
 *    because its numbers would look authoritative.
 *
 * 2. FIXED QUESTION SAMPLE. `PROBE_QUESTION_IDS` is a hardcoded constant, not a
 *    draw from the run's slice and not a random sample. A sample that moved per
 *    run would make probes incomparable ACROSS runs, destroying the single
 *    property the probe exists to provide. The ids are also written into the
 *    artifact, so a re-runner does not have to read this file to know what was
 *    probed. A probe id missing from the dataset is FATAL, never a silent skip.
 *
 * 3. UNHASHED PROVENANCE. The result lands in the artifact's provenance
 *    partition (artifact.ts PROVENANCE_KEYS), never in the hashed content. A
 *    determinism measurement legitimately differs run to run; if it fed
 *    `artifactHash`, every honest re-run would look like tampering. Asserted,
 *    not assumed — test/unit/longmemeval-artifact.test.ts.
 *
 * 4. THE JUDGE IS NOT SAMPLED. Every one of the N completions is scored. The
 *    judge is cheap relative to the reader, and scoring a subset would put a
 *    second source of variance inside the number that is supposed to isolate
 *    the reader's.
 *
 * WHAT THE PROBE'S CONTEXT IS, stated plainly because it is a real limitation.
 * The probe does not retrieve from a live Flair — it builds a retrieval-SHAPED
 * context deterministically from the question's own haystack (`probeContext`
 * below) and formats it through the harness's own pinned payload formatter. So
 * the probe's prompt is a pure function of (dataset, question id, pinned prompt
 * strings, pinned payload format, readerTopK), and a re-runner reconstructs it
 * BYTE-IDENTICALLY without needing our store, our index state or our run.
 * That reproducibility is the point: a probe whose own input could not be
 * reproduced would not support the comparison it exists for. The trade is that
 * the context is not the retrieval the headline arms actually saw — it is the
 * same SHAPE and comparable size, not the same content.
 */
import { READER, RETRIEVAL } from "./config";
import {
  formatRetrieved, READER_PAYLOAD_FORMAT, READER_PROMPT_VERSION, type Arm,
} from "./arms";
import { buildReaderRequest, readerAnswer, judgeOne } from "./eval";
import { abilityOf, entryToSessions, isAbstention, type LmeEntry } from "./dataset";
import type { Verdict } from "./judge";
import type { RetrievedItem } from "../../../packages/flair-bench/lib/index";

/**
 * The FIXED question sample. Hardcoded ids from LongMemEval_s, deliberately not
 * derived from `--n` / `--seed`: a probe drawn from the run's slice would move
 * whenever the slice moved, and two runs' probes would stop being comparable —
 * which is the one property the probe exists to provide.
 *
 * Two questions rather than one so a single unlucky question cannot be mistaken
 * for a property of the reader. Both are answerable (non-`_abs`) questions from
 * the published 500-question headline slice, so they are guaranteed present in
 * the pinned dataset.
 *
 * CHANGING THIS LIST breaks comparability with every probe already published.
 * If it must change, treat it as a new measurement: say so, and do not compare
 * the new numbers to the old ones.
 */
export const PROBE_QUESTION_IDS: readonly string[] = ["001be529", "00ca467f"];

/** The arm whose reader configuration is probed: the headline arm. Its num_ctx
 *  is the pinned READER.numCtx (only `full-context` overrides it). */
export const PROBE_ARM: Arm = "flair";

/**
 * N — repeated calls per probed question. 10 by default.
 *
 * `LME_DETERMINISM_SAMPLES` may raise or lower it, and whatever value ran is
 * recorded in the artifact next to every number it produced, so the denominator
 * travels with the measurement. Anything below 2 is FATAL rather than clamped:
 * one call cannot measure agreement between calls, and a probe reporting
 * "1 distinct completion" from a single sample would be a fabricated
 * determinism claim, which is precisely the failure this file exists to
 * prevent. A non-numeric value is fatal for the same reason.
 */
export const PROBE_SAMPLES: number = (() => {
  const raw = process.env.LME_DETERMINISM_SAMPLES;
  if (raw === undefined || raw === "") return 10;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 2) {
    throw new Error(
      `LME_DETERMINISM_SAMPLES must be an integer >= 2 (got "${raw}"). ` +
      `A single sample cannot measure agreement between samples — it would report ` +
      `"1 distinct completion" for a reader that is not deterministic at all.`,
    );
  }
  return n;
})();

export const DETERMINISM_SCHEMA = "longmemeval-s.reader-determinism/1";

export interface QuestionDeterminism {
  questionId: string;
  ability: string;
  /** Assembled reader prompt size. Recorded because nondeterminism is
   *  prompt-size dependent — a 32-token probe is not evidence about a
   *  4000-token one, and a reader of this number must be able to see which
   *  they are looking at. */
  promptChars: number;
  /** Prompt tokens as the MODEL reported them, per call. Constant across calls
   *  for a byte-identical prompt; a varying value would mean the prompt itself
   *  moved and the probe measured the wrong thing. */
  promptTokens: number[];
  /** N. Repeated here per question so no number in this record is separated
   *  from its denominator. */
  samples: number;
  /** M — unique completion strings across the N calls. 1 ⇒ bitwise-stable. */
  distinctCompletions: number;
  /** Characters every completion shares before the first divergence. Equals the
   *  completion length when M === 1. */
  commonPrefixLength: number;
  /** (count of the most common verdict) / N. 1 ⇒ every call graded the same,
   *  which is the property the headline accuracy actually rests on. An
   *  unparseable verdict is its own bucket (`JUDGE_ERROR`) — never folded into
   *  a real verdict, and never a silent pass. */
  verdictAgreementRate: number;
  verdictCounts: Record<string, number>;
  judgeErrors: number;
  /** Completion LENGTHS, not the completions. The artifact must not carry N
   *  copies of a reader answer. */
  completionChars: number[];
}

export interface ReaderDeterminism {
  schema: string;
  measuredAt: string;
  ollamaHost: string;
  /** The reader pin ACTUALLY USED, read off the resolved request rather than
   *  restated — so this record cannot disagree with what went on the wire. */
  reader: Record<string, unknown>;
  promptConstruction: {
    arm: Arm;
    numCtx: number;
    readerPromptVersion: string;
    readerPayloadFormat: string;
    readerTopK: number;
    contextSource: string;
  };
  samples: number;
  questionIds: string[];
  perQuestion: QuestionDeterminism[];
  /** Roll-up across the fixed sample. Each field names its own aggregation, so
   *  a reader never has to guess whether a number is a mean, a max or a min. */
  summary: {
    maxDistinctCompletions: number;
    minCommonPrefixLength: number;
    minVerdictAgreementRate: number;
  } | null;
  /** Null on success. A probe that could not run records WHY here and is still
   *  emitted — an absent probe and a failed probe must never look the same. */
  error: string | null;
}

/** Characters shared by every string before the first position where any two
 *  differ. `[]` → 0; a single string → its own length. */
export function commonPrefixLength(strings: string[]): number {
  if (strings.length === 0) return 0;
  const limit = Math.min(...strings.map((s) => s.length));
  for (let i = 0; i < limit; i++) {
    const c = strings[0]![i];
    for (const s of strings) if (s[i] !== c) return i;
  }
  return limit;
}

/** The pure summary of one question's N samples. Separated from the call loop
 *  so it can be asserted directly, but note that testing THIS alone would not
 *  catch a call loop that issued one call and copied the result N times — which
 *  is why the probe is also exercised end to end against a known-deterministic
 *  and a known-nondeterministic reader. */
export function summariseSamples(
  completions: string[], verdicts: (Verdict | null)[],
): Pick<QuestionDeterminism,
  "distinctCompletions" | "commonPrefixLength" | "verdictAgreementRate" | "verdictCounts" | "judgeErrors"> {
  const verdictCounts: Record<string, number> = {};
  for (const v of verdicts) {
    const key = v ?? "JUDGE_ERROR";
    verdictCounts[key] = (verdictCounts[key] ?? 0) + 1;
  }
  const modal = Object.values(verdictCounts).reduce((a, b) => Math.max(a, b), 0);
  return {
    distinctCompletions: new Set(completions).size,
    commonPrefixLength: commonPrefixLength(completions),
    verdictAgreementRate: verdicts.length ? modal / verdicts.length : 0,
    verdictCounts,
    judgeErrors: verdictCounts.JUDGE_ERROR ?? 0,
  };
}

/**
 * The probe's reader context: the question's own first `RETRIEVAL.readerTopK`
 * ingested events, run through the harness's OWN pinned payload formatter
 * (`formatRetrieved`, i.e. READER_PAYLOAD_FORMAT).
 *
 * A pure function of the dataset entry and the pinned config — no store, no
 * index, no retrieval. That is what lets a re-runner rebuild a byte-identical
 * probe prompt and compare their measurement to ours. The ids/dates/content all
 * come from `entryToSessions`, the same mapping the real ingest uses, so the
 * lines are shaped exactly like retrieved memories.
 */
export function probeContext(entry: LmeEntry): string {
  const items: RetrievedItem[] = entryToSessions(entry)
    .flatMap((s) => s.events)
    .slice(0, RETRIEVAL.readerTopK)
    .map((ev, rank) => ({
      id: ev.id,
      score: 1 - rank / 1000, // rank-ordered; never read by the formatter
      content: ev.content,
      createdAt: typeof ev.createdAt === "string" ? ev.createdAt : undefined,
    }));
  return formatRetrieved(items).text;
}

/** The shape returned when the probe could not run. Defined here so a failed
 *  probe and a successful one are the same record with `error` set, rather than
 *  two shapes a consumer has to know about. */
export function failedProbe(host: string, err: unknown): ReaderDeterminism {
  return {
    ...emptyProbe(host),
    error: err instanceof Error ? err.message : String(err),
  };
}

function emptyProbe(host: string): ReaderDeterminism {
  // Derived from the SAME builder the real calls use, so even the failure path
  // cannot record a reader configuration the run would not have used.
  const reference = buildReaderRequest("", "", "", PROBE_ARM);
  return {
    schema: DETERMINISM_SCHEMA,
    measuredAt: new Date().toISOString(),
    ollamaHost: host,
    reader: { ...(reference.spec as unknown as Record<string, unknown>) },
    promptConstruction: {
      arm: PROBE_ARM,
      numCtx: reference.opts.numCtxOverride ?? reference.spec.numCtx,
      readerPromptVersion: READER_PROMPT_VERSION,
      readerPayloadFormat: READER_PAYLOAD_FORMAT,
      readerTopK: RETRIEVAL.readerTopK,
      contextSource:
        "deterministic: first readerTopK haystack events of the probed question, " +
        "formatted by formatRetrieved at the pinned payload format",
    },
    samples: PROBE_SAMPLES,
    questionIds: [...PROBE_QUESTION_IDS],
    perQuestion: [],
    summary: null,
    error: null,
  };
}

/**
 * Measure the reader's nondeterminism on the FIXED question sample.
 *
 * `entries` is the whole loaded dataset (not the run's slice) — the probe's
 * questions are fixed independently of what the run happens to be measuring.
 * A probe id absent from `entries` throws: a silently-skipped question would
 * leave a probe that looks complete but measured less than it claims.
 */
export async function probeReaderDeterminism(
  host: string, entries: LmeEntry[], opts: { log?: (s: string) => void } = {},
): Promise<ReaderDeterminism> {
  const log = opts.log ?? (() => {});
  const out = emptyProbe(host);
  const byId = new Map(entries.map((e) => [e.question_id, e]));

  log(
    `[determinism] probing reader ${out.reader.model} — ${PROBE_QUESTION_IDS.length} fixed question(s) ` +
    `x ${PROBE_SAMPLES} identical calls (+ ${PROBE_SAMPLES} judge calls each)`,
  );

  for (const questionId of PROBE_QUESTION_IDS) {
    const entry = byId.get(questionId);
    if (!entry) {
      throw new Error(
        `determinism probe: fixed question "${questionId}" is not in the loaded dataset ` +
        `(${entries.length} entries). The probe sample is pinned in determinism.ts and must ` +
        `exist in the pinned dataset — skipping it would publish a probe that measured less ` +
        `than it says it did.`,
      );
    }
    const context = probeContext(entry);
    const request = buildReaderRequest(entry.question, entry.question_date, context, PROBE_ARM);
    const completions: string[] = [];
    const promptTokens: number[] = [];
    const verdicts: (Verdict | null)[] = [];
    for (let i = 0; i < PROBE_SAMPLES; i++) {
      // The SAME call the run makes — same builder, same client, same pin.
      const r = await readerAnswer(host, entry.question, entry.question_date, context, PROBE_ARM);
      completions.push(r.answer);
      promptTokens.push(r.tokensFed);
      // Every completion is judged; the judge is never sampled.
      const j = await judgeOne(
        host, entry.question_type, entry.question, entry.answer, r.answer, isAbstention(entry),
      );
      verdicts.push(j.verdict);
    }
    const summary = summariseSamples(completions, verdicts);
    out.perQuestion.push({
      questionId,
      ability: abilityOf(entry),
      promptChars: request.prompt.length,
      promptTokens,
      samples: PROBE_SAMPLES,
      completionChars: completions.map((c) => c.length),
      ...summary,
    });
    log(
      `[determinism] ${questionId}: ${summary.distinctCompletions}/${PROBE_SAMPLES} distinct completions, ` +
      `common prefix ${summary.commonPrefixLength} chars, verdict agreement ` +
      `${(summary.verdictAgreementRate * 100).toFixed(0)}%`,
    );
  }

  out.summary = {
    maxDistinctCompletions: Math.max(...out.perQuestion.map((q) => q.distinctCompletions)),
    minCommonPrefixLength: Math.min(...out.perQuestion.map((q) => q.commonPrefixLength)),
    minVerdictAgreementRate: Math.min(...out.perQuestion.map((q) => q.verdictAgreementRate)),
  };
  return out;
}

/** Console report. Lives here so run.ts holds the orchestration and this file
 *  holds everything that knows the probe's units. */
export function printReaderDeterminism(d: ReaderDeterminism): void {
  console.log(`\n── reader determinism (UNHASHED PROVENANCE — this is the variance to compare against) ──`);
  if (d.error) {
    console.log(`  PROBE FAILED: ${d.error}`);
    console.log(`  Recorded in the artifact as an error. An absent probe and a failed probe are not the same thing.`);
    return;
  }
  console.log(`  reader ${d.reader.model} @ temp ${d.reader.temperature} seed ${d.reader.seed} num_ctx ${d.promptConstruction.numCtx}`);
  for (const q of d.perQuestion) {
    console.log(
      `  ${q.questionId.padEnd(16)} ${q.distinctCompletions}/${q.samples} distinct  ` +
      `common prefix ${String(q.commonPrefixLength).padStart(5)} chars  ` +
      `verdict agreement ${(q.verdictAgreementRate * 100).toFixed(0)}%  ` +
      `(prompt ${q.promptChars} chars / ${q.promptTokens[0] ?? "?"} tokens)`,
    );
  }
  if (d.summary) {
    console.log(
      `  worst case across the fixed sample: ${d.summary.maxDistinctCompletions} distinct completions, ` +
      `${d.summary.minCommonPrefixLength}-char common prefix, ` +
      `${(d.summary.minVerdictAgreementRate * 100).toFixed(0)}% verdict agreement`,
    );
  }
  console.log(
    `  A re-runner should measure the same quantities on the same fixed questions and compare.\n` +
    `  Divergence in COMPLETION TEXT at this rate is expected; divergence in VERDICT agreement is the\n` +
    `  signal that matters, because the headline accuracy is a function of verdicts, not of text.`,
  );
}
