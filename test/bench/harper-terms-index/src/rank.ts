// Score oracle for the spike. Same formula and accumulation order as
// resources/bm25.ts buildBM25 and resources/bm25-index.ts Bm25Index.rank:
// query terms in first-seen order, idf = ln(1 + (N - df + 0.5) / (df + 0.5)),
// length norm avgdl = sum(dl) / N, sort score DESC then id ASC, drop score 0.
//
// This is the equivalence yardstick. Latency of "today" is Bm25Index.rank
// itself (timed in the Harper resource), not this oracle.

import { BM25_B, BM25_K1, buildBM25, tokenize } from "../../../../resources/bm25.js";
import { Bm25Index } from "../../../../resources/bm25-index.js";
import { buildModel, docAt, queryBank, type SynthDoc } from "./corpus.js";

export function packTf(tf: Map<string, number>): string {
  const parts: string[] = [];
  for (const term of [...tf.keys()].sort()) parts.push(`${term}:${tf.get(term)}`);
  return parts.join(",");
}

/** tf of `term` in a packed string. Terms are `t<digits>`, so `t1:` does not match `t10:`. */
export function tfOf(packed: string, term: string): number {
  if (!packed) return 0;
  const needle = `${term}:`;
  let i = 0;
  while (i < packed.length) {
    const comma = packed.indexOf(",", i);
    const end = comma === -1 ? packed.length : comma;
    const field = packed.slice(i, end);
    if (field.startsWith(needle)) return Number(field.slice(needle.length));
    if (comma === -1) break;
    i = comma + 1;
  }
  return 0;
}

export interface OracleSlot {
  id: string;
  dl: number;
  agentId: string;
  tfPacked: string;
}

export interface RankHit {
  id: string;
  score: number;
}

export interface RankResult {
  hits: RankHit[];
  N: number;
  sumDl: number;
  avgdl: number;
  df: number[];
}

export class Oracle {
  readonly slots: OracleSlot[] = [];
  private readonly postings = new Map<string, number[]>();

  add(doc: { id: string; agentId: string; docLen: number; tf: Map<string, number> }): void {
    const slot = this.slots.length;
    this.slots.push({
      id: doc.id,
      dl: doc.docLen,
      agentId: doc.agentId,
      tfPacked: packTf(doc.tf),
    });
    for (const term of doc.tf.keys()) {
      let list = this.postings.get(term);
      if (!list) {
        list = [];
        this.postings.set(term, list);
      }
      list.push(slot);
    }
  }

  rank(terms: readonly string[], scopeAgent: string | null, limit: number): RankResult {
    let N = 0;
    let sumDl = 0;
    for (const slot of this.slots) {
      if (scopeAgent !== null && slot.agentId !== scopeAgent) continue;
      N++;
      sumDl += slot.dl;
    }
    const avgdl = sumDl / (N || 1);
    const lengthNorm = avgdl || 1;
    const df: number[] = new Array(terms.length).fill(0);
    const lists: number[][] = new Array(terms.length);
    for (let i = 0; i < terms.length; i++) {
      const all = this.postings.get(terms[i]);
      if (!all) {
        lists[i] = [];
        continue;
      }
      if (scopeAgent === null) {
        lists[i] = all;
        df[i] = all.length;
      } else {
        const scoped: number[] = [];
        for (const s of all) if (this.slots[s].agentId === scopeAgent) scoped.push(s);
        lists[i] = scoped;
        df[i] = scoped.length;
      }
    }
    const scores = new Map<number, number>();
    for (let i = 0; i < terms.length; i++) {
      const n = df[i];
      if (n === 0) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      for (const s of lists[i]) {
        const slot = this.slots[s];
        const f = tfOf(slot.tfPacked, terms[i]);
        if (!f) continue;
        const numer = f * (BM25_K1 + 1);
        const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (slot.dl / lengthNorm));
        scores.set(s, (scores.get(s) || 0) + idf * (numer / denom));
      }
    }
    const hits: RankHit[] = [];
    for (const [s, score] of scores) if (score > 0) hits.push({ id: this.slots[s].id, score });
    hits.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { hits: hits.slice(0, limit), N, sumDl, avgdl, df };
  }
}

export function oracleFromDocs(docs: readonly SynthDoc[]): Oracle {
  const oracle = new Oracle();
  for (const d of docs) oracle.add(d);
  return oracle;
}

function conditionsFor(scopeAgent: string | null) {
  const archived = { attribute: "archived", comparator: "equals", value: false };
  if (scopeAgent === null) return [archived];
  return [{ attribute: "agentId", comparator: "equals", value: scopeAgent }, archived];
}

function assertHits(label: string, expected: { id: string; score: number }[], got: RankHit[]): void {
  const n = Math.max(expected.length, got.length);
  for (let i = 0; i < n; i++) {
    const e = expected[i];
    const g = got[i];
    if (!e || !g || e.id !== g.id || e.score !== g.score) {
      throw new Error(
        `${label} diverged at rank ${i}: expected ${e ? `${e.id}@${e.score}` : "∅"} got ${g ? `${g.id}@${g.score}` : "∅"}`,
      );
    }
  }
}

/**
 * Refuses to measure if the oracle drifts from buildBM25 or from Bm25Index
 * id order. Runs in the harness process before Harper starts, and the same
 * function is safe to call inside Harper (both modules are Harper-free).
 */
export function assertOracleMatchesShipped(seed = 2047): void {
  const n = 120;
  const model = buildModel(n, seed);
  const docs: SynthDoc[] = [];
  for (let i = 0; i < n; i++) {
    const d = docAt(model, i);
    const tokens = tokenize(d.content);
    if (tokens.length !== d.docLen) {
      throw new Error(`tokenize length ${tokens.length} != generated ${d.docLen} for ${d.id}`);
    }
    for (let k = 0; k < tokens.length; k++) {
      if (tokens[k] !== d.content.split(" ")[k]) throw new Error(`token drift at ${d.id}[${k}]`);
    }
    docs.push(d);
  }
  const oracle = oracleFromDocs(docs);
  const index = new Bm25Index();
  for (const d of docs) index.upsert({ id: d.id, content: d.content, agentId: d.agentId, archived: false });

  const scopes: (string | null)[] = [null, model.dominantScope];
  for (const q of queryBank(model.V)) {
    for (const scope of scopes) {
      const label = `${q.band}/${q.terms.length}/${scope ?? "broad"}`;
      const pool = scope === null ? docs : docs.filter((d) => d.agentId === scope);
      const bm = buildBM25(pool.map((d) => ({ id: d.id, content: d.content })));
      const expected = bm.rank(q.text).filter((h) => h.score > 0).slice(0, 50);
      const got = oracle.rank(q.terms, scope, 50);
      assertHits(`oracle vs buildBM25 ${label}`, expected, got.hits);
      const ids = index.rank({ q: q.text, conditions: conditionsFor(scope), limit: 50 });
      if (!ids) throw new Error(`Bm25Index declined ${label}`);
      const gotIds = got.hits.map((h) => h.id);
      if (ids.length !== gotIds.length || ids.some((id, i) => id !== gotIds[i])) {
        throw new Error(`Bm25Index ids diverged for ${label}: ${ids.slice(0, 5)} vs ${gotIds.slice(0, 5)}`);
      }
    }
  }
}
