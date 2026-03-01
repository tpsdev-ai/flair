/**
 * Lightweight text embedding for memory search.
 * No external API dependency. Generates 512-dim vectors.
 * 
 * Uses character n-gram hashing (3-grams + word unigrams + bigrams)
 * for better discrimination than word-only hashing.
 */

const DIMS = 512;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

// djb2 hash — good distribution
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h % DIMS;
}

// Second hash for double-hashing (reduces collisions)
function hash2(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % DIMS;
}

function charNgrams(text: string, n: number): string[] {
  const clean = text.toLowerCase().replace(/\s+/g, ' ');
  const grams: string[] = [];
  for (let i = 0; i <= clean.length - n; i++) {
    grams.push(clean.slice(i, i + n));
  }
  return grams;
}

export function embed(text: string): number[] {
  const tokens = tokenize(text);
  const bigrams = tokens.slice(0, -1).map((t, i) => `${t}_${tokens[i + 1]}`);
  const trigrams = charNgrams(text, 3);
  
  const vec = new Float64Array(DIMS);
  
  // Word unigrams (weight 2)
  for (const t of tokens) {
    vec[hash(t)] += 2;
    vec[hash2(t)] += 1; // double-hash for spread
  }
  
  // Word bigrams (weight 1.5)
  for (const b of bigrams) {
    vec[hash(b)] += 1.5;
  }
  
  // Char trigrams (weight 0.5 — captures subword patterns)
  for (const g of trigrams) {
    vec[hash(g)] += 0.5;
  }
  
  // Log-scale
  for (let i = 0; i < DIMS; i++) {
    if (vec[i] > 0) vec[i] = 1 + Math.log(vec[i]);
  }
  
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < DIMS; i++) norm += vec[i] * vec[i];
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
