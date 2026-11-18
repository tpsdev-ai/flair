/** Nearest-rank percentile. `p` is in (0, 1]. Empty input returns NaN. */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

export interface Dist {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function dist(samples: readonly number[]): Dist {
  if (samples.length === 0) {
    return { n: 0, min: NaN, p50: NaN, p95: NaN, p99: NaN, max: NaN, mean: NaN };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  let sum = 0;
  for (const x of sorted) sum += x;
  return {
    n: sorted.length,
    min: sorted[0],
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}
