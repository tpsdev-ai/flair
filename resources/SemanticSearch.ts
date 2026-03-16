import { Resource, databases } from "@harperfast/harper";
import { getEmbedding, getMode } from "./embeddings-provider.js";
import { patchRecord } from "./table-helpers.js";

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

export class SemanticSearch extends Resource {
  async post(data: any) {
    const { agentId, q, queryEmbedding, tag, limit = 10, includeSuperseded = false } = data || {};

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

    const results: any[] = [];

    // Iterate ALL memories, filter by agent ID set
    for await (const record of (databases as any).flair.Memory.search()) {
      // Filter by agent
      if (searchAgentIds.size > 0 && !searchAgentIds.has(record.agentId)) {
        if (record.visibility !== "office") continue;
      }

      if (record.archived === true) continue; // soft-deleted — excluded from search by default
      if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
      if (tag && !(record.tags || []).includes(tag)) continue;

      let score = 0;
      if (q && String(record.content || "").toLowerCase().includes(String(q).toLowerCase())) {
        score += 0.5;
      }
      if (qEmb && record.embedding && qEmb.length === record.embedding.length) {
        score += cosineSimilarity(qEmb, record.embedding);
      }
      if (q && score === 0) continue;

      const { embedding, ...rest } = record;
      results.push({
        ...rest,
        _score: Math.round(score * 1000) / 1000,
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
