import { Resource, tables } from "harperdb";

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

// Lazy-init embedding module (runs in sandbox via process.dlopen)
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
      } catch {
        hfe = null;
      }
    })();
  }
  await hfeInitPromise;
  return hfe !== null;
}

export class MemorySearch extends Resource {
  async post(data: any, _context?: any) {
    const { agentId, q, queryEmbedding, tag, limit = 10 } = data || {};
    const conditions: any[] = [];
    if (agentId) conditions.push({ attribute: "agentId", comparator: "equals", value: agentId });

    // Generate query embedding in-process if not provided
    let qEmb = queryEmbedding;
    if (!qEmb && q) {
      const ready = await ensureEmbeddings();
      if (ready) {
        try {
          qEmb = await hfe.embed(String(q).slice(0, 500));
        } catch {}
      }
    }

    const results: any[] = [];

    for await (const record of (tables as any).Memory.search({ conditions })) {
      if (record.expiresAt && Date.parse(record.expiresAt) < Date.now()) continue;
      if (tag && !(record.tags || []).includes(tag)) continue;

      let score = 0;

      // Keyword match
      if (q && String(record.content || "").toLowerCase().includes(String(q).toLowerCase())) {
        score += 0.5;
      }

      // Vector similarity
      if (qEmb && record.embedding && qEmb.length === record.embedding.length) {
        score += cosineSimilarity(qEmb, record.embedding);
      }

      if (q && score === 0) continue;

      const { embedding, ...rest } = record;
      results.push({ ...rest, _score: Math.round(score * 1000) / 1000 });
    }

    results.sort((a: any, b: any) => b._score - a._score);
    return { results: results.slice(0, limit) };
  }
}
