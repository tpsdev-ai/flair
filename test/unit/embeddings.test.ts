import { describe, it, expect } from "bun:test";

// Use fallback directly for unit tests (no llama.cpp needed)
const DIMS = 512;
function hashDjb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h % DIMS;
}
function hashFnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % DIMS;
}
function fallbackEmbed(text: string): number[] {
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(t => t.length > 1);
  const clean = text.toLowerCase().replace(/\s+/g, ' ');
  const vec = new Float64Array(DIMS);
  for (const t of tokens) { vec[hashDjb2(t)] += 2; vec[hashFnv(t)] += 1; }
  for (let i = 0; i < tokens.length - 1; i++) { const b = `${tokens[i]}_${tokens[i + 1]}`; vec[hashDjb2(b)] += 1.5; }
  for (let i = 0; i <= clean.length - 3; i++) { const g = clean.slice(i, i + 3); vec[hashDjb2(g)] += 0.5; }
  for (let i = 0; i < DIMS; i++) if (vec[i] > 0) vec[i] = 1 + Math.log(vec[i]);
  let norm = 0;
  for (let i = 0; i < DIMS; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIMS; i++) vec[i] /= norm;
  return Array.from(vec);
}
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
  return dot;
}

describe("embeddings (fallback)", () => {
  it("generates 512-dimensional vector", () => {
    expect(fallbackEmbed("hello world")).toHaveLength(512);
  });

  it("produces normalized vectors", () => {
    const vec = fallbackEmbed("this is a test of the embedding system");
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(Math.abs(norm - 1.0)).toBeLessThan(0.001);
  });

  it("similar texts have higher similarity than dissimilar", () => {
    const a = fallbackEmbed("fixing CI pipeline typescript errors in the build system");
    const b = fallbackEmbed("CI build failures in typescript compilation and type checking");
    const c = fallbackEmbed("recipe for chocolate cake with vanilla frosting and sprinkles");
    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c));
  });

  it("identical texts have similarity 1.0", () => {
    const text = "Harper v5 HNSW vector index for semantic search";
    const sim = cosineSimilarity(fallbackEmbed(text), fallbackEmbed(text));
    expect(Math.abs(sim - 1.0)).toBeLessThan(0.001);
  });

  it("empty text returns zero vector", () => {
    const norm = Math.sqrt(fallbackEmbed("").reduce((s, v) => s + v * v, 0));
    expect(norm).toBe(0);
  });
});
