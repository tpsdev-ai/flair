import { describe, test, expect, mock, beforeEach } from "bun:test";
import { READER, JUDGE, RETRIEVAL } from "../bench/longmemeval/config";
import type { LmeEntry } from "../bench/longmemeval/dataset";

/**
 * Tests for the reader-determinism probe (flair#1368).
 *
 * THE FAILURE SHAPE THIS FILE DEFENDS AGAINST. A probe that reports "fully
 * deterministic" for everything is indistinguishable from a probe that is not
 * running at all — and a happy-path test cannot see the difference, because
 * "1 distinct completion" is exactly what a working probe reports on a
 * deterministic reader. So every behavioural test here runs the probe against
 * BOTH a known-deterministic and a known-nondeterministic reader and asserts the
 * outputs DIFFER in the expected direction. A probe stuck on either answer fails
 * one of the two.
 *
 * HOW THE READER IS FAKED. `mock.module` replaces the ollama transport for every
 * importer in this file — the probe AND the main run's `readerAnswer` go through
 * the same fake. That is deliberate: it lets the config-drift assertion compare
 * two ACTUAL wire requests rather than two computations of the same helper, and
 * it means the production code carries no test seam that could itself drift.
 *
 * NO PAID CALLS. Nothing here touches a network. The reader is scripted.
 */

// ── The fake transport ──────────────────────────────────────────────────────
interface WireCall { host: string; spec: any; prompt: string; opts: any }
const wire: { reader: WireCall[]; judge: WireCall[] } = { reader: [], judge: [] };

/** What the scripted reader returns on its i-th call (per question). */
let readerScript: (callIndex: number, prompt: string) => string = () => "constant answer";
/** What the scripted judge returns for a given reader completion. */
let judgeScript: (completion: string) => string = () => "A";

mock.module("../bench/longmemeval/ollama", () => ({
  OllamaError: class OllamaError extends Error {},
  assertModelPinned: async () => ({ actualDigest: "sha256:fake" }),
  pingOllama: async () => [] as string[],
  generate: async (host: string, spec: any, prompt: string, opts: any = {}) => {
    const isJudge = spec.model === JUDGE.model;
    const bucket = isJudge ? wire.judge : wire.reader;
    bucket.push({ host, spec, prompt, opts });
    const response = isJudge
      ? judgeScript(lastCompletion)
      : (lastCompletion = readerScript(bucket.length - 1, prompt));
    return { response, promptTokens: Math.ceil(prompt.length / 4), evalTokens: 8, latencyMs: 1, doneReason: "stop" };
  },
}));
let lastCompletion = "";

const determinism = await import("../bench/longmemeval/determinism");
const { buildReaderRequest, readerAnswer } = await import("../bench/longmemeval/eval");
const {
  probeReaderDeterminism, probeContext, commonPrefixLength, summariseSamples,
  PROBE_QUESTION_IDS, PROBE_ARM, PROBE_SAMPLES, failedProbe,
} = determinism;

// ── Fixtures ────────────────────────────────────────────────────────────────
function entry(id: string, over: Partial<LmeEntry> = {}): LmeEntry {
  return {
    question_id: id,
    question_type: "single-session-user",
    question: `What degree did I graduate with? (${id})`,
    answer: "Business Administration",
    question_date: "2023/06/01 (Thu) 09:00",
    haystack_dates: ["2023/05/20 (Sat) 02:16", "2023/05/21 (Sun) 10:00"],
    haystack_session_ids: [`${id}-a`, `${id}-b`],
    haystack_sessions: [
      Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `session A turn ${i}` })),
      Array.from({ length: 14 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `session B turn ${i}` })),
    ],
    answer_session_ids: [`${id}-a`],
    ...over,
  };
}
/** The dataset the probe is handed: the fixed probe questions plus decoys, so a
 *  probe that took "whatever it was given" would visibly pick up the decoys. */
const dataset = (): LmeEntry[] => [
  entry("decoy-before"),
  ...PROBE_QUESTION_IDS.map((id) => entry(id)),
  entry("decoy-after"),
];

const DETERMINISTIC = "The answer is Business Administration.";
const NONDET = [
  "Two is unusual because it is the only even prime number.",
  "Two is unusual since it is the sole even prime.",
  "Two is unusual — it is the only even prime there is.",
];
// Shared by all three (trailing space included), then they diverge — mirroring
// the real measured shape: a common prefix followed by divergent continuations.
const NONDET_PREFIX = "Two is unusual ";

function scriptDeterministicReader(): void {
  readerScript = () => DETERMINISTIC;
  judgeScript = () => "A";
}
function scriptNondeterministicReader(): void {
  // Cycles through three completions; the judge disagrees on one of them, so
  // verdictAgreementRate is strictly between 0 and 1 rather than pinned at 1.
  readerScript = (i) => NONDET[i % NONDET.length]!;
  judgeScript = (c) => (c === NONDET[2] ? "B" : "A");
}

beforeEach(() => {
  wire.reader = [];
  wire.judge = [];
  lastCompletion = "";
  scriptDeterministicReader();
});

// ═══════════════════════════════════════════════════════════════════════════
// GATE: the probe must distinguish a deterministic reader from a
// nondeterministic one. Both directions, or the probe is unfalsifiable.
// ═══════════════════════════════════════════════════════════════════════════
describe("probe — known-deterministic vs known-nondeterministic reader", () => {
  test("a known-DETERMINISTIC reader reports M=1 and full agreement", async () => {
    scriptDeterministicReader();
    const d = await probeReaderDeterminism("http://fake", dataset());
    expect(d.error).toBeNull();
    expect(d.perQuestion).toHaveLength(PROBE_QUESTION_IDS.length);
    for (const q of d.perQuestion) {
      expect(q.samples).toBe(PROBE_SAMPLES);
      expect(q.distinctCompletions).toBe(1);
      // M===1 ⇒ the common prefix is the whole completion, not 0.
      expect(q.commonPrefixLength).toBe(DETERMINISTIC.length);
      expect(q.verdictAgreementRate).toBe(1);
      expect(q.verdictCounts).toEqual({ CORRECT: PROBE_SAMPLES });
      expect(q.judgeErrors).toBe(0);
    }
    expect(d.summary).toEqual({
      maxDistinctCompletions: 1,
      minCommonPrefixLength: DETERMINISTIC.length,
      minVerdictAgreementRate: 1,
    });
  });

  test("a known-NONDETERMINISTIC reader reports M>1, a short prefix and <100% agreement", async () => {
    scriptNondeterministicReader();
    const d = await probeReaderDeterminism("http://fake", dataset());
    expect(d.error).toBeNull();
    for (const q of d.perQuestion) {
      expect(q.distinctCompletions).toBe(3);
      expect(q.commonPrefixLength).toBe(NONDET_PREFIX.length);
      // 10 samples cycling 3 completions ⇒ NONDET[2] appears 3×, judged B.
      expect(q.verdictAgreementRate).toBeCloseTo(0.7, 10);
      expect(q.verdictCounts).toEqual({ CORRECT: 7, INCORRECT: 3 });
    }
    expect(d.summary).toEqual({
      maxDistinctCompletions: 3,
      minCommonPrefixLength: NONDET_PREFIX.length,
      minVerdictAgreementRate: 0.7,
    });
  });

  test("the SAME probe code produces different readings for the two readers", async () => {
    // The decisive assertion. A probe hard-wired to "deterministic" passes the
    // first test above; a probe hard-wired to "nondeterministic" passes the
    // second; neither passes this one.
    scriptDeterministicReader();
    const det = await probeReaderDeterminism("http://fake", dataset());
    wire.reader = []; wire.judge = [];
    scriptNondeterministicReader();
    const nondet = await probeReaderDeterminism("http://fake", dataset());
    expect(det.summary!.maxDistinctCompletions).toBeLessThan(nondet.summary!.maxDistinctCompletions);
    expect(det.summary!.minVerdictAgreementRate).toBeGreaterThan(nondet.summary!.minVerdictAgreementRate);
  });

  test("the probe really issues N reader calls per question and judges every one", async () => {
    // Catches the specific cheat a summary-only test cannot see: a call loop
    // that generates ONCE and copies the result N times would report perfect
    // determinism for any reader at all.
    scriptNondeterministicReader();
    await probeReaderDeterminism("http://fake", dataset());
    const expected = PROBE_SAMPLES * PROBE_QUESTION_IDS.length;
    expect(wire.reader).toHaveLength(expected);
    expect(wire.judge).toHaveLength(expected); // the judge is never sampled
    // Every judge prompt must carry the completion of the reader call before it,
    // so the N verdicts describe the N completions rather than one of them.
    // (`readerScript` is indexed by the GLOBAL reader-call counter, so call i
    // returns NONDET[i % 3] regardless of which question it belongs to.)
    for (let i = 0; i < expected; i++) {
      expect(wire.judge[i]!.prompt).toContain(NONDET[i % NONDET.length]!);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GATE: config drift. The probe's resolved reader config must equal the main
// run's — asserted on the ACTUAL wire requests, not on two calls to one helper.
// ═══════════════════════════════════════════════════════════════════════════
describe("probe — config-drift guard", () => {
  test("the probe's wire request is byte-identical to the main run's for the same inputs", async () => {
    const e = entry(PROBE_QUESTION_IDS[0]!);
    const context = probeContext(e);

    await probeReaderDeterminism("http://fake", dataset());
    const fromProbe = wire.reader[0]!;

    wire.reader = [];
    // readerAnswer() is the function evalOne() calls for every (question, arm)
    // in the real run. If a future edit adds an override at THAT call site and
    // not to the shared builder, this comparison is what fires.
    await readerAnswer("http://fake", e.question, e.question_date, context, PROBE_ARM);
    const fromRun = wire.reader[0]!;

    expect(fromProbe.spec).toBe(fromRun.spec);       // the same pinned object
    expect(fromProbe.prompt).toBe(fromRun.prompt);   // the same assembled prompt
    expect(fromProbe.opts).toEqual(fromRun.opts);    // the same num_ctx handling
  });

  test("both paths issue exactly what buildReaderRequest resolves — one builder, no second assembly", async () => {
    const e = entry(PROBE_QUESTION_IDS[0]!);
    const context = probeContext(e);
    const expected = buildReaderRequest(e.question, e.question_date, context, PROBE_ARM);

    await probeReaderDeterminism("http://fake", dataset());
    expect(wire.reader[0]!.prompt).toBe(expected.prompt);
    expect(wire.reader[0]!.spec).toBe(expected.spec);
    expect(wire.reader[0]!.opts).toEqual(expected.opts);
  });

  test("the pinned sampling parameters actually reach the wire", async () => {
    // Named individually because these are the parameters whose silent drift
    // would make the probe measure a different system while still looking
    // authoritative: model pin, temperature, seed, num_ctx.
    await probeReaderDeterminism("http://fake", dataset());
    for (const call of wire.reader) {
      expect(call.spec.model).toBe(READER.model);
      expect(call.spec.manifestDigest).toBe(READER.manifestDigest);
      expect(call.spec.temperature).toBe(READER.temperature);
      expect(call.spec.seed).toBe(READER.seed);
      expect(call.spec.numPredict).toBe(READER.numPredict);
      // `flair` does not override num_ctx, so the pinned reader window is used.
      expect(call.opts.numCtxOverride).toBeUndefined();
    }
  });

  test("the config RECORDED in the artifact is the config that was sent", async () => {
    // Guards the other half: a hand-written literal in the record would look
    // right and describe a run that did not happen.
    const d = await probeReaderDeterminism("http://fake", dataset());
    const sent = wire.reader[0]!;
    expect(d.reader).toEqual({ ...(sent.spec as Record<string, unknown>) });
    expect(d.promptConstruction.numCtx).toBe(sent.opts.numCtxOverride ?? sent.spec.numCtx);
    expect(d.promptConstruction.numCtx).toBe(READER.numCtx);
    expect(d.promptConstruction.arm).toBe(PROBE_ARM);
    expect(d.promptConstruction.readerTopK).toBe(RETRIEVAL.readerTopK);
    expect(d.samples).toBe(PROBE_SAMPLES);
    // Each per-question record carries its own denominator.
    for (const q of d.perQuestion) expect(q.samples).toBe(d.samples);
  });

  test("the failure record reports the same reader config as a successful one", async () => {
    // A failed probe must not become a place where an unchecked config appears.
    const ok = await probeReaderDeterminism("http://fake", dataset());
    const bad = failedProbe("http://fake", new Error("connect ECONNREFUSED"));
    expect(bad.reader).toEqual(ok.reader);
    expect(bad.promptConstruction).toEqual(ok.promptConstruction);
    expect(bad.error).toBe("connect ECONNREFUSED");
    expect(bad.summary).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GATE: the question sample is FIXED and recorded — never sampled per run.
// ═══════════════════════════════════════════════════════════════════════════
describe("probe — fixed, recorded question sample", () => {
  test("the probed ids are the pinned constant and are recorded in the result", async () => {
    const d = await probeReaderDeterminism("http://fake", dataset());
    expect(d.questionIds).toEqual([...PROBE_QUESTION_IDS]);
    expect(d.perQuestion.map((q) => q.questionId)).toEqual([...PROBE_QUESTION_IDS]);
    expect(PROBE_QUESTION_IDS.length).toBeGreaterThanOrEqual(2);
  });

  test("the sample does not follow the dataset it is handed", async () => {
    // Decoys are present in `dataset()` and must never be probed; reordering the
    // dataset must not change which questions are probed, or two runs' probes
    // would not be comparable.
    const forward = await probeReaderDeterminism("http://fake", dataset());
    wire.reader = []; wire.judge = [];
    const reversed = await probeReaderDeterminism("http://fake", [...dataset()].reverse());
    expect(reversed.questionIds).toEqual(forward.questionIds);
    expect(reversed.perQuestion.map((q) => q.questionId)).toEqual(forward.perQuestion.map((q) => q.questionId));
    for (const call of wire.reader) expect(call.prompt).not.toContain("decoy");
  });

  test("the probe prompt is a pure function of the entry — a re-runner rebuilds it exactly", () => {
    const e = entry(PROBE_QUESTION_IDS[0]!);
    expect(probeContext(e)).toBe(probeContext(entry(PROBE_QUESTION_IDS[0]!)));
    // ...and it is capped at the harness's own readerTopK, so the prompt is the
    // shape and size a retrieval payload has.
    expect(probeContext(e).split("\n")).toHaveLength(RETRIEVAL.readerTopK);
  });

  test("a probe id missing from the dataset is FATAL, not a silent skip", async () => {
    // A silently-skipped question leaves a probe that looks complete but
    // measured less than it claims.
    await expect(
      probeReaderDeterminism("http://fake", [entry("something-else")]),
    ).rejects.toThrow(/not in the loaded dataset/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The pure summarisers, asserted directly. These are necessary but NOT
// sufficient — see the call-loop test above for why.
// ═══════════════════════════════════════════════════════════════════════════
describe("summarisers", () => {
  test("commonPrefixLength", () => {
    expect(commonPrefixLength([])).toBe(0);
    expect(commonPrefixLength(["abc"])).toBe(3);            // one string ⇒ its own length
    expect(commonPrefixLength(["abcdef", "abcxyz"])).toBe(3);
    expect(commonPrefixLength(["abc", "abcdef"])).toBe(3);  // one is a prefix of the other
    expect(commonPrefixLength(["xyz", "abc"])).toBe(0);
    expect(commonPrefixLength(["", "abc"])).toBe(0);
  });

  test("summariseSamples counts distinct completions and modal verdict agreement", () => {
    const s = summariseSamples(
      ["aa", "aa", "ab", "ac"],
      ["CORRECT", "CORRECT", "CORRECT", "INCORRECT"],
    );
    expect(s.distinctCompletions).toBe(3);
    expect(s.commonPrefixLength).toBe(1);
    expect(s.verdictAgreementRate).toBe(0.75);
    expect(s.verdictCounts).toEqual({ CORRECT: 3, INCORRECT: 1 });
  });

  test("an unparseable verdict is its own bucket, never folded into a real one", () => {
    const s = summariseSamples(["a", "a"], [null, "CORRECT"]);
    expect(s.judgeErrors).toBe(1);
    expect(s.verdictCounts).toEqual({ JUDGE_ERROR: 1, CORRECT: 1 });
    expect(s.verdictAgreementRate).toBe(0.5); // not 1.0 — the error is a disagreement
  });
});
