/**
 * scorer.ts — precision@3 / MRR scoring, faithfully replicated from
 * test/bench/recall-harness/run.ts's `statsFor()` (that function is not
 * exported, so it can't be imported directly — see test/scorer-sync.test.ts,
 * which parses run.ts's source text and asserts it still contains this
 * exact formula, so a change to the harness's scoring math trips a loud
 * failure here instead of silently drifting).
 *
 * KEEP THIS FUNCTION BYTE-FOR-BYTE IDENTICAL (modulo variable/type names) to
 * run.ts's `statsFor()`:
 *
 *   function statsFor(rows: QueryRow[]): { p3: number; mrr: number; n: number } {
 *     if (!rows.length) return { p3: 0, mrr: 0, n: 0 };
 *     const hits3 = rows.filter(r => r.rank >= 0 && r.rank < 3).length;
 *     const rr = rows.reduce((s, r) => s + (r.rank >= 0 ? 1 / (r.rank + 1) : 0), 0);
 *     return { p3: hits3 / rows.length, mrr: rr / rows.length, n: rows.length };
 *   }
 */

import type { QueryKind } from "./corpus-v2.js";
import type { AggregateStat, PerKindStat } from "./types.js";

export interface ScoredRow {
  /** 0-based rank of the expected record, or -1 if not found. */
  rank: number;
  kind: QueryKind;
}

export function statsFor(rows: readonly { rank: number }[]): AggregateStat {
  if (!rows.length) return { p3: 0, mrr: 0, n: 0 };
  const hits3 = rows.filter((r) => r.rank >= 0 && r.rank < 3).length;
  const rr = rows.reduce((s, r) => s + (r.rank >= 0 ? 1 / (r.rank + 1) : 0), 0);
  return { p3: hits3 / rows.length, mrr: rr / rows.length, n: rows.length };
}

const ALL_KINDS: QueryKind[] = ["stress", "trap", "hard", "clean"];

export function scoreRows(rows: readonly ScoredRow[]): { aggregate: AggregateStat; perKind: Record<QueryKind, PerKindStat> } {
  const aggregate = statsFor(rows);
  const perKind = Object.fromEntries(ALL_KINDS.map((k) => [k, statsFor(rows.filter((r) => r.kind === k))])) as Record<
    QueryKind,
    PerKindStat
  >;
  return { aggregate, perKind };
}
