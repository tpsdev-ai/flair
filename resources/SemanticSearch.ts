import { Resource, databases } from "harper";
import { resolveAgentAuth, allowVerified } from "./agent-auth.js";
import { getEmbedding, getMode } from "./embeddings-provider.js";
import { patchRecord, withDetachedTxn } from "./table-helpers.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";
import { resolveReadScope } from "./memory-read-scope.js";

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
// tripping this file's rate-limit/hit-tracking side effects. See
// resources/semantic-retrieval-core.ts's module doc for the full boundary.
import { retrieveCandidates, DEFAULT_SELECT } from "./semantic-retrieval-core.js";
import { attachTrust } from "./trust-block.js";
import { bestSemanticSimilarity, evaluateAbstention } from "./abstention.js";

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
    const { agentId: bodyAgentId, q, queryEmbedding, tag, subject, subjects, limit = 10, includeSuperseded = false, scoring = "raw", minScore = 0, since, asOf, includeTrust = false, includeMetadata = false, abstain = false, explain = false, includeLegs = false, includeArchived = false } = data || {};

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
      // flair#1245: a text-derived temporal match must ONLY nudge recency in
      // ranking (temporalBoost, a soft multiplier applied in
      // semantic-retrieval-core.ts) — it must NEVER derive a hard `sinceDate`
      // exclusion. An incidental temporal word in the query TEXT (the #1245
      // canary carried "today" inside a slogan) otherwise silently dropped
      // every candidate older than the window → 0 results. Only the explicit
      // `since` API param (set above, untouched here) still hard-filters.
      if (/\btoday\b|\bthis morning\b|\bthis afternoon\b/.test(lq)) {
        temporalBoost = 1.5;
      } else if (/\byesterday\b/.test(lq)) {
        temporalBoost = 1.3;
      } else if (/\bthis week\b|\blast few days\b/.test(lq)) {
        temporalBoost = 1.2;
      } else if (/\blast week\b/.test(lq)) {
        temporalBoost = 1.1;
      } else if (/\brecently\b|\blately\b/.test(lq)) {
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
    // flair#1472 — `includeArchived` opts back IN to the basement: when true the
    // archived predicate is omitted entirely, so basemented memories are returned
    // under the SAME read-scope gate as a normal search (never a wider scope).
    if (!includeArchived) {
      conditions.push({ attribute: "archived", comparator: "not_equal", value: true });
    }

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

    // ─── Explain mode: return Harper's ENGINE-LEVEL query plan ────────────
    // When explain=true, construct the same search query that the HNSW leg
    // would use and pass explain:true through to Harper's Table.search().
    // Harper's cost-based planner re-sorts conditions by estimated count at
    // execution (the scope OR-group estimates Infinity and can never drive;
    // a selective tags-equals wins the seek). The returned plan shows the
    // ENGINE's chosen order — the proof the spec requires.
    //
    // No search is executed; no side effects (rate-limit, hit-tracking).
    if (explain) {
      const ctx = (this as any).getContext?.();
      const explainQuery: any = {
        sort: qEmb ? { attribute: "embedding", target: qEmb, distance: "cosine" } : undefined,
        select: DEFAULT_SELECT,
        limit,
        explain: true,
      };
      if (conditions.length > 0) explainQuery.conditions = conditions;
      const plan = withDetachedTxn(ctx, () =>
        (databases as any).flair.Memory.search(explainQuery)
      );
      return {
        explain: true,
        plan,
        tag,
        scoring,
      };
    }

    const hybrid = hybridEnabled();

    // The overfetch policy (how many raw candidates to pull from the
    // HNSW/BM25 legs relative to what the caller ultimately wants) is THIS
    // wrapper's decision — retrieveCandidates() never multiplies its `limit`
    // param internally (see resources/semantic-retrieval-core.ts's doc), so
    // every caller (this one, and MemoryBootstrap's own K formula) computes
    // its own fetch depth. Both the hybrid path (CANDIDATE_MULTIPLIER on the
    // semantic leg + SEM_LIMIT on the BM25 leg, fused by RRF) and the legacy
    // vector-only path overfetch by the same multiplier, which is what gives
    // composite re-scoring headroom to reorder before the final slice.
    const candidateLimit = limit * CANDIDATE_MULTIPLIER;

    const ctx = (this as any).getContext?.();

    let legs: { hnsw: string[]; bm25: string[]; fused: string[] } | undefined;
    const filteredResults = await retrieveCandidates({
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
      onLegs: includeLegs ? (l) => { legs = l; } : undefined,
      // flair#744 slice 1: the trust block needs `provenance`, which the
      // default projection omits. Widen the select ONLY when the caller opts
      // in — passing undefined otherwise keeps the default (no `provenance`)
      // so a non-trust recall response stays byte-identical.
      //
      // flair#1332: same idiom for the client-writable `metadata` JSON blob
      // (ADK custom_metadata store-and-return). DEFAULT_SELECT deliberately
      // does NOT grow it (K&S projection ruling — the shared retrieval core
      // serves every consumer, and none of the others should pay result-size
      // for an opaque blob they never read); adk-flair opts in per-request
      // with `includeMetadata: true`. `subject` needs no widening — it is
      // already in DEFAULT_SELECT. Neither flag ⇒ select stays undefined ⇒
      // response bytes unchanged.
      select: (includeTrust || includeMetadata)
        ? [...DEFAULT_SELECT,
           ...(includeTrust ? ["provenance"] : []),
           ...(includeMetadata ? ["metadata"] : [])]
        : undefined,
      // flair#744 slice 2 + confidence-band refinement: attach the absolute
      // per-result cosine confidence when the caller opts into abstention OR
      // the trust block — abstention reads the best of it for its verdict, and
      // the trust block classifies each result's into a `matchQuality` band
      // (Kern BINDING condition 2: matchQuality needs `_semSimilarity`, so
      // includeTrust must also turn this on). Neither flag ⇒ result objects stay
      // byte-identical (no `_semSimilarity` attached).
      withSemSimilarity: abstain || includeTrust,
    });

    // ─── flair#744 slice 2 — first-class abstention ("no memory covers this")
    // Opt-in only. Evaluated on the RETRIEVED candidate pool, BEFORE the final
    // slice / hit-tracking, so an abstaining recall never bumps retrievalCount
    // for memories it declines to surface. The decision reads ONLY the best
    // absolute semantic similarity
    // (never any principal/authority signal — abstention.ts is pure and
    // authority-free), against the single GLOBAL threshold. Default OFF ⇒ this
    // whole block is skipped and the response is byte-identical to pre-slice-2.
    let abstention: ReturnType<typeof evaluateAbstention> | null = null;
    if (abstain) {
      abstention = evaluateAbstention(bestSemanticSimilarity(filteredResults));
      if (abstention.abstained) {
        return {
          abstained: true,
          reason: abstention.reason,
          bestScore: abstention.bestScore,
          threshold: abstention.threshold,
          results: [],
        };
      }
    }

    // retrieveCandidates() already returns its output sorted best-first
    // (whichever leg produced it — legacy HNSW-only, the BM25+union-RRF hybrid
    // path, or the keyword-only fallback all converge into the same shape), so
    // the final slice needs no additional sort. A cross-encoder rerank stage
    // used to sit here and reorder the pool before this slice; it was removed
    // in flair#893 after measuring Δp@3 = 0.000 at 4.1× query latency.
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
    //
    // Order matters (confidence-band refinement): attachTrust must run BEFORE
    // the `_semSimilarity` strip below, because buildTrustBlock reads that field
    // off the record to classify `matchQuality`. attachTrust returns a shallow
    // copy carrying `trust` (and still-present `_semSimilarity`); the strip then
    // drops the internal field from the copy.
    const trusted = includeTrust ? topResults.map((r: any) => attachTrust(r, true)) : topResults;
    // flair#744 slice 2 + refinement: strip the internal `_semSimilarity`
    // confidence field from the consumer-facing results — it exists ONLY to feed
    // the abstention decision and the matchQuality classification, never the
    // response shape. Attached whenever abstain OR includeTrust turned
    // withSemSimilarity on, so strip in both cases. A no-op (and byte-identical)
    // when neither flag is set (the field was never attached).
    const results = (abstain || includeTrust)
      ? trusted.map(({ _semSimilarity, ...r }: any) => r)
      : trusted;

    // Surface degradation warning when semantic search was unavailable
    const response: any = { results };
    // flair#744 slice 2: in opt-in abstain mode that did NOT abstain, carry the
    // (negative) verdict so a consumer building against the abstention shape
    // always reads a stable `abstained`/`bestScore`/`threshold`. Absent when
    // abstain is off ⇒ byte-identical to pre-slice-2.
    if (abstention) {
      response.abstained = abstention.abstained;
      response.bestScore = abstention.bestScore;
      response.threshold = abstention.threshold;
    }
    if (!qEmb && q && getMode() === "none") {
      response._warning = "semantic search unavailable — results are keyword-only";
    }
    // flair#1358: opt-in per-leg candidate ids for the bench instrument.
    // Default OFF ⇒ response is byte-identical (no `legs` key). The ranked
    // `results` slice is unchanged either way — this is observation only.
    if (includeLegs && legs) response.legs = legs;

    return response;
  }
}
