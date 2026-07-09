import { Resource, databases } from "@harperfast/harper";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";
import { getEmbedding, getMode } from "./embeddings-provider.js";
import { patchRecord, withDetachedTxn } from "./table-helpers.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";
import { wrapUntrusted } from "./content-safety.js";
import { resolveReadScope } from "./memory-read-scope.js";
import { cosineSimilarity } from "./dedup.js";
import {
  isRerankEnabled,
  getRerankTopN,
  getRerankBudgetMs,
  getRerankMinCandidates,
  rerankCandidates,
} from "./rerank-provider.js";

// Temporal decay + relevance scoring (incl. the OPS-AYGD retrievalBoost cap +
// relevance floor) lives in ./scoring.ts — a Harper-free module so it can be
// unit-tested directly (see test/unit/temporal-scoring.test.ts).
import { compositeScore } from "./scoring.js";

// BM25 + union-RRF hybrid retrieval (FLAIR-BM25-HYBRID-RETRIEVAL).
// Harper-free modules so the BM25 scoring, the candidate-union RRF, and the
// SECURITY conditions-filter are unit-tested against the shipped code.
import { buildBM25, fuseRrfNormalized, hybridEnabled, SEM_LIMIT } from "./bm25.js";
import { isAllowedBm25Candidate, type Condition } from "./bm25-filter.js";

// Convert HNSW cosine distance (1 - similarity) to similarity score
function distanceToSimilarity(distance: number): number {
  return 1 - distance;
}

// Candidate multiplier: fetch more candidates than needed from the HNSW index
// so composite re-ranking has enough headroom to reorder results.
const CANDIDATE_MULTIPLIER = 5;

// The BM25 + union-RRF hybrid path is feature-flagged via hybridEnabled()
// (imported from ./bm25 — Harper-free so it's unit-testable). Default is ON as
// of 2026-07-08 (see ./bm25.ts's hybridEnabled() doc); set
// FLAIR_HYBRID_RETRIEVAL=false to revert to the legacy HNSW + +0.05
// keyword-bump path, byte-identical to the original pre-hybrid behavior.

export class SemanticSearch extends Resource {
  // Self-authorize via the Ed25519 agent verify instead of relying on the auth
  // gate's admin super_user elevation (removed in the auth reshape). Any
  // cryptographically-verified agent may search; per-agent RESULT scoping is
  // enforced in post() below (an agent only sees its own memories, any
  // visibility, plus granted owners' SHARED memories — never their private
  // ones). Without this, Harper's default denies the POST for the
  // least-privilege flair_agent role (AccessViolation 403).
  async allowCreate(): Promise<boolean> {
    return allowVerified((this as any).getContext?.());
  }

  async post(data: any) {
    const { agentId: bodyAgentId, q, queryEmbedding, tag, subject, subjects, limit = 10, includeSuperseded = false, scoring = "composite", minScore = 0, since, asOf } = data || {};

    // Authenticated identity lives on the Harper Resource context (getContext().request).
    // `this.request` is NOT populated on Harper v5 Resources — prior reads here
    // silently returned undefined and the defense-in-depth scope check below
    // was bypassed, letting a non-admin agent read another agent's memories
    // by putting the victim's id in the body.
    const auth = await resolveAgentAuth((this as any).getContext?.());

    // Anonymous HTTP must NOT search. Previously the no-auth path fell through to
    // honoring the body-supplied agentId (line below), so an unauthenticated
    // caller could read any agent's memories by putting that id in the body.
    if (auth.kind === "anonymous") {
      return new Response(JSON.stringify({ error: "authentication required" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }

    const authenticatedAgent: string | undefined = auth.kind === "agent" ? auth.agentId : undefined;
    const callerIsAdmin: boolean = auth.kind === "agent" && auth.isAdmin;

    // Rate limiting — use authenticated agent ID (internal calls have none).
    if (authenticatedAgent) {
      const bucket = q && !queryEmbedding ? "embedding" : "general";
      const rl = checkRateLimit(authenticatedAgent, bucket);
      if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs!, "search");
    }

    const subjectFilter = subjects
      ? new Set((subjects as string[]).map((s: string) => s.toLowerCase()))
      : subject
        ? new Set([(subject as string).toLowerCase()])
        : null;

    // Enforce agentId = authenticated agent for non-admins. A mismatched body
    // agentId is a cross-agent read attempt — reject outright. Admins can query
    // any agentId (bootstrap / consolidation).
    if (authenticatedAgent && !callerIsAdmin && bodyAgentId && bodyAgentId !== authenticatedAgent) {
      return new Response(JSON.stringify({
        error: "forbidden: agentId must match authenticated agent",
      }), { status: 403, headers: { "Content-Type": "application/json" } });
    }

    // Scope: non-admin agent → own (+ granted). Admin agent or trusted internal
    // call (no request) → honor the body-supplied agentId.
    const agentId: string | undefined = (authenticatedAgent && !callerIsAdmin)
      ? authenticatedAgent
      : bodyAgentId;

    // Read-scope: own (any visibility) + granted owners' SHARED memories only
    // (Layer 1). Centralized in resolveReadScope() — this used to be
    // an inline grant-resolution loop here PLUS a `visibility === "office"`
    // global OR-clause below that leaked ANY authenticated agent's read of
    // ANY other agent's office-visible memories. Both are gone;
    // this is the ONE scoping resolution for this endpoint now.
    const scope = agentId ? await resolveReadScope(agentId) : null;

    // Generate query embedding
    let qEmb = queryEmbedding;
    if (!qEmb && q) {
      // Always attempt embedding generation — getEmbedding() handles init internally.
      // Don't gate on getMode() which may return "none" before init completes in worker threads.
      try { qEmb = await getEmbedding(String(q).slice(0, 8000)); } catch {}
    }

    // ─── Temporal intent detection ────────────────────────────────────────────
    let sinceDate: Date | null = since ? new Date(since) : null;
    let temporalBoost = 1.0;
    if (q && !sinceDate) {
      const lq = String(q).toLowerCase();
      if (/\btoday\b|\bthis morning\b|\bthis afternoon\b/.test(lq)) {
        const d = new Date(); d.setHours(0, 0, 0, 0);
        sinceDate = d;
        temporalBoost = 1.5;
      } else if (/\byesterday\b/.test(lq)) {
        const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0);
        sinceDate = d;
        temporalBoost = 1.3;
      } else if (/\bthis week\b|\blast few days\b/.test(lq)) {
        sinceDate = new Date(Date.now() - 7 * 24 * 3600_000);
        temporalBoost = 1.2;
      } else if (/\blast week\b/.test(lq)) {
        sinceDate = new Date(Date.now() - 14 * 24 * 3600_000);
        temporalBoost = 1.1;
      } else if (/\brecently\b|\blately\b/.test(lq)) {
        sinceDate = new Date(Date.now() - 3 * 24 * 3600_000);
        temporalBoost = 1.3;
      }
    }

    // ─── Build conditions for Harper query ──────────────────────────────────
    const conditions: any[] = [];

    // Agent scoping: own (any visibility) OR granted-owner's SHARED memories
    // (private-exclusion) — the centralized read-scope condition. No agentId
    // → no scoping condition pushed (trusted internal call / admin without a
    // target agentId — matches the pre-existing unscoped fallback).
    if (scope) {
      conditions.push(scope.condition);
    }

    // Exclude archived records. Use "not_equal" (Harper v5 comparator) instead of
    // "equals false" so records without the archived field are included.
    conditions.push({ attribute: "archived", comparator: "not_equal", value: true });

    if (tag) {
      conditions.push({ attribute: "tags", comparator: "equals", value: tag });
    }
    if (subjectFilter) {
      const subjects = [...subjectFilter];
      if (subjects.length === 1) {
        conditions.push({ attribute: "subject", comparator: "equals", value: subjects[0] });
      } else {
        conditions.push({
          operator: "or",
          conditions: subjects.map(s => ({ attribute: "subject", comparator: "equals", value: s })),
        });
      }
    }

    const results: any[] = [];
    const hybrid = hybridEnabled();

    // When the reranker is on, widen the legacy HNSW fetch so it has a deeper
    // pool to re-score (retrieve topN → rerank → slice to limit). Decoupled
    // from CANDIDATE_MULTIPLIER so composite re-ranking keeps its existing
    // headroom. Scoped to the legacy (non-hybrid) vector path below — the
    // hybrid path's candidate pool is already governed by CANDIDATE_MULTIPLIER
    // (semantic leg) + SEM_LIMIT (BM25 leg) via RRF union; the
    // reranker still applies to its output further down regardless of which
    // path produced `filteredResults`.
    const rerankOn = isRerankEnabled();
    const rerankTopN = getRerankTopN();

    if (hybrid) {
      // ─── BM25 + union-RRF hybrid path ────────────────────────────────────
      // 1. Semantic candidates via HNSW (unchanged fetch). 2. BM25 lexical pass
      //    over the SCOPED corpus. 3. SECURITY: the BM25 candidate set is filtered
      //    by the SAME conditions[] + temporal filters BEFORE fusion (the corpus
      //    is fetched with those conditions, AND re-checked in-process as
      //    defense-in-depth) so no other agent's memory is ever scored or fused.
      //    4. Candidate-union RRF → normalize → feed as rawScore to compositeScore.
      const ctx = (this as any).getContext?.();

      // ── (a) Semantic candidate records (best-first) ──────────────────────
      // Same HNSW query as the legacy path; we keep the raw records so the BM25
      // pass + fusion can re-derive rawScore. No embedding → empty semantic list
      // (RRF degrades naturally to BM25-only).
      const semRecords: any[] = [];
      const semIds: string[] = [];
      if (qEmb) {
        const candidateLimit = limit * CANDIDATE_MULTIPLIER;
        const semQuery: any = {
          sort: { attribute: "embedding", target: qEmb, distance: "cosine" },
          select: ["id", "agentId", "content", "contentHash", "visibility", "tags", "durability",
            "source", "createdAt", "updatedAt", "expiresAt", "retrievalCount", "lastRetrieved",
            "promotionStatus", "promotedAt", "promotedBy", "archived", "archivedAt", "archivedBy",
            "parentId", "derivedFrom", "sessionId", "lastReflected", "supersedes", "subject",
            "validFrom", "validTo", "_safetyFlags", "$distance"],
          limit: candidateLimit,
        };
        if (conditions.length > 0) semQuery.conditions = conditions;
        const semResults = withDetachedTxn(ctx, () => (databases as any).flair.Memory.search(semQuery));
        for await (const record of semResults) {
          // Same per-record temporal gate as the legacy HNSW loop.
          if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
          if (sinceDate && record.createdAt && new Date(record.createdAt) < sinceDate) continue;
          if (asOf && record.validFrom && record.validFrom > asOf) continue;
          if (asOf && record.validTo && record.validTo <= asOf) continue;
          // Unconditional past-validTo exclusion (see legacy HNSW
          // loop below for the full rationale) — applies regardless of asOf.
          if (record.validTo && Date.parse(record.validTo) < Date.now()) continue;
          semRecords.push(record);
          semIds.push(record.id);
        }
      }

      // ── (b) BM25 candidate records over the SCOPED corpus ────────────────
      // SECURITY: fetch the corpus WITH the same conditions[] so Harper applies
      // the agent boundary, then re-apply the identical predicate + temporal
      // filters in-process (isAllowedBm25Candidate) BEFORE building/scoring the
      // index. The BM25 index therefore only ever contains the caller's allowed
      // memories — no other agent's content/term-frequency enters scoring or
      // fusion. This is the conditions-filter-before-fusion gate.
      // Explicit select (same fields as the HNSW path, no embedding / $distance)
      // so the large embedding vector is never fetched into the BM25 corpus and
      // never spread into a result payload.
      const corpusSelect = ["id", "agentId", "content", "contentHash", "visibility", "tags", "durability",
        "source", "createdAt", "updatedAt", "expiresAt", "retrievalCount", "lastRetrieved",
        "promotionStatus", "promotedAt", "promotedBy", "archived", "archivedAt", "archivedBy",
        "parentId", "derivedFrom", "sessionId", "lastReflected", "supersedes", "subject",
        "validFrom", "validTo", "_safetyFlags"];
      const corpusQuery: any = conditions.length > 0
        ? { conditions, select: corpusSelect }
        : { select: corpusSelect };
      const corpusResults = withDetachedTxn(ctx, () => (databases as any).flair.Memory.search(corpusQuery));
      const allowedById = new Map<string, any>();
      const bm25Docs: { id: string; content?: string }[] = [];
      for await (const record of corpusResults) {
        // Defense-in-depth: re-check the SAME conditions[] + temporal filters
        // in-process. Even if a Harper query change ever let an out-of-scope
        // record through, it is dropped here BEFORE it can be BM25-scored/fused.
        if (!isAllowedBm25Candidate(record, conditions as Condition[], { sinceDate, asOf })) continue;
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
        // Drop zero-score docs (no query-term overlap → contribute nothing) and
        // cap at SEM_LIMIT — the production BM25 candidate window.
        bm25Ids = ranked.filter(r => r.score > 0).slice(0, SEM_LIMIT).map(r => r.id);
      }

      // ── (d) No retrieval signal at all → full scoped listing ────────────
      // Neither `q` nor `qEmb`: semIds and bm25Ids are BOTH necessarily empty
      // (semIds is only populated `if (qEmb)`; bm25Ids only `if (q)`), so
      // fuseRrfNormalized([], []) returns an empty map and the union-RRF loop
      // below would silently emit ZERO results — unlike the legacy path's
      // final no-embedding branch, which full-scans and returns every
      // scope-matching record (rawScore 0 when there's no keyword hit,
      // included because `if (q && rawScore === 0) continue` only fires when
      // `q` is truthy). This is the "list everything in my scope" call
      // real callers rely on (e.g. SemanticSearch with only `agentId`/`tag`/
      // `subject` — see test/integration/memory-visibility-scoping-e2e.test.ts),
      // and it must behave identically whether the hybrid flag is on or off.
      // `allowedById` already holds exactly the right candidate set (built
      // from the SAME conditions[] + isAllowedBm25Candidate temporal/security
      // filters as the BM25 pass), so emit it directly at rawScore 0 instead
      // of routing through the (necessarily-empty) RRF fusion.
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
        // Union dedupes semantic ∪ bm25 ids; absent-from-a-list = 0 contribution.
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
      // ─── HNSW vector search path (legacy, hybrid flag OFF) ────────────────
      const candidateLimit = rerankOn
        ? Math.max(limit * CANDIDATE_MULTIPLIER, rerankTopN)
        : limit * CANDIDATE_MULTIPLIER;
      const query: any = {
        sort: { attribute: "embedding", target: qEmb, distance: "cosine" },
        select: ["id", "agentId", "content", "contentHash", "visibility", "tags", "durability",
          "source", "createdAt", "updatedAt", "expiresAt", "retrievalCount", "lastRetrieved",
          "promotionStatus", "promotedAt", "promotedBy", "archived", "archivedAt", "archivedBy",
          "parentId", "derivedFrom", "sessionId", "lastReflected", "supersedes", "subject",
          "validFrom", "validTo", "_safetyFlags", "$distance"],
        limit: candidateLimit,
      };
      if (conditions.length > 0) {
        query.conditions = conditions;
      }

      // MemoryGrant.search above left a closed transaction in ctx's chain —
      // detach it so Harper builds a fresh transaction for this Memory read.
      const ctx = (this as any).getContext?.();
      const memoryResults = withDetachedTxn(ctx, () => (databases as any).flair.Memory.search(query));
      for await (const record of memoryResults) {
        if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
        if (sinceDate && record.createdAt && new Date(record.createdAt) < sinceDate) continue;
        // Temporal validity: if asOf is specified, only include memories valid at that point
        if (asOf && record.validFrom && record.validFrom > asOf) continue;
        if (asOf && record.validTo && record.validTo <= asOf) continue;
        // A past validTo ALWAYS means the record has been closed out
        // (server supersede path — Memory.ts closeSupersededRecord — sets
        // validTo without necessarily setting `archived`). Unconditional, not
        // gated on `asOf`, so a server-superseded record can't resurface in
        // the DEFAULT recall path just because its successor isn't
        // co-present in this result set (the supersededIds filter further
        // down only catches co-presence). A record with no validTo, or a
        // future validTo, is unaffected.
        if (record.validTo && Date.parse(record.validTo) < Date.now()) continue;

        let semanticScore: number;
        if (record.$distance !== undefined) {
          semanticScore = distanceToSimilarity(record.$distance);
        } else {
          // ─── Harper's cosine-sort query omits $distance for a
          // SINGLETON post-filter result set — the SAME quirk root-caused and
          // fixed for the dedup path (resources/Memory.ts
          // findConservativeDedupMatch / resources/dedup.ts cosineSimilarity).
          // Sort ORDER is still correct; only the numeric `$distance`
          // annotation is missing on that one record, regardless of the
          // query's own `limit` (reproduced here with candidateLimit=50, not
          // just limit=1 — the trigger is the post-filter MATCH COUNT, not the
          // requested limit).
          //
          // Layer 1 made this common: the no-grants agent scope used
          // to ALWAYS be a compound `{operator:"or", conditions:[{agentId},
          // {visibility=="office"}]}` condition; resolveReadScope() now emits
          // a PLAIN single `{agentId==X}` condition for the common (no-grants)
          // case, so a scoped search against an agent with exactly one
          // matching memory hits this Harper quirk directly. Before, the OR
          // wrap incidentally avoided the singleton shape. The old `?? 1`
          // fallback silently collapsed this to similarity 0 — read by
          // callers (including the clean-VM CI gate's single-memory init
          // probe, #533) as "embeddings not loaded", which is WRONG:
          // embeddings ARE loaded, only the score was computed incorrectly.
          //
          // Fix: point-lookup the record by id (a plain get(), unaffected by
          // the sort-query quirk — selecting "embedding" directly on the SAME
          // sort-by-embedding query comes back as a bare scalar, per the same
          // investigation above) and compute cosine similarity ourselves in JS from its
          // real stored `embedding` vector against this query's `qEmb`, via
          // the same math as the ume4 fallback (dedup.ts's cosineSimilarity).
          // Only done on this (rare) undefined-$distance branch — never adds
          // a point-lookup to the normal per-record path. If the stored
          // embedding is missing/empty (e.g. a legacy pre-embedding record),
          // cosineSimilarity returns 0 — the same safe "no match" the old
          // `?? 1` fallback produced, never a false-high score.
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
      const query: any = conditions.length > 0 ? { conditions } : {};
      // MemoryGrant.search above left a closed transaction in ctx's chain —
      // detach it so Harper builds a fresh transaction for this Memory read.
      const ctx = (this as any).getContext?.();
      const memoryResults = withDetachedTxn(ctx, () => (databases as any).flair.Memory.search(query));
      for await (const record of memoryResults) {
        if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
        if (sinceDate && record.createdAt && new Date(record.createdAt) < sinceDate) continue;
        if (asOf && record.validFrom && record.validFrom > asOf) continue;
        if (asOf && record.validTo && record.validTo <= asOf) continue;
        // Unconditional past-validTo exclusion (see legacy HNSW
        // loop above for the full rationale) — applies regardless of asOf.
        if (record.validTo && Date.parse(record.validTo) < Date.now()) continue;

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

    // Build superseded set and filter (unless caller opts in to see full history)
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

    // ─── Cross-encoder rerank (best-effort, fail-open to vector order) ───────
    // Re-scores query+candidate TOGETHER (cross-attention the pooled embedding
    // can't do) and reorders before the final slice. Reorders whatever
    // `filteredResults` the retrieval stage above produced — legacy HNSW-only
    // OR the BM25+union-RRF hybrid path — since both converge into
    // the same `results`/`filteredResults` shape before this point; hybrid
    // retrieves+fuses, the reranker only reorders the fused set. Still gated
    // on `qEmb` (an embedding was actually generated); the pure keyword-only
    // fallback (no qEmb at all) is untouched either way. The reranker
    // overwrites `_score` with the rerank score (so margin measurement reads it)
    // and preserves the semantic score as `_semScore`; `_rawScore` is left as-is
    // so recall-bench's scoring:"raw" path stays reproducible. On init failure,
    // timeout, or any throw, rerankCandidates returns the input UNCHANGED and we
    // fall through to the existing vector-order sort — recall is never blocked.
    if (rerankOn && qEmb && q && filteredResults.length >= getRerankMinCandidates()) {
      // Pre-sort by vector order so the topN fed to the reranker is the most
      // semantically-promising slice (filteredResults isn't sorted yet here).
      filteredResults.sort((a: any, b: any) => b._score - a._score);
      filteredResults = await rerankCandidates(String(q), filteredResults, {
        topN: rerankTopN,
        budgetMs: getRerankBudgetMs(),
      });
    } else {
      filteredResults.sort((a: any, b: any) => b._score - a._score);
    }
    const topResults = filteredResults.slice(0, limit);

    // Async hit tracking — don't block the response
    const now = new Date().toISOString();
    for (const r of topResults) {
      patchRecord((databases as any).flair.Memory, r.id, {
        retrievalCount: (r.retrievalCount || 0) + 1,
        lastRetrieved: now,
      }).catch(() => {});
    }

    // Surface degradation warning when semantic search was unavailable
    const response: any = { results: topResults };
    if (!qEmb && q && getMode() === "none") {
      response._warning = "semantic search unavailable — results are keyword-only";
    }

    return response;
  }
}
