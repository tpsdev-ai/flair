/**
 * retrieve.ts — query Flair's REAL retrieval, at documented defaults.
 *
 * The single retrieval path both eval layers share. Calls POST /SemanticSearch
 * — the same endpoint `flair memory search` uses — so the eval measures Flair's
 * actual BM25 + union-RRF hybrid retrieval, not a reimplementation of it.
 *
 * Documented defaults (held fixed across the eval):
 *   - scoring="raw": the production default since flair#623 (composite's
 *     unconditional durability/recency multiplier was net-harmful to precision
 *     once hybrid retrieval went live).
 *   - hybrid BM25+RRF: enabled at the Harper PROCESS level via
 *     FLAIR_HYBRID_RETRIEVAL=true at spawn time (it is not a per-request
 *     parameter). The eval runner sets it before startHarper; this module just
 *     issues the query. nomic search prefixes are on by default in the shipped
 *     build (flair#504), so a default spawn already exercises the production
 *     retrieval path end to end.
 *
 * Retrieve WIDE, score at k: SemanticSearch's candidate pool is limit×5, so a
 * limit smaller than corpus/5 can drop a relevant record from the candidate set
 * entirely — an artefact of the request, not a recall signal. Callers pass a
 * limit chosen so limit×5 comfortably exceeds the corpus size; the metrics then
 * slice the returned ranking at k (1/5/10). See suggestRetrieveLimit.
 */
import type { BenchClient, RetrievedContext, RetrievedItem, RetrieveOptions } from "./types.js";
import { signedFetch } from "./signed-fetch.js";

/** A limit whose candidate pool (limit×5) covers a corpus of `corpusSize`,
 *  never below 20 (SemanticSearch's own comfortable floor for the small
 *  curated corpora). */
export function suggestRetrieveLimit(corpusSize: number): number {
  return Math.max(20, Math.ceil(corpusSize / 5) + 10);
}

/**
 * Retrieve context for one query, scoped to `client.agent.id`. Returns the
 * ranked memory ids (rank 0 = best) plus full items and this query's latency.
 * Throws on a non-OK search — a failed query must not silently score as a miss.
 */
export async function retrieveContext(
  client: BenchClient,
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrievedContext> {
  const { harper, agent } = client;
  const limit = opts.limit ?? 20;
  const scoring = opts.scoring ?? "raw";

  const t0 = performance.now();
  const res = await signedFetch(harper, agent, "POST", "/SemanticSearch", {
    agentId: agent.id,
    q: query,
    limit,
    scoring,
  });
  const latencyMs = performance.now() - t0;

  if (!res.ok) {
    throw new Error(`retrieveContext failed for "${query.slice(0, 60)}": HTTP ${res.status} ${JSON.stringify(res.body ?? null).slice(0, 300)}`);
  }
  const results: any[] = Array.isArray(res.body?.results) ? res.body.results : [];
  const items: RetrievedItem[] = results.map((r) => ({ id: r.id, score: r._score ?? r.score ?? 0, content: r.content, createdAt: r.createdAt }));
  return { rankedIds: items.map((i) => i.id), items, latencyMs };
}
