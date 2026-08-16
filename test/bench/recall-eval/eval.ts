/**
 * eval.ts — Layer 1 deterministic recall eval orchestration.
 *
 * Pure orchestration over the shared plumbing (packages/flair-bench/lib): ingest
 * the curated corpus per-event, wait until it is actually searchable, retrieve
 * every labelled query through Flair's real BM25+RRF at documented defaults, and
 * score each ranking against its FIXED curated labels. No LLM judge, no
 * sliding-window cue, no corpus-derived relevance — the whole point of the #17
 * fix. Deterministic: fixed corpus, fixed query set, fixed labels.
 *
 * Takes a running ephemeral Harper + registered agent (caller owns the
 * lifecycle) so the same function serves both the manual multi-run runner
 * (./run.ts) and the CI gate (test/integration/recall-eval-gate.test.ts).
 */
import {
  ingestSessionHistory,
  retrieveContext,
  suggestRetrieveLimit,
  scoreQuery,
  aggregate,
  type BenchClient,
  type AggregateScore,
  type PerQueryScore,
} from "../../../packages/flair-bench/lib/index";
import { CORPUS } from "../recall-harness/corpus";
import { buildCorpusSessions, LABELLED_QUERIES, type LabelledQuery } from "./labels";

export interface QueryOutcome {
  queryId: string;
  kind: string;
  /** 0-based rank of the first relevant id, -1 if not retrieved at all. */
  rank: number;
  score: PerQueryScore;
}

export interface RecallEvalResult {
  aggregate: AggregateScore;
  perQuery: QueryOutcome[];
  ingest: { written: number; elapsedMs: number; syntheticTimestamps: boolean };
  retrievalLatencyMeanMs: number;
}

/** Poll one query until its relevant id surfaces, so a not-yet-indexed corpus
 *  never scores as a recall miss. Memory.put awaits embedding, but HNSW
 *  visibility has a documented async lag in this codebase (see the harness's
 *  waitSearchable). Uses the first labelled query as the canary. */
async function waitSearchable(client: BenchClient, limit: number, timeoutMs = 45_000): Promise<void> {
  const canary = LABELLED_QUERIES[0]!;
  const wantId = canary.relevantIds[0]!;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ctx = await retrieveContext(client, canary.q, { limit });
    if (ctx.rankedIds.includes(wantId)) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`recall-eval waitSearchable: canary "${canary.q.slice(0, 50)}" never surfaced ${wantId} within ${timeoutMs}ms (embedding engine slow/down?)`);
}

/**
 * Run the full Layer 1 recall eval once against an already-running client.
 * Optionally scores against an ALTERNATE label map (queryId → relevant ids) —
 * used by the mutation-check to compare the curated labels against the
 * self-polluting corpus-derived control on the SAME retrieval ranking. When
 * `labelsOverride` is omitted, each query's own curated `relevantIds` are used.
 */
export async function runRecallEval(
  client: BenchClient,
  labelsOverride?: Record<string, string[]>,
): Promise<RecallEvalResult> {
  const limit = suggestRetrieveLimit(CORPUS.length);

  const ingest = await ingestSessionHistory(client, buildCorpusSessions());
  await waitSearchable(client, limit);

  const perQuery: QueryOutcome[] = [];
  const scores: PerQueryScore[] = [];
  let latencySum = 0;

  for (const lq of LABELLED_QUERIES) {
    const relevant = labelsOverride ? (labelsOverride[lq.id] ?? lq.relevantIds) : lq.relevantIds;
    const ctx = await retrieveContext(client, lq.q, { limit });
    latencySum += ctx.latencyMs;
    const relSet = new Set(relevant);
    const rank = ctx.rankedIds.findIndex((id) => relSet.has(id));
    const score = scoreQuery(ctx.rankedIds, relevant);
    perQuery.push({ queryId: lq.id, kind: lq.kind, rank, score });
    scores.push(score);
  }

  return {
    aggregate: aggregate(scores),
    perQuery,
    ingest: { written: ingest.written, elapsedMs: ingest.elapsedMs, syntheticTimestamps: ingest.syntheticTimestamps },
    retrievalLatencyMeanMs: latencySum / LABELLED_QUERIES.length,
  };
}

export { LABELLED_QUERIES };
export type { LabelledQuery };
