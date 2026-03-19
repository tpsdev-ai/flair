import { Resource, databases } from "@harperfast/harper";
import { getEmbedding, getMode } from "./embeddings-provider.js";
import { patchRecord } from "./table-helpers.js";

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

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

export class SemanticSearch extends Resource {
  async post(data: any) {
    const { agentId, q, queryEmbedding, tag, subject, subjects, limit = 10, includeSuperseded = false, scoring = "composite", minScore = 0, since } = data || {};
    const subjectFilter = subjects
      ? new Set((subjects as string[]).map((s: string) => s.toLowerCase()))
      : subject
        ? new Set([(subject as string).toLowerCase()])
        : null;

    // Defense-in-depth: verify agentId matches authenticated agent.
    // The middleware already enforces this for non-admins, but double-check here
    // so direct Harper API calls (e.g., admin scripts) are also scoped correctly.
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
      if (getMode() !== "none") {
        try { qEmb = await getEmbedding(String(q).slice(0, 500)); } catch {}
      }
    }

    // ─── Temporal intent detection ────────────────────────────────────────────
    // If the query implies a time window and no explicit `since` was provided,
    // auto-detect and apply a recency boost.
    let sinceDate: Date | null = since ? new Date(since) : null;
    let temporalBoost = 1.0;
    if (q && !sinceDate) {
      const lq = String(q).toLowerCase();
      if (/\btoday\b|\bthis morning\b|\bthis afternoon\b/.test(lq)) {
        const d = new Date(); d.setHours(0, 0, 0, 0);
        sinceDate = d;
        temporalBoost = 1.5; // boost recent results for temporal queries
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

    const results: any[] = [];

    // Iterate ALL memories, filter by agent ID set
    for await (const record of (databases as any).flair.Memory.search()) {
      // Filter by agent
      if (searchAgentIds.size > 0 && !searchAgentIds.has(record.agentId)) {
        if (record.visibility !== "office") continue;
      }

      if (record.archived === true) continue;
      if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
      if (tag && !(record.tags || []).includes(tag)) continue;
      if (subjectFilter && record.subject && !subjectFilter.has(String(record.subject).toLowerCase())) continue;
      // Time window filter
      if (sinceDate && record.createdAt && new Date(record.createdAt) < sinceDate) continue;

      let semanticScore = 0;
      let keywordHit = false;
      if (q && String(record.content || "").toLowerCase().includes(String(q).toLowerCase())) {
        keywordHit = true;
      }
      if (qEmb && record.embedding && qEmb.length === record.embedding.length) {
        semanticScore = cosineSimilarity(qEmb, record.embedding);
      }
      // Keyword match is a small tiebreaker (5%), not a primary signal.
      // This prevents weak semantic matches from ranking high just because
      // a query word appears in the content.
      const rawScore = semanticScore + (keywordHit ? 0.05 : 0);
      if (q && rawScore === 0) continue;

      // Apply composite scoring (temporal decay + durability + retrieval boost + temporal intent)
      let finalScore = scoring === "raw" ? rawScore : compositeScore(rawScore, record);
      if (temporalBoost > 1.0) finalScore *= temporalBoost;

      const { embedding, ...rest } = record;
      results.push({
        ...rest,
        _score: Math.round(finalScore * 1000) / 1000,
        _rawScore: scoring !== "raw" ? Math.round(rawScore * 1000) / 1000 : undefined,
        _source: record.agentId !== agentId ? record.agentId : undefined,
      });
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
    // Use patchRecord to avoid wiping other fields (embedding, content, etc.)
    const now = new Date().toISOString();
    for (const r of topResults) {
      patchRecord((databases as any).flair.Memory, r.id, {
        retrievalCount: (r.retrievalCount || 0) + 1,
        lastRetrieved: now,
      }).catch(() => {});
    }

    return { results: topResults };
  }
}
