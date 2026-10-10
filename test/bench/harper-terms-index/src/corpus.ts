// Synthetic corpus for the flair#2047 spike.
//
// Token length and Zipf slope are the bench profile in
// test/bench/corpus-profiler/profiles/corpus-v2.json (the "~26 tokens" figure
// the in-memory index comments cite). Scope skew is the live profile's
// recordsPerAgentSorted (live-flint-2026-07.json) so "single scope" is the
// dominant agent share, not an even split. Vocabulary size grows from the
// profile's type/token counts with Heaps' law at beta 0.5 — that exponent is
// a spike assumption, not a fitted profile field. run.ts checks the copied
// numbers against the JSON before any Harper process starts.
//
// Terms are synthetic (`t1` …). tokenize() keeps them, so the lexical index
// sees the same tokens the generator drew. No profile text is reconstructed.

export const PROFILE = {
  tokenSource: "test/bench/corpus-profiler/profiles/corpus-v2.json",
  scopeSource: "test/bench/corpus-profiler/profiles/live-flint-2026-07.json",
  tokenMean: 26.322709163346612,
  tokenStdev: 2.9043832789553963,
  tokenMin: 19,
  tokenMax: 33,
  zipfSlope: -0.6903414125045878,
  vocabTokens: 6607,
  vocabTypes: 2809,
  heapsBeta: 0.5,
  scopeWeights: [898, 64, 46, 41, 21, 4, 4, 2] as readonly number[],
};

export interface CorpusModel {
  n: number;
  seed: number;
  V: number;
  cdf: Float64Array;
  scopeCutoffs: number[];
  dominantScope: string;
  expectedTokens: number;
}

export interface SynthDoc {
  id: string;
  agentId: string;
  content: string;
  docLen: number;
  /** Unique terms, sorted. */
  terms: string[];
  /** term -> count, parallel to the tokens tokenize() will return. */
  tf: Map<string, number>;
}

export function vocabularySize(n: number): number {
  const expectedTokens = n * PROFILE.tokenMean;
  const grown = PROFILE.vocabTypes * Math.pow(expectedTokens / PROFILE.vocabTokens, PROFILE.heapsBeta);
  return Math.max(128, Math.round(grown));
}

export function buildModel(n: number, seed: number): CorpusModel {
  const V = vocabularySize(n);
  const cdf = new Float64Array(V);
  let sum = 0;
  const weights = new Float64Array(V);
  for (let i = 0; i < V; i++) {
    weights[i] = (i + 1) ** PROFILE.zipfSlope;
    sum += weights[i];
  }
  let acc = 0;
  for (let i = 0; i < V; i++) {
    acc += weights[i] / sum;
    cdf[i] = acc;
  }
  cdf[V - 1] = 1;
  const total = PROFILE.scopeWeights.reduce((a, b) => a + b, 0);
  const scopeCutoffs: number[] = [];
  let c = 0;
  for (const w of PROFILE.scopeWeights) {
    c += w / total;
    scopeCutoffs.push(c);
  }
  scopeCutoffs[scopeCutoffs.length - 1] = 1;
  return {
    n,
    seed,
    V,
    cdf,
    scopeCutoffs,
    dominantScope: "a0",
    expectedTokens: n * PROFILE.tokenMean,
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleRank(cdf: Float64Array, u: number): number {
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

function scopeOf(cutoffs: number[], u: number): string {
  for (let i = 0; i < cutoffs.length; i++) if (u <= cutoffs[i]) return `a${i}`;
  return `a${cutoffs.length - 1}`;
}

export function docId(i: number): string {
  return `m${String(i).padStart(8, "0")}`;
}

/** Document i. Pure in (model, i): both ingest arms draw the same row. */
export function docAt(model: CorpusModel, i: number): SynthDoc {
  const rng = mulberry32((model.seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0);
  const agentId = scopeOf(model.scopeCutoffs, rng());
  let len = Math.round(PROFILE.tokenMean + PROFILE.tokenStdev * normal(rng));
  if (len < PROFILE.tokenMin) len = PROFILE.tokenMin;
  if (len > PROFILE.tokenMax) len = PROFILE.tokenMax;
  const tokens: string[] = new Array(len);
  const tf = new Map<string, number>();
  for (let k = 0; k < len; k++) {
    const term = `t${sampleRank(model.cdf, rng())}`;
    tokens[k] = term;
    tf.set(term, (tf.get(term) || 0) + 1);
  }
  const terms = [...tf.keys()].sort();
  return { id: docId(i), agentId, content: tokens.join(" "), docLen: len, terms, tf };
}

export interface QuerySpec {
  /** "head" includes the most frequent term. "mid" stays off the head. */
  band: "head" | "mid";
  /** Requested length before rank-clamping. The text length is `terms.length`. */
  requestedTerms: number;
  terms: string[];
  text: string;
}

function dedupeRanks(ranks: number[], V: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const r of ranks) {
    const c = Math.min(V, Math.max(1, Math.round(r)));
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

/**
 * Fixed query bank. Head queries contain rank 1 (the heaviest posting list).
 * Mid queries sit at fixed fractions of the vocabulary so they stay off the head
 * at every corpus size. Ranks are 1-based into `t<rank>`.
 */
export function queryBank(V: number): QuerySpec[] {
  const specs: { band: "head" | "mid"; requestedTerms: number; ranks: number[] }[] = [
    { band: "head", requestedTerms: 1, ranks: [1] },
    { band: "mid", requestedTerms: 1, ranks: [Math.round(V * 0.02)] },
    { band: "head", requestedTerms: 3, ranks: [1, 3, 8] },
    { band: "mid", requestedTerms: 3, ranks: [0.02, 0.05, 0.1].map((f) => V * f) },
    { band: "head", requestedTerms: 8, ranks: [1, 2, 4, 8, 16, 32, 64, 128] },
    { band: "mid", requestedTerms: 8, ranks: [0.02, 0.04, 0.06, 0.08, 0.1, 0.15, 0.2, 0.3].map((f) => V * f) },
  ];
  return specs.map((s) => {
    const ranks = dedupeRanks(s.ranks, V);
    const terms = ranks.map((r) => `t${r}`);
    return { band: s.band, requestedTerms: s.requestedTerms, terms, text: terms.join(" ") };
  });
}
