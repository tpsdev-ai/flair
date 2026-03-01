import { Resource, tables } from "harperdb";
import { embed, cosineSimilarity } from "./embeddings.js";

export class MemorySearch extends Resource {
  async post(data: any, _context?: any) {
    const { agentId, q, tag, limit = 10, mode = "hybrid" } = data || {};
    const conditions: any[] = [];
    if (agentId) conditions.push({ attribute: "agentId", comparator: "equals", value: agentId });

    const results: any[] = [];
    const queryEmbedding = q ? embed(q) : null;

    for await (const record of (tables as any).Memory.search({ conditions })) {
      if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
      if (tag && !(record.tags || []).includes(tag)) continue;

      let score = 0;

      if (mode === "keyword" || mode === "hybrid") {
        // Keyword match score
        if (q && String(record.content || "").toLowerCase().includes(String(q).toLowerCase())) {
          score += 0.5;
        }
      }

      if ((mode === "vector" || mode === "hybrid") && queryEmbedding && record.embedding) {
        // Vector similarity score
        const sim = cosineSimilarity(queryEmbedding, record.embedding);
        score += sim;
      }

      if (q && score === 0) continue; // No match at all

      results.push({ ...record, _score: Math.round(score * 1000) / 1000 });
    }

    // Sort by score descending, take top N
    results.sort((a: any, b: any) => b._score - a._score);
    return { results: results.slice(0, limit) };
  }
}
