import { Resource, databases } from "@harperfast/harper";
import { getEmbedding, getMode } from "./embeddings-provider.js";
import { patchRecord } from "./table-helpers.js";
import { checkRateLimit, rateLimitResponse } from "./rate-limiter.js";

// ─── Temporal Decay + Relevance Scoring ─────────────────────────────────────

const DURABILITY_WEIGHTS: Record<string, number> = {
  permanent: 1.0,
  persistent: 0.9,
  standard: 0.7,
  ephemeral: 0.4,
};

// Half-life in days for exponential decay per durability level
const DECAY_HALF_LIFE_DAYS: Record<string, number> = {
  permanent: Infinity, // never decays
  persistent: 90,
  standard: 30,
  ephemeral: 7,
};

function recencyFactor(createdAt: string, durability: string): number {
  const halfLife = DECAY_HALF_LIFE_DAYS[durability] ?? 30;
  if (halfLife === Infinity) return 1.0;
  const ageDays = (Date.now() - Date.parse(createdAt)) / (1000 * 60 * 60 * 24);
  const lambda = Math.LN2 / halfLife;
  return Math.exp(-lambda * ageDays);
}

function retrievalBoost(retrievalCount: number): number {
  if (!retrievalCount || retrievalCount <= 0) return 1.0;
  return 1.0 + 0.1 * Math.log2(retrievalCount); // gentle boost: 10 retrievals → ~1.33x
}

function compositeScore(
  semanticScore: number,
  record: { durability?: string; createdAt?: string; retrievalCount?: number; supersedes?: string },
): number {
  const durability = record.durability ?? "standard";
  const dWeight = DURABILITY_WEIGHTS[durability] ?? 0.7;
  const rFactor = record.createdAt ? recencyFactor(record.createdAt, durability) : 1.0;
  const rBoost = retrievalBoost(record.retrievalCount ?? 0);
  return semanticScore * dWeight * rFactor * rBoost;
}

// Convert HNSW cosine distance (1 - similarity) to similarity score
function distanceToSimilarity(distance: number): number {
  return 1 - distance;
}

// Candidate multiplier: fetch more candidates than needed from the HNSW index
// so composite re-ranking has enough headroom to reorder results.
const CANDIDATE_MULTIPLIER = 5;

export class SemanticSearch extends Resource {
  async post(data: any) {
    const { agentId, q, queryEmbedding, tag, subject, subjects, limit = 10, includeSuperseded = false, scoring = "composite", minScore = 0, since } = data || {};

    // Rate limiting — use authenticated agent ID from request context, not client-supplied body
    const rateLimitAgent: string | undefined = (this as any).request?.headers?.get?.("x-tps-agent")
      ?? (this as any).request?.tpsAgent;
    if (rateLimitAgent) {
      const bucket = q && !queryEmbedding ? "embedding" : "general";
      const rl = checkRateLimit(rateLimitAgent, bucket);
      if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs!, "search");
    }

    const subjectFilter = subjects
      ? new Set((subjects as string[]).map((s: string) => s.toLowerCase()))
      : subject
        ? new Set([(subject as string).toLowerCase()])
        : null;

    // Defense-in-depth: verify agentId matches authenticated agent.
    const authenticatedAgent: string | undefined = (this as any).request?.headers?.get?.("x-tps-agent");
    const callerIsAdmin: boolean = (this as any).request?.tpsAgentIsAdmin === true;
    if (authenticatedAgent && !callerIsAdmin && agentId && agentId !== authenticatedAgent) {
      return new Response(JSON.stringify({
        error: "forbidden: agentId must match authenticated agent",
      }), { status: 403, headers: { "Content-Type": "application/json" } });
    }

    // Determine searchable agent IDs (own + granted)
    const searchAgentIds = new Set<string>();
    if (agentId) searchAgentIds.add(agentId);

    if (agentId) {
      try {
        for await (const grant of (databases as any).flair.MemoryGrant.search({
          conditions: [{ attribute: "granteeId", comparator: "equals", value: agentId }],
        })) {
          if (grant.scope === "search" || grant.scope === "read") {
            searchAgentIds.add(grant.ownerId);
          }
        }
      } catch { /* MemoryGrant may not exist */ }
    }

    // Generate query embedding
    let qEmb = queryEmbedding;
    if (!qEmb && q) {
      // Always attempt embedding generation — getEmbedding() handles init internally.
      // Don't gate on getMode() which may return "none" before init completes in worker threads.
      {
        try { qEmb = await getEmbedding(String(q).slice(0, 8000)); } catch {}
      }
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

    // Agent scoping: filter to allowed agent IDs or office-visible memories
    if (searchAgentIds.size === 1) {
      const [id] = searchAgentIds;
      conditions.push({
        operator: "or",
        conditions: [
          { attribute: "agentId", comparator: "equals", value: id },
          { attribute: "visibility", comparator: "equals", value: "office" },
        ],
      });
    } else if (searchAgentIds.size > 1) {
      const agentConditions = [...searchAgentIds].map(id => (
        { attribute: "agentId", comparator: "equals", value: id }
      ));
      agentConditions.push({ attribute: "visibility", comparator: "equals", value: "office" } as any);
      conditions.push({ operator: "or", conditions: agentConditions });
    }

    conditions.push({ attribute: "archived", comparator: "equals", value: false });

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

    // ─── HNSW vector search path ───────────────────────────────────────────
    if (qEmb) {
      const candidateLimit = limit * CANDIDATE_MULTIPLIER;
      const query: any = {
        sort: { attribute: "embedding", target: qEmb, distance: "cosine" },
        select: ["id", "agentId", "content", "contentHash", "visibility", "tags", "durability",
          "source", "createdAt", "updatedAt", "expiresAt", "retrievalCount", "lastRetrieved",
          "promotionStatus", "promotedAt", "promotedBy", "archived", "archivedAt", "archivedBy",
          "parentId", "derivedFrom", "sessionId", "lastReflected", "supersedes", "subject",
          "$distance"],
        limit: candidateLimit,
      };
      if (conditions.length > 0) {
        query.conditions = conditions;
      }

      for await (const record of (databases as any).flair.Memory.search(query)) {
        if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
        if (sinceDate && record.createdAt && new Date(record.createdAt) < sinceDate) continue;

        const semanticScore = distanceToSimilarity(record.$distance ?? 1);
        let keywordHit = false;
        if (q && String(record.content || "").toLowerCase().includes(String(q).toLowerCase())) {
          keywordHit = true;
        }
        const rawScore = semanticScore + (keywordHit ? 0.05 : 0);

        let finalScore = scoring === "raw" ? rawScore : compositeScore(rawScore, record);
        if (temporalBoost > 1.0) finalScore *= temporalBoost;

        const { $distance, ...rest } = record;
        results.push({
          ...rest,
          _score: Math.round(finalScore * 1000) / 1000,
          _rawScore: scoring !== "raw" ? Math.round(rawScore * 1000) / 1000 : undefined,
          _source: record.agentId !== agentId ? record.agentId : undefined,
        });
      }
    } else {
      // ─── No embedding available — keyword-only fallback ──────────────────
      // Full scan is only used when there's no query embedding (e.g. tag-only
      // or subject-only searches, or when the embedding engine is unavailable).
      const query: any = conditions.length > 0 ? { conditions } : {};
      for await (const record of (databases as any).flair.Memory.search(query)) {
        if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
        if (sinceDate && record.createdAt && new Date(record.createdAt) < sinceDate) continue;

        let keywordHit = false;
        if (q && String(record.content || "").toLowerCase().includes(String(q).toLowerCase())) {
          keywordHit = true;
        }
        const rawScore = keywordHit ? 0.05 : 0;
        if (q && rawScore === 0) continue;

        const { embedding, ...rest } = record;
        let finalScore = scoring === "raw" ? rawScore : compositeScore(rawScore, rest);
        if (temporalBoost > 1.0) finalScore *= temporalBoost;

        results.push({
          ...rest,
          _score: Math.round(finalScore * 1000) / 1000,
          _rawScore: scoring !== "raw" ? Math.round(rawScore * 1000) / 1000 : undefined,
          _source: record.agentId !== agentId ? record.agentId : undefined,
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

    filteredResults.sort((a: any, b: any) => b._score - a._score);
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
