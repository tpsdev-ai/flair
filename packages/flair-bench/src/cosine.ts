/**
 * cosine.ts — exact cosine similarity + full-corpus ranking.
 *
 * Stands in for Harper's HNSW approximate-nearest-neighbor index (see
 * README "Comparable to flair, with a caveat"): flair-bench has no HNSW
 * graph, so instead of an approximate top-K it scores EVERY corpus vector
 * against the query and sorts — the correct answer for a corpus this size
 * (251 records), and the reason the tool can claim exact recall numbers
 * rather than approximate ones.
 */

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 0-based rank of `targetIndex` within `corpusVectors` when sorted by
 * descending cosine similarity to `query`. Ties are broken by corpus
 * insertion order (stable sort — Array.prototype.sort is guaranteed stable
 * since ES2019/V8 since Node 11), the simplest documented tie-break
 * available without reverse-engineering Harper's own HNSW/BM25-RRF
 * tie-break internals. See README's "exact-vs-HNSW caveat" for what this
 * does and doesn't guarantee to reproduce.
 */
export function rankOf(query: readonly number[], corpusVectors: readonly (readonly number[])[], targetIndex: number): number {
  const scored = corpusVectors.map((v, index) => ({ index, score: cosineSimilarity(query, v) }));
  scored.sort((x, y) => y.score - x.score);
  return scored.findIndex((s) => s.index === targetIndex);
}
