// ─── retrieveCandidates() — the pure retrieval core (flair bootstrap-scale-fix) ──
//
// Extracted from resources/SemanticSearch.ts's post() (Kern-approved
// refactor, flair#695). Before this module existed,
// SemanticSearch.post() was one function entangling auth resolution,
// rate-limiting, HNSW/BM25 retrieval, post-retrieval filtering, the
// cross-encoder reranker, AND retrievalCount/lastRetrieved hit-tracking side
// effects — so the ONLY way for MemoryBootstrap (resources/MemoryBootstrap.ts)
// to get bounded, HNSW-pushed-down candidates was to duplicate the retrieval
// logic or trip the side effects (an internal bootstrap call spuriously
// bumping `retrievalCount` would pollute a ranking signal every other agent's
// searches read).
//
// Boundary (Kern's review, folded into the implementation checklist): this
// function owns SemanticSearch's retrieval + post-retrieval filtering layers —
// the HNSW leg query construction (sort/select/conditions/limit), the BM25 +
// union-RRF hybrid fusion, the per-record temporal/expiry/supersede filters,
// and the scope.isAllowed() defense-in-depth re-check. It does NOT own: auth
// resolution, rate-limiting, the reranker, or the retrievalCount/lastRetrieved
// hit-tracking side effects — those stay in SemanticSearch.post()'s wrapper
// (resources/SemanticSearch.ts) so an internal caller (bootstrap) never trips
// them.
//
// PURE FUNCTION DISCIPLINE (Kern, non-negotiable): every param below is a
// primitive/plain-value/function — never `this` or a SemanticSearch instance.
// A core that took `this` would force mocking (or a later re-refactor) for
// any second caller; this one is callable standalone, no Resource/HTTP
// context required beyond the optional `ctx` param (only used for
// withDetachedTxn's transaction-chain workaround — both SemanticSearch and
// MemoryBootstrap are Harper Resources with their own `ctx`).
//
// Returns results AFTER all filters, sorted best-first by `_score` — bounded
// ONLY by the `limit` the caller chose to push down (the core never
// multiplies `limit` internally; any overfetch policy — SemanticSearch's
// CANDIDATE_MULTIPLIER, rerank-topN widening — is the CALLER's decision, made
// before calling in). Never exposes which internal leg (BM25+RRF hybrid vs.
// legacy HNSW-only vs. keyword-only fallback) produced a given result — the
// output shape is identical regardless of `hybrid`.
import { databases } from "@harperfast/harper";
import { withDetachedTxn } from "./table-helpers.js";
import { wrapUntrusted } from "./content-safety.js";
import { cosineSimilarity } from "./dedup.js";
import { compositeScore } from "./scoring.js";
import { buildBM25, fuseRrfNormalized, SEM_LIMIT } from "./bm25.js";
import { isAllowedBm25Candidate, type Condition } from "./bm25-filter.js";

// Convert HNSW cosine distance (1 - similarity) to similarity score.
function distanceToSimilarity(distance: number): number {
  return 1 - distance;
}

// Default field selection for every retrieval leg — explicit (no raw
// `embedding`, so the large vector never enters a result payload or a
// bootstrap-sized candidate pool) and shared between the HNSW leg and the
// BM25 corpus fetch so a fused id always resolves to the same record shape
// regardless of which leg produced it. Includes `summary` (agent-set dense
// compression, resources/Memory.ts) even though SemanticSearch's own callers
// don't read it — MemoryBootstrap's collision-surfacing block
// (resources/collision-lib.ts's SemanticMatchInput) reads `m.summary ||
// m.content`, so dropping it here would silently regress bootstrap's
// "Others in the room" surface even though SemanticSearch never asserts on
// its absence.
const DEFAULT_SELECT = ["id", "agentId", "content", "contentHash", "visibility", "tags", "durability",
  "source", "createdAt", "updatedAt", "expiresAt", "retrievalCount", "usageCount", "lastRetrieved",
  "promotionStatus", "promotedAt", "promotedBy", "archived", "archivedAt", "archivedBy",
  "parentId", "derivedFrom", "sessionId", "lastReflected", "supersedes", "subject", "summary",
  "validFrom", "validTo", "_safetyFlags"];

export interface RetrieveCandidatesParams {
  /** Precomputed query embedding, or null/undefined when none is available
   *  (e.g. the embedding engine failed/was never called). */
  queryEmbedding?: number[] | null;
  /** Raw query text — drives BM25 lexical ranking (hybrid leg) and the
   *  legacy keyword bump (HNSW-only leg). Optional: MemoryBootstrap never
   *  supplies this — it has no free-text query, only a precomputed
   *  `queryEmbedding`, and per the K&S verdict bootstrap gets HNSW-leg
   *  pushdown only, no keyword bump. */
  q?: string;
  /** Pre-built Harper conditions[] — the caller (SemanticSearch.post() /
   *  MemoryBootstrap.post()) already resolved scope.condition (and, for
   *  SemanticSearch, folded in archived/tag/subject conditions too) into
   *  this array. The core never builds its own scoping condition — it only
   *  pushes down whatever it's given. */
  conditions: any[];
  /** The literal Harper query `limit` for the HNSW/BM25 legs — the exact
   *  candidate-pool depth fetched. The core does NOT multiply this
   *  internally; SemanticSearch's overfetch policy (CANDIDATE_MULTIPLIER,
   *  rerank-topN widening) and MemoryBootstrap's K formula are both computed
   *  by the caller BEFORE calling in. */
  limit: number;
  /** Field selection override. Defaults to DEFAULT_SELECT (no raw
   *  embedding). */
  select?: string[];
  /** Include supersede-chain predecessors that are co-present in THIS
   *  bounded candidate set. Default false (exclude them) — matches both
   *  SemanticSearch's and MemoryBootstrap's prior default. */
  includeSuperseded?: boolean;
  scoring?: "raw" | "composite";
  temporalBoost?: number;
  sinceDate?: Date | null;
  asOf?: string;
  minScore?: number;
  /** The calling agent's own id — used ONLY to tag a result's `_source`
   *  (cross-agent attribution). Never used to change what's fetched; that's
   *  entirely `conditions`' job. */
  agentId?: string;
  /**
   * scope.isAllowed() (resources/memory-read-scope.ts) — Sherlock's
   * NON-NEGOTIABLE defense-in-depth re-check (flair-bootstrap-scale-fix K&S
   * verdict). `conditions` is the PRIMARY gate — Harper's query engine
   * should never return a row failing it — but the pushdown condition alone
   * is not trusted as the only gate: Harper could in principle return a row
   * matching `conditions` that still fails a stricter in-process
   * `isAllowed` check (a visibility edge case). Re-checked on EVERY
   * candidate in every branch below whenever provided — never skipped just
   * because the caller already pushed a scoping condition down. This is the
   * exact refactor mistake ("the filter pushes down now, so the re-check is
   * redundant") that would turn a perf fix into a scope leak.
   */
  isAllowed?: (record: any) => boolean;
  /**
   * Whether to run the BM25 + union-RRF hybrid leg (true) or the legacy
   * HNSW-only / keyword-fallback path (false). Explicit and REQUIRED — never
   * read from hybridEnabled() internally, so a caller gets a deterministic
   * mode regardless of the global FLAIR_HYBRID_RETRIEVAL env value.
   * MemoryBootstrap ALWAYS passes false: the hybrid leg's BM25 corpus fetch
   * (`corpusQuery` below) is an UNBOUNDED conditions-scoped scan (no
   * `limit` — matches SemanticSearch's pre-existing, out-of-scope-for-this-PR
   * behavior) run regardless of whether `q` is even supplied, which is
   * exactly the kind of unbounded scan this PR removes bootstrap's need for.
   * HNSW-leg-only for bootstrap is also the K&S-ratified default: BM25 for a
   * one-shot session-load has a different (likely worse) cost profile than
   * SemanticSearch's per-query BM25, and the reranker is a generative call
   * per candidate — both are explicit opt-in follow-ons, not this PR.
   */
  hybrid: boolean;
  /** Request context, for withDetachedTxn — both SemanticSearch and
   *  MemoryBootstrap are Resources with their own ctx. */
  ctx?: any;
}

export async function retrieveCandidates(params: RetrieveCandidatesParams): Promise<any[]> {
  const {
    queryEmbedding: qEmb, q, conditions, limit,
    select = DEFAULT_SELECT,
    includeSuperseded = false,
    scoring = "raw",
    temporalBoost = 1.0,
    sinceDate = null,
    asOf,
    minScore = 0,
    agentId,
    isAllowed,
    hybrid,
    ctx,
  } = params;

  const passesAllowed = (record: any) => !isAllowed || isAllowed(record);
  const hnswSelect = [...select, "$distance"];

  const results: any[] = [];

  if (hybrid) {
    // ─── BM25 + union-RRF hybrid path ────────────────────────────────────
    // 1. Semantic candidates via HNSW (unchanged fetch). 2. BM25 lexical pass
    //    over the SCOPED corpus. 3. SECURITY: the BM25 candidate set is filtered
    //    by the SAME conditions[] + temporal filters BEFORE fusion (the corpus
    //    is fetched with those conditions, AND re-checked in-process as
    //    defense-in-depth) so no other agent's memory is ever scored or fused.
    //    4. Candidate-union RRF → normalize → feed as rawScore to compositeScore.

    // ── (a) Semantic candidate records (best-first) ──────────────────────
    const semRecords: any[] = [];
    const semIds: string[] = [];
    if (qEmb) {
      const semQuery: any = {
        sort: { attribute: "embedding", target: qEmb, distance: "cosine" },
        select: hnswSelect,
        limit,
      };
      if (conditions.length > 0) semQuery.conditions = conditions;
      const semResults = withDetachedTxn(ctx, () => (databases as any).flair.Memory.search(semQuery));
      for await (const record of semResults) {
        if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
        if (sinceDate && record.createdAt && new Date(record.createdAt) < sinceDate) continue;
        if (asOf && record.validFrom && record.validFrom > asOf) continue;
        if (asOf && record.validTo && record.validTo <= asOf) continue;
        // A past validTo ALWAYS means the record has been closed out
        // (server supersede path — Memory.ts closeSupersededRecord — sets
        // validTo without necessarily setting `archived`). Unconditional, not
        // gated on `asOf`, so a server-superseded record can't resurface just
        // because its successor isn't co-present in this result set (the
        // supersededIds filter further down only catches co-presence). A
        // record with no validTo, or a future validTo, is unaffected.
        if (record.validTo && Date.parse(record.validTo) < Date.now()) continue;
        if (!passesAllowed(record)) continue;
        semRecords.push(record);
        semIds.push(record.id);
      }
    }

    // ── (b) BM25 candidate records over the SCOPED corpus ────────────────
    const corpusQuery: any = conditions.length > 0
      ? { conditions, select }
      : { select };
    const corpusResults = withDetachedTxn(ctx, () => (databases as any).flair.Memory.search(corpusQuery));
    const allowedById = new Map<string, any>();
    const bm25Docs: { id: string; content?: string }[] = [];
    for await (const record of corpusResults) {
      // Defense-in-depth: re-check the SAME conditions[] + temporal filters
      // in-process. Even if a Harper query change ever let an out-of-scope
      // record through, it is dropped here BEFORE it can be BM25-scored/fused.
      if (!isAllowedBm25Candidate(record, conditions as Condition[], { sinceDate, asOf })) continue;
      if (!passesAllowed(record)) continue;
      allowedById.set(record.id, record);
      bm25Docs.push({ id: record.id, content: record.content });
    }

    // Carry semantic candidates that survived their temporal gate into the
    // allowed map too (so a fused id always resolves to a record). Semantic
    // records were fetched with the SAME conditions[], so they're in-scope.
    for (const r of semRecords) {
      if (!allowedById.has(r.id)) {
        const { $distance, ...rest } = r;
        allowedById.set(r.id, rest);
      }
    }

    // ── (c) BM25 lexical ranking → top SEM_LIMIT (only when q present) ────
    let bm25Ids: string[] = [];
    if (q) {
      const bm25 = buildBM25(bm25Docs);
      const ranked = bm25.rank(String(q));
      bm25Ids = ranked.filter(r => r.score > 0).slice(0, SEM_LIMIT).map(r => r.id);
    }

    // ── (d) No retrieval signal at all → full scoped listing ────────────
    if (!q && !qEmb) {
      for (const record of allowedById.values()) {
        const rawScore = 0;
        let finalScore = scoring === "raw" ? rawScore : compositeScore(rawScore, record);
        if (temporalBoost > 1.0) finalScore *= temporalBoost;

        const isFlagged = record._safetyFlags && Array.isArray(record._safetyFlags) && record._safetyFlags.length > 0;
        const source = record.agentId !== agentId ? record.agentId : undefined;
        results.push({
          ...record,
          content: isFlagged ? wrapUntrusted(record.content, source) : record.content,
          _score: Math.round(finalScore * 1000) / 1000,
          _rawScore: scoring !== "raw" ? Math.round(rawScore * 1000) / 1000 : undefined,
          _source: source,
        });
      }
    } else {
      // ── Candidate-union RRF → normalized [0,1] rawScore ────────────────
      const fused = fuseRrfNormalized(semIds, bm25Ids);

      for (const [id, rrfRaw] of fused) {
        const record = allowedById.get(id);
        if (!record) continue; // should not happen — union ⊆ allowed
        const rawScore = rrfRaw; // already normalized to [0,1]
        let finalScore = scoring === "raw" ? rawScore : compositeScore(rawScore, record);
        if (temporalBoost > 1.0) finalScore *= temporalBoost;

        const isFlagged = record._safetyFlags && Array.isArray(record._safetyFlags) && record._safetyFlags.length > 0;
        const source = record.agentId !== agentId ? record.agentId : undefined;
        results.push({
          ...record,
          content: isFlagged ? wrapUntrusted(record.content, source) : record.content,
          _score: Math.round(finalScore * 1000) / 1000,
          _rawScore: scoring !== "raw" ? Math.round(rawScore * 1000) / 1000 : undefined,
          _source: source,
        });
      }
    }
  } else if (qEmb) {
    // ─── HNSW vector search path (legacy, hybrid flag OFF — or a caller
    // like MemoryBootstrap forcing HNSW-leg-only regardless of the flag) ────
    const query: any = {
      sort: { attribute: "embedding", target: qEmb, distance: "cosine" },
      select: hnswSelect,
      limit,
    };
    if (conditions.length > 0) {
      query.conditions = conditions;
    }

    const memoryResults = withDetachedTxn(ctx, () => (databases as any).flair.Memory.search(query));
    for await (const record of memoryResults) {
      if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
      if (sinceDate && record.createdAt && new Date(record.createdAt) < sinceDate) continue;
      if (asOf && record.validFrom && record.validFrom > asOf) continue;
      if (asOf && record.validTo && record.validTo <= asOf) continue;
      if (record.validTo && Date.parse(record.validTo) < Date.now()) continue;
      if (!passesAllowed(record)) continue;

      let semanticScore: number;
      if (record.$distance !== undefined) {
        semanticScore = distanceToSimilarity(record.$distance);
      } else {
        // ─── Harper's cosine-sort query omits $distance for a SINGLETON
        // post-filter result set (see resources/SemanticSearch.ts's original
        // writeup of this quirk, and test/integration/
        // semantic-search-singleton-score.test.ts for the real-Harper
        // reproduction). Fix: point-lookup the record by id and compute
        // cosine similarity ourselves from its real stored `embedding`
        // vector. If the stored embedding is missing/empty, cosineSimilarity
        // returns 0 — the same safe "no match" the old `?? 1` fallback
        // produced, never a false-high score.
        const full = await withDetachedTxn(ctx, () => (databases as any).flair.Memory.get(record.id));
        const storedEmbedding = Array.isArray(full?.embedding) ? full.embedding : [];
        semanticScore = cosineSimilarity(qEmb, storedEmbedding);
      }
      let keywordHit = false;
      if (q && String(record.content || "").toLowerCase().includes(String(q).toLowerCase())) {
        keywordHit = true;
      }
      const rawScore = semanticScore + (keywordHit ? 0.05 : 0);

      let finalScore = scoring === "raw" ? rawScore : compositeScore(rawScore, record);
      if (temporalBoost > 1.0) finalScore *= temporalBoost;

      const { $distance, ...rest } = record;
      const isFlagged = rest._safetyFlags && Array.isArray(rest._safetyFlags) && rest._safetyFlags.length > 0;
      const source = record.agentId !== agentId ? record.agentId : undefined;
      results.push({
        ...rest,
        content: isFlagged ? wrapUntrusted(rest.content, source) : rest.content,
        _score: Math.round(finalScore * 1000) / 1000,
        _rawScore: scoring !== "raw" ? Math.round(rawScore * 1000) / 1000 : undefined,
        _source: source,
      });
    }
  } else {
    // ─── No embedding available — keyword-only fallback ──────────────────
    // Full scan is only used when there's no query embedding (e.g. tag-only
    // or subject-only searches, or when the embedding engine is unavailable).
    // Pre-existing, out-of-scope-for-this-PR behavior — MemoryBootstrap never
    // reaches this branch (it only calls in when it already has a
    // queryEmbedding).
    const query: any = conditions.length > 0 ? { conditions } : {};
    const memoryResults = withDetachedTxn(ctx, () => (databases as any).flair.Memory.search(query));
    for await (const record of memoryResults) {
      if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
      if (sinceDate && record.createdAt && new Date(record.createdAt) < sinceDate) continue;
      if (asOf && record.validFrom && record.validFrom > asOf) continue;
      if (asOf && record.validTo && record.validTo <= asOf) continue;
      if (record.validTo && Date.parse(record.validTo) < Date.now()) continue;
      if (!passesAllowed(record)) continue;

      let keywordHit = false;
      if (q && String(record.content || "").toLowerCase().includes(String(q).toLowerCase())) {
        keywordHit = true;
      }
      const rawScore = keywordHit ? 0.05 : 0;
      if (q && rawScore === 0) continue;

      const { embedding, ...rest } = record;
      let finalScore = scoring === "raw" ? rawScore : compositeScore(rawScore, rest);
      if (temporalBoost > 1.0) finalScore *= temporalBoost;

      const isFlagged = rest._safetyFlags && Array.isArray(rest._safetyFlags) && rest._safetyFlags.length > 0;
      const source = record.agentId !== agentId ? record.agentId : undefined;
      results.push({
        ...rest,
        content: isFlagged ? wrapUntrusted(rest.content, source) : rest.content,
        _score: Math.round(finalScore * 1000) / 1000,
        _rawScore: scoring !== "raw" ? Math.round(rawScore * 1000) / 1000 : undefined,
        _source: source,
      });
    }
  }

  // Build superseded set and filter (unless caller opts in to see full
  // history) — computed from THIS bounded result set alone (per-set, never
  // cross-applied — see this PR's supersededIds doc in MemoryBootstrap.ts for
  // the full caveat: the unconditional past-validTo exclusion above is the
  // primary supersede guard; this co-presence check is a secondary belt).
  let filteredResults = results;
  if (!includeSuperseded) {
    const supersededIds = new Set<string>();
    for (const r of results) {
      if (r.supersedes) supersededIds.add(r.supersedes);
    }
    filteredResults = results.filter((r: any) => !supersededIds.has(r.id));
  }

  // Apply minimum score filter
  if (minScore > 0) {
    filteredResults = filteredResults.filter((r: any) => r._score >= minScore);
  }

  filteredResults.sort((a: any, b: any) => b._score - a._score);
  return filteredResults;
}
