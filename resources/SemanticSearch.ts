import { Resource, databases } from "@harperfast/harper";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";
import { getEmbedding, getMode } from "./embeddings-provider.js";
import { patchRecord } from "./table-helpers.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";
import { resolveReadScope } from "./memory-read-scope.js";
import {
  isRerankEnabled,
  getRerankTopN,
  getRerankBudgetMs,
  getRerankMinCandidates,
  rerankCandidates,
} from "./rerank-provider.js";

// The BM25 + union-RRF hybrid path is feature-flagged via hybridEnabled()
// (imported from ./bm25 — Harper-free so it's unit-testable). Default is ON as
// of 2026-07-08 (see ./bm25.ts's hybridEnabled() doc); set
// FLAIR_HYBRID_RETRIEVAL=false to revert to the legacy HNSW + +0.05
// keyword-bump path, byte-identical to the original pre-hybrid behavior.
import { hybridEnabled } from "./bm25.js";

// The actual HNSW/BM25 retrieval + post-retrieval filtering (temporal/
// supersede/isAllowed) now lives in the pure, side-effect-free
// retrieveCandidates() core (flair-bootstrap-scale-fix, Kern-approved
// extraction) — MemoryBootstrap.ts calls the SAME core bare, without
// tripping this file's rate-limit/reranker/hit-tracking side effects. See
// resources/semantic-retrieval-core.ts's module doc for the full boundary.
import { retrieveCandidates, DEFAULT_SELECT } from "./semantic-retrieval-core.js";
import { attachTrust } from "./trust-block.js";

// Candidate multiplier: fetch more candidates than needed from the HNSW index
// so composite re-ranking has enough headroom to reorder results.
const CANDIDATE_MULTIPLIER = 5;

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
    // Default scoring is "raw", not "composite" (flair#623 follow-up, measured
    // 2026-07-08). recall-eval on the live corpus with BM25 hybrid retrieval
    // active (default since eb26890) showed composite was net-HARMFUL at the
    // time: Δp@3 (composite − raw) = -0.38 to -0.50 across repeated runs, MRR
    // 0.44→0.06-0.44. Root cause: compositeScore's durability-weight ×
    // recency-decay multiplier applied UNCONDITIONALLY (no relevance gate,
    // unlike retrievalBoost's RBOOST_RELEVANCE_FLOOR), so a `permanent`
    // -durability or freshly-created LOW-relevance record could outrank the
    // objectively best-matching `persistent`/older record. Now that BM25+RRF
    // fusion normalizes rawScore into a tight [0,1] band, an unbounded
    // durability/recency multiplier is often bigger than the actual relevance
    // gap between candidates.
    //
    // FIXED (flair#623 follow-up, 2026-07-08, see ./scoring.ts's
    // COMPOSITE_DISCOUNT_FLOOR / COMPOSITE_RELEVANCE_FLOOR): compositeScore's
    // durability/recency multiplier is now bounded to a small (~2%) nudge and
    // relevance-gated, the same way RBOOST_CAP/RBOOST_RELEVANCE_FLOOR already
    // bound the retrieval-popularity boost — `scoring: "composite"` no longer
    // reproduces the magnet/inversion bug (recall-harness: p@3 and MRR both
    // now match raw exactly on its 87-record corpus). The default REMAINS
    // "raw" anyway: on that same corpus, a relevance-gated composite only
    // MATCHES raw's precision, it doesn't beat it, so there is no measured
    // upside to switching the default, only the (now-closed) downside risk
    // for anyone who explicitly opts into "composite". Re-run
    // recall-harness (test/bench/recall-harness/run.ts) and `recall-eval.mjs`
    // before reconsidering this default if the compositeScore formula or
    // corpus changes.
    const { agentId: bodyAgentId, q, queryEmbedding, tag, subject, subjects, limit = 10, includeSuperseded = false, scoring = "raw", minScore = 0, since, asOf, includeTrust = false } = data || {};

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
      // flair#504 Phase 2: 'query' — this is a search query, not stored content.
      try { qEmb = await getEmbedding(String(q).slice(0, 8000), "query"); } catch {}
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

    // The overfetch policy (how many raw candidates to pull from the
    // HNSW/BM25 legs relative to what the caller ultimately wants) is THIS
    // wrapper's decision — retrieveCandidates() never multiplies its `limit`
    // param internally (see resources/semantic-retrieval-core.ts's doc), so
    // every caller (this one, and MemoryBootstrap's own K formula) computes
    // its own fetch depth. Hybrid's semantic leg is never rerank-widened
    // (matches the pre-extraction behavior: only the legacy path widened for
    // rerank).
    const candidateLimit = hybrid
      ? limit * CANDIDATE_MULTIPLIER
      : (rerankOn ? Math.max(limit * CANDIDATE_MULTIPLIER, rerankTopN) : limit * CANDIDATE_MULTIPLIER);

    const ctx = (this as any).getContext?.();

    let filteredResults = await retrieveCandidates({
      queryEmbedding: qEmb,
      q,
      conditions,
      limit: candidateLimit,
      includeSuperseded,
      scoring,
      temporalBoost,
      sinceDate,
      asOf,
      minScore,
      agentId,
      isAllowed: scope?.isAllowed,
      hybrid,
      ctx,
      // flair#744 slice 1: the trust block needs `provenance`, which the
      // default projection omits. Widen the select ONLY when the caller opts
      // in — passing undefined otherwise keeps the default (no `provenance`)
      // so a non-trust recall response stays byte-identical.
      select: includeTrust ? [...DEFAULT_SELECT, "provenance"] : undefined,
    });

    // ─── Cross-encoder rerank (best-effort, fail-open to vector order) ───────
    // Re-scores query+candidate TOGETHER (cross-attention the pooled embedding
    // can't do) and reorders before the final slice. Reorders whatever
    // `filteredResults` retrieveCandidates() produced — legacy HNSW-only OR
    // the BM25+union-RRF hybrid path — since both converge into the same
    // shape (retrieveCandidates never exposes which leg produced a result).
    // Still gated on `qEmb` (an embedding was actually generated); the pure
    // keyword-only fallback (no qEmb at all) is untouched either way. The
    // reranker overwrites `_score` with the rerank score (so margin
    // measurement reads it) and preserves the semantic score as `_semScore`;
    // `_rawScore` is left as-is so recall-bench's scoring:"raw" path stays
    // reproducible. On init failure, timeout, or any throw, rerankCandidates
    // returns the input UNCHANGED and we fall through to retrieveCandidates'
    // own vector-order sort — recall is never blocked. retrieveCandidates
    // already returns its output sorted best-first, so the non-rerank branch
    // needs no additional sort here.
    if (rerankOn && qEmb && q && filteredResults.length >= getRerankMinCandidates()) {
      filteredResults = await rerankCandidates(String(q), filteredResults, {
        topN: rerankTopN,
        budgetMs: getRerankBudgetMs(),
      });
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

    // flair#744 slice 1 — opt-in inline trust-evidence block. Assembled HERE,
    // in the response tail, strictly AFTER read-scope resolution
    // (retrieveCandidates + scope.isAllowed already ran) and purely for the
    // response — it never feeds back into any authority/scope/attribution/dedup
    // decision (the #735-spirit zero-authority invariant; structurally guarded
    // by test/unit/trust-block-zero-authority-tripwire.test.ts). Default OFF ⇒
    // `results` is the untouched `topResults`, byte-identical to pre-slice-1.
    const results = includeTrust ? topResults.map((r: any) => attachTrust(r, true)) : topResults;

    // Surface degradation warning when semantic search was unavailable
    const response: any = { results };
    if (!qEmb && q && getMode() === "none") {
      response._warning = "semantic search unavailable — results are keyword-only";
    }

    return response;
  }
}
