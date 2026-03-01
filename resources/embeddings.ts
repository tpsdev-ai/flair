/**
 * Fallback hash-based embedding (used when sidecar is unavailable).
 * Real embeddings come from the embed-server sidecar (harper-fabric-embeddings).
 */
const DIMS = 512;
function h1(s: string): number { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h % DIMS; }
function h2(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h % DIMS; }

export function fallbackEmbed(text: string): number[] {
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(t => t.length > 1);
  const clean = text.toLowerCase().replace(/\s+/g, ' ');
  const vec = new Float64Array(DIMS);
  for (const t of tokens) { vec[h1(t)] += 2; vec[h2(t)] += 1; }
  for (let i = 0; i < tokens.length - 1; i++) vec[h1(tokens[i] + '_' + tokens[i + 1])] += 1.5;
  for (let i = 0; i <= clean.length - 3; i++) vec[h1(clean.slice(i, i + 3))] += 0.5;
  for (let i = 0; i < DIMS; i++) if (vec[i] > 0) vec[i] = 1 + Math.log(vec[i]);
  let norm = 0; for (let i = 0; i < DIMS; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIMS; i++) vec[i] /= norm;
  return Array.from(vec);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}
