/**
 * longmemeval-evidence-coverage.test.ts — flair#1358 stage-attribution instrument.
 *
 * THE POWERED CHECK (this change; would be red on main): a fixture where
 * evidence is in the fused pool but crowded out of the top-k must report
 * pool ≥ N, topK < N; the same ranked pool with a larger top-k must report
 * topK ≈ N. If both slices report the same numbers the instrument cannot
 * separate the outcomes it exists to separate.
 *
 * Other assertions below say plainly whether they are a check on this change
 * or a regression lock on already-shipped behaviour.
 */
import { describe, expect, test } from "bun:test";
import {
  measureEvidenceCoverage, estimateTokens, collectEvidenceCoverage,
  EVIDENCE_COVERAGE_SCHEMA,
} from "../bench/longmemeval/evidence-coverage";
import { goldEvidenceFor, entryToSessions, type LmeEntry } from "../bench/longmemeval/dataset";
import { formatFullContext } from "../bench/longmemeval/arms";
import {
  buildArtifact, hashedContent, verifyArtifactHash,
} from "../bench/longmemeval/artifact";
import { aggregateArmRun, aggregateArmAcrossRuns } from "../bench/longmemeval/metrics";

function mkNamedEntry(id = "qCrowd"): LmeEntry {
  return {
    question_id: id,
    question_type: "multi-session",
    question: "Which three classes did I take?",
    answer: "yoga, spin, boxing",
    question_date: "2023/05/20 (Sat) 02:21",
    haystack_dates: ["2023/05/01 (Mon) 10:00", "2023/05/02 (Tue) 10:00"],
    haystack_session_ids: ["sess_noise", "sess_gold"],
    haystack_sessions: [
      [
        { role: "user", content: "generic fitness chat A" },
        { role: "assistant", content: "generic fitness chat B" },
        { role: "user", content: "generic fitness chat C" },
      ],
      [
        { role: "user", content: "I started yoga", has_answer: true },
        { role: "assistant", content: "nice" },
        { role: "user", content: "then spin", has_answer: true },
        { role: "user", content: "then boxing", has_answer: true },
      ],
    ],
    answer_session_ids: ["sess_gold"],
  };
}

function mkUnnamedEntry(id = "qFallback"): LmeEntry {
  return {
    question_id: id,
    question_type: "single-session-preference",
    question: "Recommend dinner.",
    answer: "vegan",
    question_date: "2023/05/20 (Sat) 02:21",
    haystack_dates: ["2023/05/01 (Mon) 10:00"],
    haystack_session_ids: ["sess_pref"],
    haystack_sessions: [
      [
        { role: "user", content: "I am vegan" },
        { role: "assistant", content: "got it" },
        { role: "user", content: "also gluten-free" },
      ],
    ],
    answer_session_ids: ["sess_pref"],
  };
}

const GOLD = ["qCrowd__s1__t0", "qCrowd__s1__t2", "qCrowd__s1__t3"];
const NOISE = ["qCrowd__s0__t0", "qCrowd__s0__t1", "qCrowd__s0__t2"];

describe("powered check — crowding vs larger top-k (this change; red-on-main before the instrument)", () => {
  test("evidence in the pool but below the top-k slice reports pool ≥ N, topK < N; a larger top-k reports topK ≈ N", () => {
    const entry = mkNamedEntry();
    const gold = goldEvidenceFor(entry);
    expect(gold.answerEventIds).toEqual(GOLD);
    const N = gold.answerEventIds.length;
    expect(N).toBe(3);

    // Fused pool holds every gold event. Rank order crowds e2 and e3 below k=2:
    // two generic same-session fragments sit above the remaining evidence.
    const fused = [NOISE[0]!, NOISE[1]!, GOLD[0]!, NOISE[2]!, GOLD[1]!, GOLD[2]!];
    const pool = {
      bm25: [NOISE[0]!, NOISE[1]!, GOLD[0]!, GOLD[1]!],
      hnsw: [GOLD[0]!, GOLD[1]!, GOLD[2]!, NOISE[2]!],
      fused,
    };

    const crowded = measureEvidenceCoverage({
      entry, arm: "flair",
      stages: { pool, topK: fused.slice(0, 2), readerContext: fused.slice(0, 2) },
    });
    expect(crowded.granularity).toBe("named-events");
    expect(crowded.n).toBe(N);
    expect(crowded.evidenceEventsInPool.fused).toBeGreaterThanOrEqual(N);
    expect(crowded.evidenceEventsInPool.fused).toBe(N);
    expect(crowded.evidenceEventsInFinalTopK).toBeLessThan(N);
    expect(crowded.evidenceEventsInFinalTopK).toBe(0);

    const recovered = measureEvidenceCoverage({
      entry, arm: "flair",
      stages: { pool, topK: fused.slice(0, 6), readerContext: fused.slice(0, 6) },
    });
    expect(recovered.evidenceEventsInPool.fused).toBe(N);
    expect(recovered.evidenceEventsInFinalTopK).toBe(N);

    // THE LOAD-BEARING SEPARATION. If both slices reported the same topK
    // the instrument could not tell crowding from anything else.
    expect(recovered.evidenceEventsInFinalTopK).not.toBe(crowded.evidenceEventsInFinalTopK);
    expect(recovered.evidenceEventsInFinalTopK).toBeGreaterThan(crowded.evidenceEventsInFinalTopK);
  });

  test("per-leg pool membership is independent: BM25-only vs HNSW-only vs fused", () => {
    const entry = mkNamedEntry();
    const rec = measureEvidenceCoverage({
      entry, arm: "flair",
      stages: {
        pool: { bm25: [GOLD[0]!], hnsw: [GOLD[1]!, GOLD[2]!], fused: GOLD },
        topK: GOLD,
        readerContext: GOLD,
      },
    });
    expect(rec.evidenceEventsInPool).toEqual({ bm25: 1, hnsw: 2, fused: 3 });
  });
});

describe("four-outcome disambiguation (this change)", () => {
  const entry = mkNamedEntry();
  const N = 3;
  const poolAll = { bm25: GOLD, hnsw: GOLD, fused: GOLD };

  test("pool < N is a recall gap into the pool", () => {
    const rec = measureEvidenceCoverage({
      entry, arm: "flair",
      stages: { pool: { bm25: [], hnsw: [GOLD[0]!], fused: [GOLD[0]!] }, topK: [GOLD[0]!], readerContext: [GOLD[0]!] },
    });
    expect(rec.evidenceEventsInPool.fused).toBeLessThan(N);
    expect(rec.evidenceEventsInPool.fused).toBe(1);
  });

  test("topK ≈ N and readerContext < N is truncation, not crowding", () => {
    const rec = measureEvidenceCoverage({
      entry, arm: "full-context",
      stages: { pool: poolAll, topK: GOLD, readerContext: GOLD.slice(0, 2) },
    });
    expect(rec.evidenceEventsInFinalTopK).toBe(N);
    expect(rec.evidenceEventsInReaderContext).toBeLessThan(N);
    expect(rec.evidenceEventsInReaderContext).toBe(2);
  });

  test("topK ≈ N and readerContext ≈ N is the reader/prompt residual", () => {
    const rec = measureEvidenceCoverage({
      entry, arm: "flair",
      stages: { pool: poolAll, topK: GOLD, readerContext: GOLD },
    });
    expect(rec.evidenceEventsInFinalTopK).toBe(N);
    expect(rec.evidenceEventsInReaderContext).toBe(N);
  });

  test("no-context arm is zeros at every stage — every arm emits the shape", () => {
    const rec = measureEvidenceCoverage({
      entry, arm: "no-context",
      stages: { pool: { bm25: [], hnsw: [], fused: [] }, topK: [], readerContext: [] },
    });
    expect(rec.arm).toBe("no-context");
    expect(rec.n).toBe(N);
    expect(rec.evidenceEventsInPool).toEqual({ bm25: 0, hnsw: 0, fused: 0 });
    expect(rec.evidenceEventsInFinalTopK).toBe(0);
    expect(rec.evidenceEventsInReaderContext).toBe(0);
  });
});

describe("handoff measurement — formatter-admitted ids, not a prompt scan (this change)", () => {
  test("overlapping event text does not count a truncated gold event", () => {
    // B's ingested content is a prefix of A's. A is admitted; B is cut by the
    // char budget. context.includes(B.content) is still true — a prompt-string
    // scan would count B. The shipped path uses formatFullContext.includedEventIds.
    const entry: LmeEntry = {
      question_id: "qOverlap",
      question_type: "multi-session",
      question: "which classes?",
      answer: "yoga and boxing",
      question_date: "2023/05/20 (Sat) 02:21",
      haystack_dates: ["2023/05/01 (Mon) 10:00"],
      haystack_session_ids: ["sess_gold"],
      haystack_sessions: [[
        { role: "user", content: "then boxing later I started yoga then boxing", has_answer: true },
        { role: "user", content: "then boxing", has_answer: true },
      ]],
      answer_session_ids: ["sess_gold"],
    };
    const sessions = entryToSessions(entry);
    const a = sessions[0]!.events[0]!;
    const b = sessions[0]!.events[1]!;
    const header = `\n[Session ${sessions[0]!.sessionId} — ${sessions[0]!.date}]\n`;
    const lineA = `${a.role}: ${a.content}\n`;
    const fc = formatFullContext(sessions, header.length + lineA.length);
    expect(fc.truncated).toBe(true);
    expect(fc.includedEventIds).toEqual([a.id]);
    expect(fc.text.includes(b.content)).toBe(true);

    const rec = measureEvidenceCoverage({
      entry, arm: "full-context",
      stages: {
        pool: { bm25: [], hnsw: [], fused: [a.id, b.id] },
        topK: [a.id, b.id],
        readerContext: fc.includedEventIds,
      },
    });
    expect(rec.n).toBe(2);
    expect(rec.evidenceEventsInFinalTopK).toBe(2);
    expect(rec.evidenceEventsInReaderContext).toBe(1);
  });
});

describe("session-fragment fallback when ground truth does not name events (this change)", () => {
  test("flags a session represented by exactly one fragment and reports event/token counts", () => {
    const entry = mkUnnamedEntry();
    expect(goldEvidenceFor(entry).answerEventIds).toEqual([]);

    const topK = ["qFallback__s0__t0"];
    const rec = measureEvidenceCoverage({
      entry, arm: "vector-only",
      stages: { pool: { bm25: [], hnsw: topK, fused: topK }, topK, readerContext: topK },
      topKItems: [{ id: "qFallback__s0__t0", content: "user: I am vegan" }],
    });
    expect(rec.granularity).toBe("session-fallback");
    expect(rec.n).toBe(0);
    expect(rec.sessionFallback).toBeDefined();
    expect(rec.sessionFallback!.perSession).toEqual([{
      sessionId: "sess_pref",
      eventCountInTopK: 1,
      tokenCountInTopK: estimateTokens("user: I am vegan"),
      singleFragment: true,
    }]);
  });

  test("a session with two fragments is not flagged single-fragment", () => {
    const entry = mkUnnamedEntry();
    const topK = ["qFallback__s0__t0", "qFallback__s0__t2"];
    const rec = measureEvidenceCoverage({
      entry, arm: "flair",
      stages: { pool: { bm25: topK, hnsw: topK, fused: topK }, topK, readerContext: topK },
      topKItems: [
        { id: "qFallback__s0__t0", content: "user: I am vegan" },
        { id: "qFallback__s0__t2", content: "user: also gluten-free" },
      ],
    });
    expect(rec.sessionFallback!.perSession[0]!.singleFragment).toBe(false);
    expect(rec.sessionFallback!.perSession[0]!.eventCountInTopK).toBe(2);
  });
});

describe("artifact additivity — existing fields and aggregate shape stay put", () => {
  const baseInput = () => ({
    configHash: "deadbeef",
    config: { schema: "test", a: 1 },
    runHashes: ["r1"],
    aggregate: [] as any[],
    gitCommit: "abc123",
    ollamaHost: "http://host:11434",
    benchHost: "rockit",
    validationSlice: true,
  });

  test("omitting evidenceCoverage leaves artifactHash unchanged (additive; regression lock on the pre-#1358 seal)", () => {
    // REGRESSION LOCK on already-shipped behaviour — not a red-on-main check
    // for this instrument. A run that does not emit coverage must hash as it
    // always did, so prior artifacts stay interpretable.
    const without = buildArtifact(baseInput());
    const alsoWithout = buildArtifact(baseInput());
    expect(without.artifactHash).toBe(alsoWithout.artifactHash);
    expect(Object.keys(hashedContent(without))).not.toContain("evidenceCoverage");
  });

  test("adding evidenceCoverage is hashed content and moves the seal (this change)", () => {
    const without = buildArtifact(baseInput());
    const rec = measureEvidenceCoverage({
      entry: mkNamedEntry(), arm: "flair",
      stages: { pool: { bm25: GOLD, hnsw: GOLD, fused: GOLD }, topK: GOLD, readerContext: GOLD },
    });
    const withCov = buildArtifact({
      ...baseInput(),
      evidenceCoverage: { schema: EVIDENCE_COVERAGE_SCHEMA, questions: [{ ...rec, runIndex: 1 }] },
    });
    expect(withCov.evidenceCoverage).toBeDefined();
    expect(withCov.evidenceCoverage!.questions[0]!.evidenceEventsInFinalTopK).toBe(3);
    expect(Object.keys(hashedContent(withCov))).toContain("evidenceCoverage");
    expect(withCov.artifactHash).not.toBe(without.artifactHash);
    expect(verifyArtifactHash(withCov)).toBe(true);
  });

  test("aggregate keys are unchanged when coverage is present (this change; lock on aggregate shape)", () => {
    const perRun = [aggregateArmRun("flair", [{
      questionId: "q1", ability: "multi-session", isAbstention: false, arm: "flair",
      answer: "", verdict: "CORRECT", tokensFed: 10, latencyMs: 1,
    }])];
    const aggregate = [aggregateArmAcrossRuns("flair", perRun)];
    const rec = measureEvidenceCoverage({
      entry: mkNamedEntry(), arm: "flair",
      stages: { pool: { bm25: GOLD, hnsw: GOLD, fused: GOLD }, topK: GOLD, readerContext: GOLD },
    });
    const art = buildArtifact({
      ...baseInput(),
      aggregate,
      evidenceCoverage: { schema: EVIDENCE_COVERAGE_SCHEMA, questions: [{ ...rec, runIndex: 1 }] },
    });
    const keys = Object.keys(art.aggregate[0]!).sort();
    const without = buildArtifact({ ...baseInput(), aggregate });
    expect(keys).toEqual(Object.keys(without.aggregate[0]!).sort());
    expect(art.aggregate[0]).toEqual(without.aggregate[0]);
  });
});

describe("collectEvidenceCoverage", () => {
  test("sorts by run then arm+question and drops empty runs", () => {
    const a = measureEvidenceCoverage({
      entry: mkNamedEntry("qB"), arm: "vector-only",
      stages: { pool: { bm25: [], hnsw: GOLD, fused: GOLD }, topK: GOLD, readerContext: GOLD },
    });
    const b = measureEvidenceCoverage({
      entry: mkNamedEntry("qA"), arm: "flair",
      stages: { pool: { bm25: GOLD, hnsw: GOLD, fused: GOLD }, topK: GOLD, readerContext: GOLD },
    });
    const collected = collectEvidenceCoverage([
      { runIndex: 2, results: [{ evidenceCoverage: a }] },
      { runIndex: 1, results: [{ evidenceCoverage: b }, {}] },
    ]);
    expect(collected!.schema).toBe(EVIDENCE_COVERAGE_SCHEMA);
    expect(collected!.questions.map((q) => `${q.runIndex}:${q.arm}:${q.questionId}`)).toEqual([
      "1:flair:qA",
      "2:vector-only:qB",
    ]);
  });

  test("omits the block entirely when no question carried coverage", () => {
    expect(collectEvidenceCoverage([{ runIndex: 1, results: [{}] }])).toBeUndefined();
  });

  test("keeps a genuine-zero record and drops a missing one (this change; missing vs zero)", () => {
    const zero = measureEvidenceCoverage({
      entry: mkNamedEntry(), arm: "no-context",
      stages: { pool: { bm25: [], hnsw: [], fused: [] }, topK: [], readerContext: [] },
    });
    expect(zero.n).toBeGreaterThan(0);
    expect(zero.evidenceEventsInFinalTopK).toBe(0);
    const collected = collectEvidenceCoverage([
      { runIndex: 1, results: [{ evidenceCoverage: zero }, {}] },
    ]);
    expect(collected!.questions).toHaveLength(1);
    expect(collected!.questions[0]!.arm).toBe("no-context");
    expect(collected!.questions[0]!.evidenceEventsInReaderContext).toBe(0);
  });
});
