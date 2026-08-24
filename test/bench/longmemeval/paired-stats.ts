/**
 * paired-stats.ts — the read for a PAIRED binary A/B.
 *
 * A paired design (same question, same retrieved set, two reader payload
 * formats) makes the two arms' errors correlated, and that correlation is the
 * whole point: the questions where BOTH formats are right, or BOTH wrong, carry
 * no information about which format is better. Only the DISCORDANT pairs do.
 * That is why n=60 paired is worth roughly 3× n=60 unpaired here — the noise
 * from question difficulty is differenced away instead of being sampled twice.
 *
 * So the statistic is McNemar's, computed EXACTLY (binomial), not by the
 * chi-square approximation: with ~60 pairs the discordant count is small enough
 * that the approximation is unreliable in precisely the regime we care about.
 *
 * Deliberately NOT provided: any "significant / not significant" verdict. The
 * caller reports wins, losses, the discordant count and the p-value, and a human
 * judges. A harness that stamps SIGNIFICANT on a 4-vs-1 split is a check that
 * cannot fire.
 */

/** log(n!) via lgamma, so binomial terms stay exact enough at any n we use. */
function lnFactorial(n: number): number {
  // Lanczos-free: exact small-n table + Stirling series above it. n here is <= a
  // few hundred, and we only ever difference logs, so this is plenty.
  let acc = 0;
  for (let i = 2; i <= n; i++) acc += Math.log(i);
  return acc;
}

function lnChoose(n: number, k: number): number {
  return lnFactorial(n) - lnFactorial(k) - lnFactorial(n - k);
}

/** P(X >= k) for X ~ Binomial(n, 0.5). */
export function binomialUpperTail(n: number, k: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let p = 0;
  for (let i = k; i <= n; i++) p += Math.exp(lnChoose(n, i) - n * Math.LN2);
  return Math.min(1, p);
}

export interface McNemarResult {
  /** v1 wrong, v2 right. */
  wins: number;
  /** v1 right, v2 wrong. */
  losses: number;
  /** wins + losses — the only pairs carrying information. */
  discordant: number;
  /** Exact two-sided McNemar p-value. 1 when there are no discordant pairs. */
  p: number;
  /** Which side the discordant pairs lean, or "tie". */
  direction: "v2" | "v1" | "tie";
  /** The smallest one-sided split at this discordant count that would reach
   *  p<0.05 two-sided — i.e. what this run COULD have detected. Reported so a
   *  null result is legible as "underpowered" vs "no effect". */
  minSplitForP05: number | null;
}

/**
 * Exact two-sided McNemar test on the discordant cells of a paired 2x2.
 * Two-sided p = min(1, 2 * P(X >= max(wins, losses))), X ~ Binomial(d, 0.5).
 */
export function mcnemarExact(wins: number, losses: number): McNemarResult {
  const discordant = wins + losses;
  const k = Math.max(wins, losses);
  const p = discordant === 0 ? 1 : Math.min(1, 2 * binomialUpperTail(discordant, k));
  let minSplit: number | null = null;
  for (let cand = Math.ceil(discordant / 2); cand <= discordant; cand++) {
    if (Math.min(1, 2 * binomialUpperTail(discordant, cand)) < 0.05) { minSplit = cand; break; }
  }
  return {
    wins, losses, discordant, p,
    direction: wins > losses ? "v2" : losses > wins ? "v1" : "tie",
    minSplitForP05: minSplit,
  };
}

/** The full paired 2x2 over a set of (v1correct, v2correct) outcomes. */
export interface PairedTable {
  bothRight: number;
  bothWrong: number;
  wins: number;     // v1 wrong, v2 right
  losses: number;   // v1 right, v2 wrong
  n: number;
  v1Accuracy: number;
  v2Accuracy: number;
  /** v2 − v1, in accuracy points. Equals (wins − losses) / n exactly. */
  delta: number;
}

export function pairedTable(pairs: Array<{ v1: boolean; v2: boolean }>): PairedTable {
  let bothRight = 0, bothWrong = 0, wins = 0, losses = 0;
  for (const { v1, v2 } of pairs) {
    if (v1 && v2) bothRight++;
    else if (!v1 && !v2) bothWrong++;
    else if (!v1 && v2) wins++;
    else losses++;
  }
  const n = pairs.length;
  const v1Accuracy = n === 0 ? 0 : (bothRight + losses) / n;
  const v2Accuracy = n === 0 ? 0 : (bothRight + wins) / n;
  return { bothRight, bothWrong, wins, losses, n, v1Accuracy, v2Accuracy, delta: v2Accuracy - v1Accuracy };
}
