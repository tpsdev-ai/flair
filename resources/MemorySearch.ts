import { Resource, tables } from "harperdb";

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

let hfe: any = null;
let hfeInitPromise: Promise<void> | null = null;

async function ensureEmbeddings(): Promise<boolean> {
  if (hfe) return true;
  if (!hfeInitPromise) {
    hfeInitPromise = (async () => {
      try {
        hfe = await import("harper-fabric-embeddings");
        await hfe.init({
          modelsDir: process.env.FLAIR_MODELS_DIR || "/tmp/flair-models",
          gpuLayers: 99,
        });
      } catch { hfe = null; }
    })();
  }
  await hfeInitPromise;
  return hfe !== null;
}

export class MemorySearch extends Resource {
  async post(data: any) {
    const { agentId, q, queryEmbedding, tag, limit = 10 } = data || {};

    // Determine searchable agent IDs (own + granted)
    const searchAgentIds = new Set<string>();
    if (agentId) searchAgentIds.add(agentId);

    if (agentId) {
      try {
        for await (const grant of (tables as any).MemoryGrant.search({
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
      if (await ensureEmbeddings()) {
        try { qEmb = await hfe.embed(String(q).slice(0, 500)); } catch {}
      }
    }

    const results: any[] = [];

    // Iterate ALL memories, filter by agent ID set
    for await (const record of (tables as any).Memory.search()) {
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

    results.sort((a: any, b: any) => b._score - a._score);
    const topResults = results.slice(0, limit);

    // Async hit tracking — don't block the response
    const now = new Date().toISOString();
    for (const r of topResults) {
      (tables as any).Memory.put({
        id: r.id,
        retrievalCount: (r.retrievalCount || 0) + 1,
        lastRetrieved: now,
      }).catch(() => {});
    }

    return { results: topResults };
  }
}
