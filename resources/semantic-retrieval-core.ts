// ─── retrieveCandidates() — the pure retrieval core (flair bootstrap-scale-fix) ──
//
// Extracted from resources/SemanticSearch.ts's post() (Kern-approved
// refactor, flair#695). Before this module existed,
// SemanticSearch.post() was one function entangling auth resolution,
// rate-limiting, HNSW/BM25 retrieval, post-retrieval filtering, AND
// retrievalCount/lastRetrieved hit-tracking side
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
// resolution, rate-limiting, or the retrievalCount/lastRetrieved
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
// Returns results AFTER all filters, sorted best-first by RETRIEVAL RANK —
// bounded ONLY by the `limit` the caller chose to push down (the core never
// multiplies `limit` internally; any overfetch policy — SemanticSearch's
// CANDIDATE_MULTIPLIER, MemoryBootstrap's K formula — is the CALLER's
// decision, made
// before calling in). Never exposes which internal leg (BM25+RRF hybrid vs.
// legacy HNSW-only vs. keyword-only fallback) produced a given result — the
// output shape is identical regardless of `hybrid`.
//
// ── SCORE CONTRACT (flair#985) ───────────────────────────────────────────────
// `_score` under `scoring:"raw"` is ALWAYS an ABSOLUTE similarity (cosine of
// the query and the record's stored embedding, plus the legacy +0.05 substring
// keyword bump) — on every path, hybrid included. It is NEVER a
// rank-normalized value. Ordering and score are deliberately decoupled on the
// hybrid path: results are ORDERED by the fused RRF rank (that ordering is the
// hybrid recall win), but each result's `_score` reports its true evidence, so
// order and `_score` can disagree. The pre-#985 hybrid path reported the
// normalized RRF value AS `_score`, which pinned the top result of ANY query
// at 1.0 — and every consumer thresholding `_score` as a similarity (the
// pre-0.18 flair-client dedup gate at 0.95, `minScore`, `flair doctor`'s
// embed-verify probe) failed open at maximal confidence. For the dedup gate
// that meant EVERY memory_store from a stale client silently dropped its
// content into the arbitrary top-1 match — the #985 data-loss report.
import { databases } from "harper";
import { withDetachedTxn } from "./table-helpers.js";
import { wrapUntrusted } from "./content-safety.js";
import { cosineSimilarity } from "./dedup.js";
import { compositeScore } from "./scoring.js";
import { buildBM25, fuseRrfNormalized, SEM_LIMIT } from "./bm25.js";
import { isAllowedBm25Candidate, type Condition } from "./bm25-filter.js";
import { indexedBm25Ids } from "./bm25-index-service.js";

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
// Exported so the opt-in trust-block path (flair#744 slice 1) can widen it with
// `provenance` ONLY when a caller requests the block — the default projection
// deliberately omits `provenance` (it's only needed for the trust block), and
// adding it unconditionally would change every existing recall response's
// bytes. See SemanticSearch.ts / MemoryBootstrap.ts's `includeTrust` handling.
export const DEFAULT_SELECT = ["id", "agentId", "content", "contentHash", "visibility", "tags", "durability",
  "source", "createdAt", "updatedAt", "expiresAt", "retrievalCount", "usageCount", "lastRetrieved",
  "promotionStatus", "promotedAt", "promotedBy", "archived", "archivedAt", "archivedBy",
  "parentId", "derivedFrom", "sessionId", "lastReflected", "supersedes", "subject", "summary",
  "validFrom", "validTo", "_safetyFlags"];

export interface RetrieveCandidatesParams {
  /** Precomputed query embedding, or null/undefined when none is available
   *  (e.g. the embedding engine failed/was never called). */
  queryEmbedding?: number[] | null;
  /** Raw query text — drives BM25 lexical ranking (hybrid leg) and the
   *  legacy keyword bump (HNSW-only leg). SemanticSearch passes the request
   *  `q`; MemoryBootstrap's task-relevant pass passes `currentTask`
   *  (flair#1246 — the same text its `queryEmbedding` was computed from, so
   *  bootstrap and search rank on the same fused scale). */
  q?: string;
  /** Pre-built Harper conditions[] — the caller (SemanticSearch.post() /
   *  MemoryBootstrap.post()) already resolved scope.condition (and, for
   *  SemanticSearch, folded in archived/tag/subject conditions too) into
   *  this array. The core never builds its own scoping condition — it only
   *  pushes down whatever it's given. */
  conditions: any[];
  /** The literal Harper query `limit` for the HNSW/BM25 legs — the exact
   *  candidate-pool depth fetched. The core does NOT multiply this
   *  internally; SemanticSearch's overfetch policy (CANDIDATE_MULTIPLIER) and
   *  MemoryBootstrap's K formula are both computed by the caller BEFORE
   *  calling in. */
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
   * Both production callers resolve it from the SAME hybridEnabled()
   * selector — SemanticSearch since the hybrid activation, MemoryBootstrap's
   * task-relevant pass since flair#1246 (one ranker, one scale: HNSW-only
   * bootstrap ranked lexically-relevant records below bland-generic noise on
   * pure cosine while search fused them to rank 1 — a structural divergence
   * between the two surfaces on the same store+query). The hybrid leg's BM25
   * corpus fetch (`corpusQuery` below) is an UNBOUNDED conditions-scoped
   * scan (no `limit`), the same per-call scan every search request already
   * runs — the Kern-ratified cost of putting bootstrap on the search ranker.
   */
  hybrid: boolean;
  /** Request context, for withDetachedTxn — both SemanticSearch and
   *  MemoryBootstrap are Resources with their own ctx. */
  ctx?: any;
  /**
   * flair#744 slice 2 (abstention): attach an absolute semantic similarity
   * (`_semSimilarity`, cosine in [0,1]) to each embedding-leg result so the
   * ABSTENTION decision in the wrapper can read the best-match *confidence*.
   * This is the raw cosine — historically distinct from the hybrid `_score`,
   * which used to be RRF rank-normalized (top result pinned at ~1.0 however
   * weak the real match); since flair#985 the raw-mode `_score` is on this
   * same absolute scale, and `_semSimilarity` remains the opt-in per-result
   * confidence field.
   *
   * DEFAULT false (and passed false by every non-abstain caller) ⇒ result
   * objects are byte-identical to pre-slice-2: the `_semSimilarity` field is
   * NEVER added unless requested (the cosine is now CAPTURED unconditionally
   * for `_score` itself, but the field attach stays opt-in). The value is
   * derived ONLY from the embedding
   * cosine — never from any principal / tier / authority field — so surfacing
   * it cannot turn abstention into an authority side-channel.
   */
  withSemSimilarity?: boolean;
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
    withSemSimilarity = false,
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
    // Absolute cosine similarity per semantic candidate (from the HNSW
    // `$distance`), captured HERE before `$distance` is stripped downstream.
    // Captured UNCONDITIONALLY (flair#985): this is the value `_score` reports
    // under `scoring:"raw"` — see the fused loop below — and, when
    // `withSemSimilarity` (flair#744 slice 2), also the confidence signal the
    // abstention decision reads via the opt-in `_semSimilarity` field.
    const semSimById = new Map<string, number>();
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
        if (record.$distance !== undefined) {
          semSimById.set(record.id, distanceToSimilarity(record.$distance));
        } else {
          // Harper's cosine-sort query omits `$distance` for a SINGLETON
          // post-filter result set (see the legacy path below and
          // resources/SemanticSearch.ts's original writeup). Point-lookup the
          // record and compute cosine ourselves from its real stored
          // embedding — a missing/empty stored embedding yields 0 (safe "no
          // semantic evidence"), never a false-high score.
          const full = await withDetachedTxn(ctx, () => (databases as any).flair.Memory.get(record.id));
          const storedEmbedding = Array.isArray(full?.embedding) ? full.embedding : [];
          semSimById.set(record.id, cosineSimilarity(qEmb, storedEmbedding));
        }
        semRecords.push(record);
        semIds.push(record.id);
      }
    }

    // ── (b) The BM25 lexical leg ─────────────────────────────────────────
    //
    // flair#1357. This used to be unconditional: fetch the WHOLE scoped corpus
    // out of Harper, then `buildBM25()` it — per query. That made retrieval
    // latency linear in store size (5.6s p50 at 60k rows, 28.7s at 180k). The
    // lexical leg is now served from a persistent, incrementally-maintained
    // index (resources/bm25-index.ts) whose contract is RANKING-IDENTICAL:
    // same ids, same order, byte for byte. The legacy scan below is still the
    // reference implementation AND the fallback — the index returns null for
    // any query it cannot reproduce exactly, and for a query with no text
    // there is no lexical leg to serve at all.
    const allowedById = new Map<string, any>();
    let bm25Ids: string[] = [];
    // Only the no-signal listing branch (d) still needs the full scoped
    // corpus materialised; every other branch resolves records by id.
    const needCorpusListing = !q && !qEmb;
    let servedFromIndex = false;

    if (q) {
      const fromIndex = await indexedBm25Ids({
        q: String(q),
        conditions: conditions as Condition[],
        timeFilters: { sinceDate, asOf },
        isAllowed,
        limit: SEM_LIMIT,
        ctx,
      });
      if (fromIndex) {
        bm25Ids = fromIndex;
        servedFromIndex = true;
      }
    }

    if (!servedFromIndex && (q || needCorpusListing)) {
      // ── Legacy path: scoped corpus scan + per-query buildBM25() ──────────
      const corpusQuery: any = conditions.length > 0
        ? { conditions, select }
        : { select };
      const corpusResults = withDetachedTxn(ctx, () => (databases as any).flair.Memory.search(corpusQuery));
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
      if (q) {
        const bm25 = buildBM25(bm25Docs);
        const ranked = bm25.rank(String(q));
        bm25Ids = ranked.filter(r => r.score > 0).slice(0, SEM_LIMIT).map(r => r.id);
      }
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

    // ── (b2) Resolve the index-served BM25 candidates ─────────────────────
    // On the indexed path there is no corpus map to read from, so a BM25-only
    // rescue is point-looked-up and projected down to `select`. The projection
    // reproduces Harper's own `search({select})` shape exactly — the keys of
    // `select` that the row actually carries, in `select` declaration order
    // (measured; pinned by test/integration/bm25-index-scan-order-1357.test.ts).
    //
    // The freshly-read row is then re-checked against the SAME conditions[] +
    // temporal filters + scope predicate before it is allowed into the fusion.
    // The index already applied all three to its own copy of the row; this is
    // the Sherlock gate applied to the row we are actually about to return, so
    // a stale index entry can only ever REMOVE a candidate, never smuggle an
    // out-of-scope record into the union.
    if (servedFromIndex) {
      const resolved: string[] = [];
      for (const id of bm25Ids) {
        if (allowedById.has(id)) { resolved.push(id); continue; }
        const full = await withDetachedTxn(ctx, () => (databases as any).flair.Memory.get(id));
        if (!full) continue;
        if (!isAllowedBm25Candidate(full, conditions as Condition[], { sinceDate, asOf })) continue;
        if (!passesAllowed(full)) continue;
        const projected: any = {};
        for (const key of select) if (key in full) projected[key] = (full as any)[key];
        allowedById.set(id, projected);
        if (qEmb) {
          const storedEmbedding = Array.isArray((full as any).embedding) ? (full as any).embedding : [];
          semSimById.set(id, cosineSimilarity(qEmb, storedEmbedding));
        }
        resolved.push(id);
      }
      bm25Ids = resolved;
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
          _rank: finalScore,
        });
      }
    } else {
      // ── Candidate-union RRF → normalized [0,1] RANKING value ────────────
      // flair#985: the fused RRF value ORDERS results but is never REPORTED
      // as a score. RRF normalization pins the top candidate at exactly 1.0
      // regardless of how weak the real match is — reporting it as `_score`
      // (the pre-#985 behavior) silently changed the meaning of `_score` from
      // "absolute similarity, 0.95 ≈ near-duplicate" to "relative rank". Every
      // consumer that thresholds `_score` as a similarity then fails OPEN at
      // maximal confidence: the pre-0.18 flair-client dedup gate (`score >=
      // 0.95` → suppress the write) suppressed EVERY memory_store into the
      // arbitrary top-1 — however unrelated — which is the #985 field report
      // (4/5 writes silently lost cross-topic). `minScore`, `flair doctor`'s
      // embed-verify probe, and compositeScore's relevance floors all carry
      // the same absolute-scale expectation. So: rank by fusion (`_rank`,
      // internal, stripped before return — the hybrid recall win lives in the
      // fused ORDER), report absolute evidence (`_score` = true cosine + the
      // legacy keyword bump, same scale as the legacy HNSW-only path below).
      const fused = fuseRrfNormalized(semIds, bm25Ids);

      for (const [id, rrfRaw] of fused) {
        const record = allowedById.get(id);
        if (!record) continue; // should not happen — union ⊆ allowed

        // Absolute semantic similarity for this candidate. Sem-leg candidates
        // already carry it (captured above, incl. the singleton-`$distance`
        // fallback). A BM25-only candidate never went through the HNSW leg —
        // point-lookup its stored embedding and compute the true cosine, so a
        // genuinely-relevant lexical rescue reports its real similarity
        // instead of a fabricated one (missing/legacy embedding ⇒ 0, safe).
        let semSim = semSimById.get(id);
        if (semSim === undefined && qEmb) {
          const full = await withDetachedTxn(ctx, () => (databases as any).flair.Memory.get(id));
          const storedEmbedding = Array.isArray(full?.embedding) ? full.embedding : [];
          semSim = cosineSimilarity(qEmb, storedEmbedding);
          semSimById.set(id, semSim);
        }
        let keywordHit = false;
        if (q && String(record.content || "").toLowerCase().includes(String(q).toLowerCase())) {
          keywordHit = true;
        }
        const rawScore = (semSim ?? 0) + (keywordHit ? 0.05 : 0);
        let finalScore = scoring === "raw" ? rawScore : compositeScore(rrfRaw, record);
        if (temporalBoost > 1.0) finalScore *= temporalBoost;

        const isFlagged = record._safetyFlags && Array.isArray(record._safetyFlags) && record._safetyFlags.length > 0;
        const source = record.agentId !== agentId ? record.agentId : undefined;
        results.push({
          ...record,
          content: isFlagged ? wrapUntrusted(record.content, source) : record.content,
          _score: Math.round(finalScore * 1000) / 1000,
          _rawScore: scoring !== "raw" ? Math.round(rawScore * 1000) / 1000 : undefined,
          _source: source,
          // Ordering key: fused rank for raw mode; composite value for
          // composite mode (composite ordering is unchanged by #985 — its
          // rrfRaw input and result order are exactly the pre-#985 behavior).
          _rank: scoring === "raw" ? rrfRaw : finalScore,
          // flair#744 slice 2: the opt-in absolute-confidence field for the
          // abstention decision. Attach remains OPT-IN so non-abstain
          // responses stay byte-identical (the capture above is now
          // unconditional, but the response field is not).
          ...(withSemSimilarity && semSim !== undefined ? { _semSimilarity: semSim } : {}),
        });
      }
    }
  } else if (qEmb) {
    // ─── HNSW vector search path (legacy, hybrid flag OFF — the
    // FLAIR_HYBRID_RETRIEVAL kill-switch path for BOTH production callers
    // since flair#1246) ─────────────────────────────────────────────────────
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
      // flair#744 slice 2: the absolute cosine (`semanticScore`, pre keyword
      // bump) is the abstention confidence signal on this legacy/bootstrap
      // (HNSW-leg-only) path.
      results.push({
        ...rest,
        content: isFlagged ? wrapUntrusted(rest.content, source) : rest.content,
        _score: Math.round(finalScore * 1000) / 1000,
        _rawScore: scoring !== "raw" ? Math.round(rawScore * 1000) / 1000 : undefined,
        _source: source,
        _rank: finalScore,
        ...(withSemSimilarity ? { _semSimilarity: semanticScore } : {}),
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
        _rank: finalScore,
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

  // Apply minimum score filter — against `_score`, which is ALWAYS on the
  // absolute-similarity scale after flair#985 (the hybrid path used to report
  // the rank-normalized RRF value here, so `minScore: 0.95` matched the
  // always-1.0 top-1 of ANY query instead of meaning "similarity ≥ 0.95").
  if (minScore > 0) {
    filteredResults = filteredResults.filter((r: any) => r._score >= minScore);
  }

  // Order by the internal ranking key (fused RRF rank on the hybrid raw path;
  // identical to `_score` everywhere else), then strip it — `_rank` is an
  // ordering key, never part of the response shape. Note the hybrid raw
  // ordering is deliberately NOT by `_score`: the recall win of hybrid
  // retrieval lives in the fused ORDER (a BM25 rank-1 rescue outranks weak
  // semantic hits), while `_score` carries the honest absolute evidence for
  // each result — the two can disagree, and that is correct.
  filteredResults.sort((a: any, b: any) => b._rank - a._rank);
  for (const r of filteredResults) delete r._rank;
  return filteredResults;
}
