/**
 * evidence-coverage.ts — flair#1358 stage-attribution instrument.
 *
 * The bench can score a question and still not say whether evidence reached
 * the reader. This module measures EVENT-granularity coverage at three
 * stages, per question, per arm:
 *
 *   1. evidenceEventsInPool     — per leg (BM25, HNSW, fused)
 *   2. evidenceEventsInFinalTopK
 *   3. evidenceEventsInReaderContext  — the prompt actually handed to the reader
 *
 * Truncation is a fourth outcome (topK ≈ N, readerContext < N), not crowding
 * (pool ≈ N, topK < N). Session-diversity selection is NOT implemented here
 * and is not imported from anywhere — this file is observation only.
 *
 * Pure. No Harper, no reader, no spend. Ground truth comes from the dataset
 * (`has_answer` turns via goldEvidenceFor). When those are absent, the
 * fallback is per-session event-count and token-count in the top-k, flagging
 * any session represented by exactly one fragment.
 */
import { entryToSessions, goldEvidenceFor, type LmeEntry } from "./dataset";
import type { Arm } from "./arms";

export const EVIDENCE_COVERAGE_SCHEMA = "longmemeval-s.evidence-coverage/1";

export interface LegCounts {
  bm25: number;
  hnsw: number;
  fused: number;
}

export interface SessionFragmentStats {
  sessionId: string;
  eventCountInTopK: number;
  tokenCountInTopK: number;
  /** True when this session is represented by exactly one fragment. */
  singleFragment: boolean;
}

export interface EvidenceCoverageRecord {
  questionId: string;
  arm: Arm;
  /** How ground truth was counted. */
  granularity: "named-events" | "session-fallback";
  /** N — named gold event count. 0 when falling back to session fragments. */
  n: number;
  evidenceEventsInPool: LegCounts;
  evidenceEventsInFinalTopK: number;
  evidenceEventsInReaderContext: number;
  /** Present only when ground truth does not name specific events. */
  sessionFallback?: { perSession: SessionFragmentStats[] };
}

export interface EvidenceCoverageArtifact {
  schema: typeof EVIDENCE_COVERAGE_SCHEMA;
  questions: Array<EvidenceCoverageRecord & { runIndex: number }>;
}

export interface StageIds {
  pool: { bm25: string[]; hnsw: string[]; fused: string[] };
  topK: string[];
  readerContext: string[];
}

export interface HandoffCandidate {
  id: string;
  content?: string;
}

/** Reader-free token estimate: 4 chars/token. Not a model call. */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / 4);
}

/**
 * Line-payload of one prompt line. Retrieved lines are `- content` or
 * `- [YYYY-MM-DD] content`. Full-context lines are `role: content`. A raw
 * substring match is not used — overlapping event text in an earlier line
 * must not count a later, unadmitted event (flair#1358 Bugbot).
 */
function linePayload(line: string): string {
  const t = line.trim();
  const dated = t.match(/^- \[\d{4}-\d{2}-\d{2}\] (.*)$/);
  if (dated) return dated[1]!;
  if (t.startsWith("- ")) return t.slice(2);
  const role = t.match(/^[^:]+: (.*)$/);
  if (role) return role[1]!;
  return t;
}

/**
 * Evidence events whose FULL content is a distinct admitted line in the
 * prompt. Each line is consumed at most once. A truncated event whose text
 * also appears inside an earlier line does not count.
 */
export function idsInHandoffContext(
  candidates: HandoffCandidate[],
  context: string,
): string[] {
  if (!context) return [];
  const payloads = context.split("\n").map(linePayload);
  const used = new Set<number>();
  const found: string[] = [];
  for (const c of candidates) {
    const text = (c.content ?? "").trim();
    if (!text) continue;
    const idx = payloads.findIndex((p, i) => !used.has(i) && p === text);
    if (idx >= 0) {
      used.add(idx);
      found.push(c.id);
    }
  }
  return found;
}

function countNamed(goldIds: string[], ids: string[]): number {
  const set = new Set(ids);
  return goldIds.filter((id) => set.has(id)).length;
}

export function eventSessionMap(entry: LmeEntry): Map<string, { sessionId: string; content: string }> {
  const map = new Map<string, { sessionId: string; content: string }>();
  for (const s of entryToSessions(entry)) {
    for (const ev of s.events) {
      map.set(ev.id, { sessionId: s.sessionId, content: ev.content });
    }
  }
  return map;
}

function sessionFallbackStats(
  entry: LmeEntry,
  topK: string[],
  topKItems: HandoffCandidate[] | undefined,
): SessionFragmentStats[] {
  const meta = eventSessionMap(entry);
  const contentById = new Map<string, string>();
  for (const it of topKItems ?? []) {
    if (it.content) contentById.set(it.id, it.content);
  }
  const bySession = new Map<string, { eventCount: number; tokens: number }>();
  for (const id of topK) {
    const sessionId = meta.get(id)?.sessionId;
    if (!sessionId) continue;
    const cur = bySession.get(sessionId) ?? { eventCount: 0, tokens: 0 };
    cur.eventCount += 1;
    cur.tokens += estimateTokens(contentById.get(id) ?? meta.get(id)?.content ?? "");
    bySession.set(sessionId, cur);
  }
  // Gold sessions that never appeared still get a zero row so a miss is visible.
  for (const sessionId of goldEvidenceFor(entry).sessionIds) {
    if (!bySession.has(sessionId)) bySession.set(sessionId, { eventCount: 0, tokens: 0 });
  }
  return [...bySession.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([sessionId, s]) => ({
      sessionId,
      eventCountInTopK: s.eventCount,
      tokenCountInTopK: s.tokens,
      singleFragment: s.eventCount === 1,
    }));
}

/**
 * Count gold evidence at the three stages. Named `has_answer` events win;
 * otherwise emit the session-fragment fallback.
 */
export function measureEvidenceCoverage(input: {
  entry: LmeEntry;
  arm: Arm;
  stages: StageIds;
  topKItems?: HandoffCandidate[];
}): EvidenceCoverageRecord {
  const named = goldEvidenceFor(input.entry).answerEventIds;
  if (named.length > 0) {
    return {
      questionId: input.entry.question_id,
      arm: input.arm,
      granularity: "named-events",
      n: named.length,
      evidenceEventsInPool: {
        bm25: countNamed(named, input.stages.pool.bm25),
        hnsw: countNamed(named, input.stages.pool.hnsw),
        fused: countNamed(named, input.stages.pool.fused),
      },
      evidenceEventsInFinalTopK: countNamed(named, input.stages.topK),
      evidenceEventsInReaderContext: countNamed(named, input.stages.readerContext),
    };
  }
  return {
    questionId: input.entry.question_id,
    arm: input.arm,
    granularity: "session-fallback",
    n: 0,
    evidenceEventsInPool: {
      bm25: 0,
      hnsw: 0,
      fused: 0,
    },
    evidenceEventsInFinalTopK: 0,
    evidenceEventsInReaderContext: 0,
    sessionFallback: { perSession: sessionFallbackStats(input.entry, input.stages.topK, input.topKItems) },
  };
}

/** Fold per-(question, arm) records from one or more runs into the artifact block. */
export function collectEvidenceCoverage(
  runs: Array<{ runIndex: number; results: Array<{ evidenceCoverage?: EvidenceCoverageRecord }> }>,
): EvidenceCoverageArtifact | undefined {
  const questions: Array<EvidenceCoverageRecord & { runIndex: number }> = [];
  for (const run of runs) {
    for (const r of run.results) {
      if (r.evidenceCoverage) questions.push({ ...r.evidenceCoverage, runIndex: run.runIndex });
    }
  }
  if (questions.length === 0) return undefined;
  questions.sort((a, b) =>
    (a.runIndex - b.runIndex) || (a.arm + a.questionId).localeCompare(b.arm + b.questionId));
  return { schema: EVIDENCE_COVERAGE_SCHEMA, questions };
}
