/**
 * extraction.ts — the INDEPENDENT F1/EM cross-check on the factual subset.
 *
 * Why it exists: an LLM judge can be lenient (the LightRAG cautionary case —
 * 0.96 judge accuracy against 0.09 F1). The cross-check is only meaningful if it
 * is computed WITHOUT the judge — a separate, pinned, deterministic extraction
 * against LongMemEval's own gold answer key (Sherlock #5, Kern §4b). So this
 * file is pure string math: SQuAD-style normalisation + token F1 + a
 * containment EM. No model, no network, no judge.
 *
 * Applied to the FACTUAL subset only — information-extraction, multi-session,
 * temporal, and knowledge-update. Preference (graded against a rubric, not a
 * fact) and abstention (no factual gold) are excluded, defined by question type
 * up front, not by post-hoc filtering (Kern §4b).
 *
 * The F1/EM number is EXPECTED to sit below the judge accuracy — a short gold
 * answer embedded in a fluent sentence scores lower on token overlap than a
 * human/judge would. The value is the GAP: a large judge-vs-F1 gap is the
 * signal that the judge may be lenient, which is exactly what this catches.
 */

/** SQuAD normalisation: lowercase, strip punctuation, drop articles, collapse
 *  whitespace. Deterministic and dependency-free. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(a|an|the)\b/g, " ")
    .replace(/[‘’“”]/g, "'")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  const n = normalize(s);
  return n.length ? n.split(" ") : [];
}

/** SQuAD token-overlap F1 between a prediction and a single gold answer. */
export function tokenF1(prediction: string, gold: string): number {
  const p = tokens(prediction);
  const g = tokens(gold);
  if (p.length === 0 && g.length === 0) return 1;
  if (p.length === 0 || g.length === 0) return 0;
  // Multiset intersection.
  const gCounts = new Map<string, number>();
  for (const t of g) gCounts.set(t, (gCounts.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of p) {
    const c = gCounts.get(t) ?? 0;
    if (c > 0) { overlap++; gCounts.set(t, c - 1); }
  }
  if (overlap === 0) return 0;
  const precision = overlap / p.length;
  const recall = overlap / g.length;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Containment EM: 1 if the normalised gold answer appears as a contiguous
 * token-boundary substring of the normalised prediction, else 0. This is the
 * fair EM for a RAG reader (a fluent sentence "You graduated with a degree in
 * Business Administration" should EM-match gold "Business Administration"),
 * unlike strict string equality which would be ~0 for every sentence answer.
 * We also expose strict EM for transparency.
 */
export function containmentEM(prediction: string, gold: string): number {
  const p = ` ${normalize(prediction)} `;
  const g = normalize(gold);
  if (g.length === 0) return 0;
  return p.includes(` ${g} `) ? 1 : 0;
}

export function strictEM(prediction: string, gold: string): number {
  return normalize(prediction) === normalize(gold) ? 1 : 0;
}

export interface ExtractionScore {
  f1: number;
  containmentEM: number;
  strictEM: number;
}

/**
 * Score one prediction against gold answer(s). LongMemEval gives a single
 * answer string per question; we accept an array to support alias sets (max
 * over aliases — the standard SQuAD reduction). A `|`-delimited gold string is
 * split into aliases.
 */
export function scoreExtraction(prediction: string, gold: string | string[]): ExtractionScore {
  const golds = (Array.isArray(gold) ? gold : String(gold).split("|")).map((g) => g.trim()).filter(Boolean);
  if (golds.length === 0) return { f1: 0, containmentEM: 0, strictEM: 0 };
  let best: ExtractionScore = { f1: 0, containmentEM: 0, strictEM: 0 };
  for (const g of golds) {
    const s: ExtractionScore = {
      f1: tokenF1(prediction, g),
      containmentEM: containmentEM(prediction, g),
      strictEM: strictEM(prediction, g),
    };
    // Rank aliases by F1 (the primary cross-check metric).
    if (s.f1 > best.f1 || (s.f1 === best.f1 && s.containmentEM > best.containmentEM)) best = s;
  }
  return best;
}

/** The pinned extraction identity, folded into the config hash. */
export const EXTRACTION_METHOD = {
  name: "squad-normalize+token-f1+containment-em",
  version: "1.0.0",
} as const;
