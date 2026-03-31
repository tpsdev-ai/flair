import { Resource, databases } from "@harperfast/harper";
import { getEmbedding, getMode } from "./embeddings-provider.js";

export class DebugSearch extends Resource {
  async post(data: any) {
    const { q, agentId } = data || {};
    
    // Test 1: plain search
    let plainCount = 0;
    try {
      for await (const _r of (databases as any).flair.Memory.search()) { plainCount++; }
    } catch (e: any) { return { error: "plain: " + e.message }; }
    
    // Test 2: search with conditions
    let condCount = 0;
    try {
      const conditions = agentId ? [{ attribute: "agentId", comparator: "equals", value: agentId }] : [];
      for await (const _r of (databases as any).flair.Memory.search(conditions.length ? { conditions } : {})) { condCount++; }
    } catch (e: any) { return { error: "cond: " + e.message, plainCount }; }
    
    // Test 3: HNSW search
    let hnswCount = 0;
    let embMode = getMode();
    let qEmb: number[] | null = null;
    if (q) {
      try { qEmb = await getEmbedding(String(q).slice(0, 8000)); } catch {}
    }
    
    if (qEmb) {
      try {
        const query: any = {
          sort: { attribute: "embedding", target: qEmb, distance: "cosine" },
          limit: 10,
        };
        if (agentId) {
          query.conditions = [{ attribute: "agentId", comparator: "equals", value: agentId }];
        }
        for await (const record of (databases as any).flair.Memory.search(query)) {
          hnswCount++;
        }
      } catch (e: any) { return { error: "hnsw: " + e.message, plainCount, condCount, embMode, hasQEmb: !!qEmb }; }
    }
    
    return { plainCount, condCount, hnswCount, embMode, hasQEmb: !!qEmb };
  }
}
