// ─── corpus-profiler: the measurement itself ────────────────────────────────
//
// Pure, Harper-free, network-free. `computeProfile(records)` takes real memory
// records IN MEMORY and returns a profile made of numbers. Nothing here writes
// to disk, logs a record, or keeps a reference to one after it returns.
//
// WHY THIS EXISTS (flair#893)
//
// corpus-v2 scores p@3 0.976 — close enough to ceiling that a real improvement
// and no improvement read identically. Removing the cross-encoder reranker
// measured Δp@3 of exactly 0.000 across 126 queries, and the honest reading of
// that zero is "the instrument cannot see", not "the feature does nothing".
// The fix is an eval corpus whose difficulty matches REAL memories.
//
// But real memories cannot leave the host, and redaction is not a viable
// control: it is a negative constraint ("remove all secrets") that you can
// never prove you finished, and the things that leak are not secret in FORM —
// a codename, an internal hostname, a timestamp that correlates with a
// calendar entry. Architecture and security review reached that conclusion
// independently, in nearly the same words.
//
// So: MEASURE THE STRUCTURE HERE, GENERATE THE TEXT ELSEWHERE. This file is
// the measurement half. A later stage generates a synthetic corpus matching
// these distributions; the generated text is content-free, and the difficulty
// is real because the structure is real.
//
// THE INVARIANT
//
// Everything returned is a count, a quantile, a moment, a histogram bucket, a
// correlation, or a fitted parameter. Nothing returned is, or is derived
// closely enough to reconstruct, a memory body, a title, a tag, an entity, a
// URL, a path, a host, a person, a record id, or a timestamp finer than a
// month. ./guard.ts enforces this mechanically; ./README.md carries the
// per-field rationale.
//
// The vocabulary section is where that invariant is easiest to violate, so it
// is worth naming: we want the term-frequency SHAPE (is this corpus Zipfian,
// how heavy is the tail) without the terms. We therefore emit frequencies
// sorted by rank and a fitted slope — never a rank→term mapping, and never a
// bucket labelled with the thing it counts.

import { tokenize } from "../../../resources/bm25.ts";

// ─── input ──────────────────────────────────────────────────────────────────

/**
 * The subset of a Memory row the profiler reads. Deliberately narrow: fields
 * that do not bear on retrieval difficulty are not accepted, so they cannot
 * be accidentally measured and emitted.
 *
 * `content`, `agentId` and `tags` are read but never emitted — only counted,
 * hashed into distributions, or tokenised into frequencies.
 */
export interface ProfileRecord {
  content: string;
  createdAt?: string | null;
  agentId?: string | null;
  embedding?: ArrayLike<number> | null;
  embeddingModel?: string | null;
  durability?: string | null;
  tags?: string[] | null;
  archived?: boolean | null;
}

export interface ComputeOptions {
  /** k for k-means. Default: clamp(round(sqrt(n/2)), 4, 64). */
  clusterCount?: number;
  /** PRNG seed — k-means init and PCA start vectors. Fixed so profiles reproduce. */
  seed?: number;
  /** Max Lloyd iterations. Default 60. */
  kmeansIterations?: number;
  /** Subspace size for the PCA spectrum. Default 128. */
  pcaComponents?: number;
  /** Subspace iteration count. Default 12. */
  pcaIterations?: number;
  /** Near-duplicate thresholds, ascending. Default [0.8, 0.85, 0.9, 0.95]. */
  nearDupThresholds?: number[];
  /** Coarse histogram bin count in the emitted profile. Default 100. */
  histogramBins?: number;
  /**
   * Refuse above this record count rather than silently switching to sampled
   * nearest-neighbours. Default 12000 (~72M pairs).
   *
   * This is a refusal and not a fallback on purpose. Near-duplicate density is
   * the load-bearing metric in this whole profile, and a nearest neighbour
   * estimated from a random sample of pairs is biased LOW by construction —
   * you only ever find the best neighbour you happened to draw. A profile that
   * quietly understates confusability is worse than no profile, because the
   * generator downstream would build an easier corpus and we would be back to
   * measuring 0.000 and not knowing why.
   */
  maxExhaustiveRecords?: number;
  /** Allow a corpus spanning multiple embedding models. Default false — see below. */
  allowMixedEmbeddingSpaces?: boolean;
  /** `YYYY-MM` stamp for meta.profiledMonth. Defaults to the current month. */
  profiledMonth?: string;
  /** Recorded in meta.scope. The caller decides; compute only reports it. */
  scope?: "retrievable" | "all-records";
  /** Recorded in meta.embeddingSource. */
  embeddingSource?: "stored" | "computed";
}

// ─── output shape ───────────────────────────────────────────────────────────

/** Standard quantile block. Every field is a finite number. */
export interface Dist {
  n: number;
  min: number;
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  stdev: number;
}

export interface Histogram {
  /** Left edge of bin 0. */
  binMin: number;
  /** Width of every bin. */
  binWidth: number;
  /** Counts, low to high. */
  counts: number[];
}

export interface CorpusProfile {
  schemaVersion: number;
  meta: {
    embeddingSource: string;
    embeddingModel: string;
    tokenizer: string;
    clusterAlgorithm: string;
    pairwiseMode: string;
    scope: string;
    firstMonth: string;
    lastMonth: string;
    profiledMonth: string;
  };
  scale: {
    recordCount: number;
    /**
     * Records handed to the profiler that carried no vector and were dropped.
     * Non-zero means every fraction in this profile has a smaller denominator
     * than the corpus it claims to describe — so it is emitted rather than
     * left implicit. A denominator that shrinks silently is the failure this
     * whole issue is about.
     */
    recordsWithoutEmbedding: number;
    distinctAgentCount: number;
    /** Records per agent, DESCENDING. No agent identity, only the shape. */
    recordsPerAgentSorted: number[];
    distinctEmbeddingModelCount: number;
    /** Contiguous monthly series from meta.firstMonth to meta.lastMonth. */
    recordsPerMonth: number[];
    /** Counts in the fixed order [permanent, persistent, standard, ephemeral, other]. */
    durabilityCounts: number[];
    contentChars: Dist;
    contentTokens: Dist;
    tagsPerRecord: Dist;
    distinctTagCount: number;
  };
  nearDuplicate: {
    /** Cosine of each record to its single nearest OTHER record. */
    nearestNeighborCosine: Dist;
    nearestNeighborCosineHistogram: Histogram;
    /** Ascending. Parallel to `fractionWithNeighborAbove`. */
    thresholds: number[];
    /** Fraction of records whose nearest neighbour is at or above the threshold. */
    fractionWithNeighborAbove: number[];
    /** Threshold used to build the connected components below. */
    componentThreshold: number;
    /** Sizes of connected components of size >= 2, DESCENDING. */
    componentSizes: number[];
    recordsInComponents: number;
    /** Jaccard of BM25 token sets between each record and its embedding-nearest neighbour. */
    nearestNeighborJaccard: Dist;
  };
  clusters: {
    k: number;
    /** DESCENDING. No cluster is described, only sized. */
    sizesSorted: number[];
    intraClusterCosine: Dist;
    interClusterCosine: Dist;
    intraClusterCosineHistogram: Histogram;
    interClusterCosineHistogram: Histogram;
    /** Exact silhouette over cosine distance. Higher = better separated. */
    silhouette: Dist;
  };
  geometry: {
    dimension: number;
    pairsEvaluated: number;
    pairwiseCosine: Dist;
    pairwiseCosineHistogram: Histogram;
    /** L2 norms of the stored vectors, before the profiler normalises them. */
    storedVectorNorm: Dist;
    /**
     * Norm of the mean unit vector. 0 = isotropic cloud; near 1 = every vector
     * points the same way, which inflates every cosine and makes retrieval
     * harder for reasons that have nothing to do with the content.
     */
    centroidNorm: number;
    /** trace(C)^2 / ||C||_F^2 — effective dimensionality, exact, no truncation. */
    participationRatio: number;
    /** Component counts at which cumulative variance was measured. */
    varianceExplainedAtK: number[];
    /** Cumulative fraction of total variance, parallel to varianceExplainedAtK. */
    varianceExplainedCumulative: number[];
    /** Fractions probed below. */
    varianceFractions: number[];
    /** Components needed to reach each fraction; 0 = not reached within the computed spectrum. */
    dimensionsForVarianceFraction: number[];
    /** How many eigenvalues were actually computed (the spectrum is truncated). */
    spectrumComponentsComputed: number;
  };
  vocabulary: {
    tokenCount: number;
    typeCount: number;
    typeTokenRatio: number;
    hapaxFraction: number;
    /** Least-squares fit of log10(freq) on log10(rank). Zipf's law predicts ~ -1. */
    zipfSlope: number;
    zipfIntercept: number;
    zipfR2: number;
    /** Log-spaced ranks. Parallel to zipfSampleFrequencies. NEVER rank -> term. */
    zipfSampleRanks: number[];
    zipfSampleFrequencies: number[];
    /** Distinct types per record. */
    typesPerRecord: Dist;
    /** Document frequency of each type, as a distribution over types. */
    documentFrequency: Dist;
  };
}

export const PROFILE_SCHEMA_VERSION = 1;

/** Fixed emission order for `scale.durabilityCounts`. Documented in README.md. */
export const DURABILITY_ORDER = ["permanent", "persistent", "standard", "ephemeral", "other"] as const;

// ─── small numeric helpers ──────────────────────────────────────────────────

/** Deterministic PRNG. Seeded so two runs over the same corpus agree exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(n - 1, lo + 1);
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/** Quantile block from raw values. Empty input yields an all-zero block (never NaN). */
function distribution(values: ArrayLike<number>): Dist {
  const n = values.length;
  if (n === 0) {
    return { n: 0, min: 0, p05: 0, p25: 0, p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0, stdev: 0 };
  }
  const arr = Float64Array.from(values as ArrayLike<number>);
  arr.sort();
  let sum = 0;
  for (let i = 0; i < n; i++) sum += arr[i];
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = arr[i] - mean;
    sq += d * d;
  }
  return {
    n,
    min: arr[0],
    p05: quantileSorted(arr, 0.05),
    p25: quantileSorted(arr, 0.25),
    p50: quantileSorted(arr, 0.5),
    p75: quantileSorted(arr, 0.75),
    p90: quantileSorted(arr, 0.9),
    p95: quantileSorted(arr, 0.95),
    p99: quantileSorted(arr, 0.99),
    max: arr[n - 1],
    mean,
    stdev: n > 1 ? Math.sqrt(sq / (n - 1)) : 0,
  };
}

/**
 * Quantile block recovered from a fine histogram, for populations too large to
 * hold (every pair of records). Accurate to one fine-bin width; the mean and
 * stdev come from exact running sums, not from the bins.
 */
function distributionFromHistogram(
  counts: Float64Array,
  binMin: number,
  binWidth: number,
  total: number,
  sum: number,
  sumSq: number,
  observedMin: number,
  observedMax: number,
): Dist {
  if (total === 0) return distribution([]);
  const centre = (i: number) => binMin + (i + 0.5) * binWidth;
  const at = (p: number): number => {
    const want = p * total;
    let acc = 0;
    for (let i = 0; i < counts.length; i++) {
      acc += counts[i];
      if (acc >= want) return centre(i);
    }
    return centre(counts.length - 1);
  };
  const mean = sum / total;
  const variance = total > 1 ? Math.max(0, (sumSq - total * mean * mean) / (total - 1)) : 0;
  return {
    n: total,
    min: observedMin,
    p05: at(0.05),
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    p95: at(0.95),
    p99: at(0.99),
    max: observedMax,
    mean,
    stdev: Math.sqrt(variance),
  };
}

/** Fold a fine histogram down to the emitted bin count. */
function coarsen(fine: Float64Array, binMin: number, binMax: number, bins: number): Histogram {
  const per = fine.length / bins;
  const counts = new Array<number>(bins).fill(0);
  for (let i = 0; i < fine.length; i++) counts[Math.min(bins - 1, Math.floor(i / per))] += fine[i];
  return { binMin, binWidth: (binMax - binMin) / bins, counts };
}

// ─── linear algebra (small, dense, dependency-free) ─────────────────────────

/** Modified Gram-Schmidt, in place, on a column-major d x b block. */
function orthonormalize(Q: Float64Array, d: number, b: number): void {
  for (let c = 0; c < b; c++) {
    const off = c * d;
    for (let p = 0; p < c; p++) {
      const poff = p * d;
      let dot = 0;
      for (let i = 0; i < d; i++) dot += Q[off + i] * Q[poff + i];
      for (let i = 0; i < d; i++) Q[off + i] -= dot * Q[poff + i];
    }
    let norm = 0;
    for (let i = 0; i < d; i++) norm += Q[off + i] * Q[off + i];
    norm = Math.sqrt(norm);
    if (norm < 1e-12) {
      // Degenerate column — replace with a unit axis so the block stays full
      // rank rather than propagating NaN into the eigenvalues.
      for (let i = 0; i < d; i++) Q[off + i] = i === c % d ? 1 : 0;
    } else {
      for (let i = 0; i < d; i++) Q[off + i] /= norm;
    }
  }
}

/** Eigenvalues of a small dense symmetric matrix, cyclic Jacobi. Descending. */
function symmetricEigenvalues(mIn: Float64Array, n: number): number[] {
  const m = Float64Array.from(mIn);
  const idx = (r: number, c: number) => r * n + c;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += m[idx(p, q)] * m[idx(p, q)];
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = m[idx(p, q)];
        if (Math.abs(apq) < 1e-15) continue;
        const theta = (m[idx(q, q)] - m[idx(p, p)]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = m[idx(k, p)];
          const akq = m[idx(k, q)];
          m[idx(k, p)] = c * akp - s * akq;
          m[idx(k, q)] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = m[idx(p, k)];
          const aqk = m[idx(q, k)];
          m[idx(p, k)] = c * apk - s * aqk;
          m[idx(q, k)] = s * apk + c * aqk;
        }
      }
    }
  }
  const eig: number[] = [];
  for (let i = 0; i < n; i++) eig.push(m[idx(i, i)]);
  eig.sort((a, b) => b - a);
  return eig;
}

// ─── the profiler ───────────────────────────────────────────────────────────

export function computeProfile(records: ProfileRecord[], opts: ComputeOptions = {}): CorpusProfile {
  const seed = opts.seed ?? 20260728;
  const thresholds = (opts.nearDupThresholds ?? [0.8, 0.85, 0.9, 0.95]).slice().sort((a, b) => a - b);
  const histogramBins = opts.histogramBins ?? 100;
  const maxExhaustive = opts.maxExhaustiveRecords ?? 12000;

  // A record with no vector cannot participate in any geometric statistic, so
  // including it would silently change the denominator of every fraction below.
  // Dropped here, and the drop COUNT is emitted (scale.recordsWithoutEmbedding)
  // rather than left implicit — otherwise a corpus half of which failed to
  // embed would produce a confident profile of the other half.
  const withVectors = records.filter(
    (r) => r.embedding != null && (r.embedding as ArrayLike<number>).length > 0,
  );
  const recordsWithoutEmbedding = records.length - withVectors.length;

  const n = withVectors.length;
  if (n < 2) throw new Error(`corpus profiler needs at least 2 records with embeddings, got ${n}`);
  if (n > maxExhaustive) {
    throw new Error(
      `corpus profiler refuses to run on ${n} records (cap ${maxExhaustive}). ` +
        `Nearest-neighbour similarity is the load-bearing metric here and a sampled ` +
        `nearest neighbour is biased low by construction, so the profile would understate ` +
        `confusability without saying so. Raise maxExhaustiveRecords deliberately, and ` +
        `budget O(n^2) time, or profile a subset and record that you did.`,
    );
  }

  const d = (withVectors[0].embedding as ArrayLike<number>).length;
  for (const r of withVectors) {
    if ((r.embedding as ArrayLike<number>).length !== d) {
      throw new Error(
        `embedding dimension is not uniform across the corpus (saw ${d} and ` +
          `${(r.embedding as ArrayLike<number>).length}) — the geometry would be meaningless`,
      );
    }
  }

  const models = new Map<string, number>();
  for (const r of withVectors) {
    const m = r.embeddingModel ?? "";
    models.set(m, (models.get(m) ?? 0) + 1);
  }
  if (models.size > 1 && !opts.allowMixedEmbeddingSpaces) {
    // Not a nicety. Two embedding models produce two different spaces, and
    // cosines computed ACROSS them are arithmetic without meaning — the
    // near-duplicate fraction would be an artefact of the mix, not of the
    // corpus. Refuse loudly rather than emit a number that looks fine.
    throw new Error(
      `corpus spans ${models.size} embedding models — cosine geometry across different ` +
        `embedding spaces is not comparable. Re-embed, filter to one model, or set ` +
        `allowMixedEmbeddingSpaces and state the caveat wherever the profile is used.`,
    );
  }
  const dominantModel = [...models.entries()].sort((a, b) => b[1] - a[1])[0][0];

  // ── vectors: copy out, record raw norms, normalise to the unit sphere ────
  const V = new Float64Array(n * d);
  const storedNorms = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const src = withVectors[i].embedding as ArrayLike<number>;
    const off = i * d;
    let norm = 0;
    for (let t = 0; t < d; t++) {
      const v = src[t];
      V[off + t] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    storedNorms[i] = norm;
    const inv = norm > 0 ? 1 / norm : 0;
    for (let t = 0; t < d; t++) V[off + t] *= inv;
  }

  // ── scale and shape ──────────────────────────────────────────────────────
  const agentCounts = new Map<string, number>();
  const monthCounts = new Map<string, number>();
  const durabilityCounts = new Array<number>(DURABILITY_ORDER.length).fill(0);
  const distinctTags = new Set<string>();
  const charLens = new Float64Array(n);
  const tokenLens = new Float64Array(n);
  const tagsPer = new Float64Array(n);
  const typesPer = new Float64Array(n);

  const termFreq = new Map<string, number>();
  const docFreq = new Map<string, number>();
  const tokenSets: Array<Set<string>> = new Array(n);
  let totalTokens = 0;

  for (let i = 0; i < n; i++) {
    const r = withVectors[i];
    const agent = r.agentId ?? "";
    agentCounts.set(agent, (agentCounts.get(agent) ?? 0) + 1);

    const month = typeof r.createdAt === "string" ? r.createdAt.slice(0, 7) : "";
    if (/^\d{4}-\d{2}$/.test(month)) monthCounts.set(month, (monthCounts.get(month) ?? 0) + 1);

    const dIdx = DURABILITY_ORDER.indexOf((r.durability ?? "") as (typeof DURABILITY_ORDER)[number]);
    durabilityCounts[dIdx >= 0 ? dIdx : DURABILITY_ORDER.length - 1]++;

    const tags = Array.isArray(r.tags) ? r.tags : [];
    tagsPer[i] = tags.length;
    for (const t of tags) distinctTags.add(t);

    const content = typeof r.content === "string" ? r.content : "";
    charLens[i] = content.length;

    const toks = tokenize(content);
    tokenLens[i] = toks.length;
    totalTokens += toks.length;
    const set = new Set(toks);
    tokenSets[i] = set;
    typesPer[i] = set.size;
    for (const t of toks) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
    for (const t of set) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }

  const monthKeys = [...monthCounts.keys()].sort();
  const firstMonth = monthKeys[0] ?? (opts.profiledMonth ?? nowMonth());
  const lastMonth = monthKeys[monthKeys.length - 1] ?? firstMonth;
  const recordsPerMonth = contiguousMonthSeries(monthCounts, firstMonth, lastMonth);

  // ── clustering ───────────────────────────────────────────────────────────
  const k = Math.max(2, Math.min(opts.clusterCount ?? clampK(n), n));
  const assignment = kmeans(V, n, d, k, seed, opts.kmeansIterations ?? 60);
  const clusterSizes = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) clusterSizes[assignment[i]]++;

  // ── the one O(n^2) pass ──────────────────────────────────────────────────
  // Every pairwise statistic below is EXACT, not sampled: nearest neighbours,
  // the full pairwise cosine distribution, intra/inter cluster distributions,
  // silhouette, and the near-duplicate components. Streaming accumulators keep
  // memory at O(n) so exactness costs time, not RAM.
  const FINE = 4000; // bins over [-1, 1] => 0.0005 wide
  const binOf = (s: number) => {
    const b = Math.floor(((s + 1) / 2) * FINE);
    return b < 0 ? 0 : b >= FINE ? FINE - 1 : b;
  };
  const allHist = new Float64Array(FINE);
  const intraHist = new Float64Array(FINE);
  const interHist = new Float64Array(FINE);
  const nnSim = new Float64Array(n).fill(-2);
  const nnIdx = new Int32Array(n).fill(-1);
  const simToCluster = new Float64Array(n * k);
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const componentThreshold = thresholds[thresholds.length - 1];
  let allSum = 0;
  let allSumSq = 0;
  let allMin = Infinity;
  let allMax = -Infinity;
  let intraSum = 0;
  let intraSumSq = 0;
  let intraMin = Infinity;
  let intraMax = -Infinity;
  let intraN = 0;
  let interSum = 0;
  let interSumSq = 0;
  let interMin = Infinity;
  let interMax = -Infinity;
  let interN = 0;

  for (let i = 0; i < n; i++) {
    const oi = i * d;
    const ci = assignment[i];
    for (let j = i + 1; j < n; j++) {
      const oj = j * d;
      let s = 0;
      for (let t = 0; t < d; t++) s += V[oi + t] * V[oj + t];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;

      const b = binOf(s);
      allHist[b]++;
      allSum += s;
      allSumSq += s * s;
      if (s < allMin) allMin = s;
      if (s > allMax) allMax = s;

      if (s > nnSim[i]) {
        nnSim[i] = s;
        nnIdx[i] = j;
      }
      if (s > nnSim[j]) {
        nnSim[j] = s;
        nnIdx[j] = i;
      }

      const cj = assignment[j];
      simToCluster[i * k + cj] += s;
      simToCluster[j * k + ci] += s;
      if (ci === cj) {
        intraHist[b]++;
        intraSum += s;
        intraSumSq += s * s;
        intraN++;
        if (s < intraMin) intraMin = s;
        if (s > intraMax) intraMax = s;
      } else {
        interHist[b]++;
        interSum += s;
        interSumSq += s * s;
        interN++;
        if (s < interMin) interMin = s;
        if (s > interMax) interMax = s;
      }

      if (s >= componentThreshold) union(i, j);
    }
  }

  const totalPairs = (n * (n - 1)) / 2;

  // near-duplicate fractions
  const fractionWithNeighborAbove = thresholds.map((t) => {
    let c = 0;
    for (let i = 0; i < n; i++) if (nnSim[i] >= t) c++;
    return c / n;
  });

  // connected components at the top threshold
  const compSize = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    compSize.set(r, (compSize.get(r) ?? 0) + 1);
  }
  const componentSizes = [...compSize.values()].filter((s) => s >= 2).sort((a, b) => b - a);
  const recordsInComponents = componentSizes.reduce((a, b) => a + b, 0);

  // lexical overlap with the embedding-nearest neighbour
  const nnJaccard = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = nnIdx[i];
    if (j < 0) continue;
    const a = tokenSets[i];
    const b = tokenSets[j];
    if (a.size === 0 && b.size === 0) continue;
    let inter = 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const t of small) if (large.has(t)) inter++;
    nnJaccard[i] = inter / (a.size + b.size - inter);
  }

  // silhouette (exact, cosine distance = 1 - cosine similarity)
  const sil = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ci = assignment[i];
    const own = clusterSizes[ci];
    if (own <= 1) {
      sil[i] = 0;
      continue;
    }
    const a = 1 - simToCluster[i * k + ci] / (own - 1);
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === ci || clusterSizes[c] === 0) continue;
      const dist = 1 - simToCluster[i * k + c] / clusterSizes[c];
      if (dist < b) b = dist;
    }
    sil[i] = Number.isFinite(b) ? (b - a) / Math.max(a, b) : 0;
  }

  // ── geometry: anisotropy and effective dimensionality ────────────────────
  const mu = new Float64Array(d);
  for (let i = 0; i < n; i++) {
    const off = i * d;
    for (let t = 0; t < d; t++) mu[t] += V[off + t];
  }
  let centroidNorm = 0;
  for (let t = 0; t < d; t++) {
    mu[t] /= n;
    centroidNorm += mu[t] * mu[t];
  }
  centroidNorm = Math.sqrt(centroidNorm);

  // C = X^T X / (n-1) over the CENTERED unit vectors.
  const C = new Float64Array(d * d);
  for (let i = 0; i < n; i++) {
    const off = i * d;
    for (let a = 0; a < d; a++) {
      const va = V[off + a] - mu[a];
      if (va === 0) continue;
      const rowOff = a * d;
      for (let b = a; b < d; b++) C[rowOff + b] += va * (V[off + b] - mu[b]);
    }
  }
  const denom = n > 1 ? n - 1 : 1;
  for (let a = 0; a < d; a++) {
    for (let b = a; b < d; b++) {
      const v = C[a * d + b] / denom;
      C[a * d + b] = v;
      C[b * d + a] = v;
    }
  }
  let trace = 0;
  let frob2 = 0;
  for (let a = 0; a < d; a++) {
    trace += C[a * d + a];
    for (let b = 0; b < d; b++) frob2 += C[a * d + b] * C[a * d + b];
  }
  // Exact, no truncation: for symmetric C, sum(lambda) = trace(C) and
  // sum(lambda^2) = ||C||_F^2, so the participation ratio needs no spectrum.
  const participationRatio = frob2 > 0 ? (trace * trace) / frob2 : 0;

  const spectrum = topEigenvalues(
    C,
    d,
    Math.min(opts.pcaComponents ?? 128, d, Math.max(2, n - 1)),
    opts.pcaIterations ?? 12,
    seed,
  );
  const cum: number[] = [];
  let running = 0;
  for (const e of spectrum) {
    running += Math.max(0, e);
    cum.push(trace > 0 ? running / trace : 0);
  }
  const varianceExplainedAtK = [1, 2, 4, 8, 16, 32, 64, 128].filter((x) => x <= spectrum.length);
  const varianceExplainedCumulative = varianceExplainedAtK.map((x) => cum[x - 1]);
  const varianceFractions = [0.5, 0.9, 0.95];
  const dimensionsForVarianceFraction = varianceFractions.map((f) => {
    const idx = cum.findIndex((c) => c >= f);
    return idx < 0 ? 0 : idx + 1; // 0 = not reached within the computed spectrum
  });

  // ── vocabulary shape ─────────────────────────────────────────────────────
  // Frequencies sorted by rank. The terms themselves are dropped on the next
  // line and never leave this function.
  const freqs = [...termFreq.values()].sort((a, b) => b - a);
  const typeCount = freqs.length;
  const hapax = freqs.reduce((acc, f) => acc + (f === 1 ? 1 : 0), 0);
  const zipf = fitZipf(freqs);
  const sampleRanks = logSpacedRanks(typeCount, 40);
  const zipfSampleFrequencies = sampleRanks.map((r) => freqs[r - 1]);

  const profiledMonth = opts.profiledMonth ?? nowMonth();

  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    meta: {
      embeddingSource: opts.embeddingSource ?? "stored",
      embeddingModel: dominantModel,
      tokenizer: "flair-bm25",
      clusterAlgorithm: "kmeans++-seeded",
      pairwiseMode: "exhaustive",
      scope: opts.scope ?? "retrievable",
      firstMonth,
      lastMonth,
      profiledMonth,
    },
    scale: {
      recordCount: n,
      recordsWithoutEmbedding,
      distinctAgentCount: agentCounts.size,
      recordsPerAgentSorted: [...agentCounts.values()].sort((a, b) => b - a),
      distinctEmbeddingModelCount: models.size,
      recordsPerMonth,
      durabilityCounts,
      contentChars: distribution(charLens),
      contentTokens: distribution(tokenLens),
      tagsPerRecord: distribution(tagsPer),
      distinctTagCount: distinctTags.size,
    },
    nearDuplicate: {
      nearestNeighborCosine: distribution(nnSim),
      nearestNeighborCosineHistogram: histogramOf(nnSim, -1, 1, histogramBins),
      thresholds,
      fractionWithNeighborAbove,
      componentThreshold,
      componentSizes,
      recordsInComponents,
      nearestNeighborJaccard: distribution(nnJaccard),
    },
    clusters: {
      k,
      sizesSorted: clusterSizes.slice().sort((a, b) => b - a),
      intraClusterCosine: distributionFromHistogram(
        intraHist, -1, 2 / FINE, intraN, intraSum, intraSumSq,
        intraN ? intraMin : 0, intraN ? intraMax : 0,
      ),
      interClusterCosine: distributionFromHistogram(
        interHist, -1, 2 / FINE, interN, interSum, interSumSq,
        interN ? interMin : 0, interN ? interMax : 0,
      ),
      intraClusterCosineHistogram: coarsen(intraHist, -1, 1, histogramBins),
      interClusterCosineHistogram: coarsen(interHist, -1, 1, histogramBins),
      silhouette: distribution(sil),
    },
    geometry: {
      dimension: d,
      pairsEvaluated: totalPairs,
      pairwiseCosine: distributionFromHistogram(
        allHist, -1, 2 / FINE, totalPairs, allSum, allSumSq,
        totalPairs ? allMin : 0, totalPairs ? allMax : 0,
      ),
      pairwiseCosineHistogram: coarsen(allHist, -1, 1, histogramBins),
      storedVectorNorm: distribution(storedNorms),
      centroidNorm,
      participationRatio,
      varianceExplainedAtK,
      varianceExplainedCumulative,
      varianceFractions,
      dimensionsForVarianceFraction,
      spectrumComponentsComputed: spectrum.length,
    },
    vocabulary: {
      tokenCount: totalTokens,
      typeCount,
      typeTokenRatio: totalTokens > 0 ? typeCount / totalTokens : 0,
      hapaxFraction: typeCount > 0 ? hapax / typeCount : 0,
      zipfSlope: zipf.slope,
      zipfIntercept: zipf.intercept,
      zipfR2: zipf.r2,
      zipfSampleRanks: sampleRanks,
      zipfSampleFrequencies,
      typesPerRecord: distribution(typesPer),
      documentFrequency: distribution([...docFreq.values()]),
    },
  };
}

// ─── pieces ─────────────────────────────────────────────────────────────────

function nowMonth(): string {
  const dt = new Date();
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
}

function clampK(n: number): number {
  return Math.max(4, Math.min(64, Math.round(Math.sqrt(n / 2))));
}

/** Fill month gaps so the emitted series is a contiguous numeric timeline. */
function contiguousMonthSeries(counts: Map<string, number>, first: string, last: string): number[] {
  const out: number[] = [];
  let [y, m] = first.split("-").map(Number);
  const [ly, lm] = last.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(ly) || !Number.isFinite(lm)) return [];
  for (let guard = 0; guard < 2400; guard++) {
    out.push(counts.get(`${y}-${String(m).padStart(2, "0")}`) ?? 0);
    if (y === ly && m === lm) break;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

function histogramOf(values: ArrayLike<number>, lo: number, hi: number, bins: number): Histogram {
  const counts = new Array<number>(bins).fill(0);
  const width = (hi - lo) / bins;
  for (let i = 0; i < values.length; i++) {
    let b = Math.floor((values[i] - lo) / width);
    if (b < 0) b = 0;
    if (b >= bins) b = bins - 1;
    counts[b]++;
  }
  return { binMin: lo, binWidth: width, counts };
}

/** k-means++ init + Lloyd, on unit vectors (cosine ~ Euclidean on the sphere). */
function kmeans(V: Float64Array, n: number, d: number, k: number, seed: number, maxIter: number): Int32Array {
  const rnd = mulberry32(seed);
  const centres = new Float64Array(k * d);
  const first = Math.floor(rnd() * n);
  centres.set(V.subarray(first * d, first * d + d), 0);

  const best = new Float64Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      const dist = 1 - dot(V, i * d, centres, (c - 1) * d, d);
      if (dist < best[i]) best[i] = dist;
      total += best[i] * best[i];
    }
    let target = rnd() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      target -= best[i] * best[i];
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    centres.set(V.subarray(pick * d, pick * d + d), c * d);
  }

  const assignment = new Int32Array(n).fill(-1);
  const sums = new Float64Array(k * d);
  const counts = new Int32Array(k);
  for (let iter = 0; iter < maxIter; iter++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let bestC = 0;
      let bestS = -Infinity;
      for (let c = 0; c < k; c++) {
        const s = dot(V, i * d, centres, c * d, d);
        if (s > bestS) {
          bestS = s;
          bestC = c;
        }
      }
      if (assignment[i] !== bestC) {
        assignment[i] = bestC;
        moved++;
      }
    }
    if (moved === 0 && iter > 0) break;
    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const c = assignment[i];
      counts[c]++;
      const off = i * d;
      const coff = c * d;
      for (let t = 0; t < d; t++) sums[coff + t] += V[off + t];
    }
    for (let c = 0; c < k; c++) {
      const coff = c * d;
      if (counts[c] === 0) {
        // Empty cluster — reseed deterministically rather than leaving a
        // zero centroid that swallows every subsequent assignment.
        const pick = Math.floor(rnd() * n) * d;
        centres.set(V.subarray(pick, pick + d), coff);
        continue;
      }
      let norm = 0;
      for (let t = 0; t < d; t++) norm += sums[coff + t] * sums[coff + t];
      norm = Math.sqrt(norm) || 1;
      for (let t = 0; t < d; t++) centres[coff + t] = sums[coff + t] / norm;
    }
  }
  return assignment;
}

function dot(a: Float64Array, ao: number, b: Float64Array, bo: number, d: number): number {
  let s = 0;
  for (let t = 0; t < d; t++) s += a[ao + t] * b[bo + t];
  return s;
}

/**
 * Top-b eigenvalues of a dense symmetric d x d matrix by randomised subspace
 * iteration + Rayleigh-Ritz. Truncated on purpose: the exact effective
 * dimensionality comes from trace/Frobenius above, and the spectrum is only
 * needed for the variance-explained curve.
 */
function topEigenvalues(C: Float64Array, d: number, b: number, iterations: number, seed: number): number[] {
  const rnd = mulberry32(seed ^ 0x5f3759df);
  const Q = new Float64Array(d * b);
  for (let i = 0; i < Q.length; i++) Q[i] = rnd() * 2 - 1;
  orthonormalize(Q, d, b);
  const Y = new Float64Array(d * b);
  for (let it = 0; it < iterations; it++) {
    Y.fill(0);
    for (let c = 0; c < b; c++) {
      const qo = c * d;
      const yo = c * d;
      for (let r = 0; r < d; r++) {
        let s = 0;
        const ro = r * d;
        for (let t = 0; t < d; t++) s += C[ro + t] * Q[qo + t];
        Y[yo + r] = s;
      }
    }
    Q.set(Y);
    orthonormalize(Q, d, b);
  }
  // T = Q^T C Q
  const CQ = new Float64Array(d * b);
  for (let c = 0; c < b; c++) {
    const qo = c * d;
    for (let r = 0; r < d; r++) {
      let s = 0;
      const ro = r * d;
      for (let t = 0; t < d; t++) s += C[ro + t] * Q[qo + t];
      CQ[c * d + r] = s;
    }
  }
  const T = new Float64Array(b * b);
  for (let a = 0; a < b; a++) {
    for (let c = 0; c < b; c++) {
      let s = 0;
      const ao = a * d;
      const co = c * d;
      for (let t = 0; t < d; t++) s += Q[ao + t] * CQ[co + t];
      T[a * b + c] = s;
    }
  }
  return symmetricEigenvalues(T, b);
}

/** Least-squares log10(freq) ~ a + b*log10(rank). Zipf predicts b close to -1. */
function fitZipf(freqsDesc: number[]): { slope: number; intercept: number; r2: number } {
  const m = Math.min(freqsDesc.length, 10000);
  if (m < 3) return { slope: 0, intercept: 0, r2: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < m; i++) {
    const x = Math.log10(i + 1);
    const y = Math.log10(freqsDesc[i]);
    sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
  }
  const denom = m * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: 0, r2: 0 };
  const slope = (m * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / m;
  const ssTot = syy - (sy * sy) / m;
  const ssRes = syy - intercept * sy - slope * sxy;
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { slope, intercept, r2 };
}

/** Log-spaced, strictly increasing, de-duplicated ranks in [1, typeCount]. */
function logSpacedRanks(typeCount: number, points: number): number[] {
  if (typeCount <= 0) return [];
  const out: number[] = [];
  const hi = Math.log10(typeCount);
  for (let i = 0; i < points; i++) {
    const r = Math.round(Math.pow(10, (i / Math.max(1, points - 1)) * hi));
    const clamped = Math.max(1, Math.min(typeCount, r));
    if (out.length === 0 || clamped > out[out.length - 1]) out.push(clamped);
  }
  return out;
}
