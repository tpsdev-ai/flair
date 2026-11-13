// In-process spike driver. Harper loads the bundled resources/Bm25TermsSpike.js.
// Every timed put and search runs in this process: a term lookup is an
// in-process index read, which is the cost the design note called a round trip.
//
// Arms:
//   baseline   — SpikeBase row, no terms index (today's lexical payload)
//   terms      — SpikeTerms row with terms[] @indexed, plus per-scope N/sumDl
//                maintained in the same transaction (the decision arm)
//   terms-noagg — SpikeAlt, terms index, no scope aggregate
//   terms-df   — SpikeAlt cleared, terms index + a df counter row per (scope, term)

import { Resource, databases, transaction } from "harper";
import { BM25_B, BM25_K1, tokenize } from "../../../../resources/bm25.js";
import { Bm25Index } from "../../../../resources/bm25-index.js";
import { buildModel, docAt, docId, queryBank, type CorpusModel, type QuerySpec } from "./corpus.js";
import { Oracle, packTf, tfOf, type RankHit, type RankResult } from "./rank.js";
import { dist, type Dist } from "./stats.js";

type Arm = "baseline" | "terms" | "terms-noagg" | "terms-df";

interface Ready {
  model: CorpusModel;
  index: Bm25Index;
  oracle: Oracle;
  coldBuildMs: number;
  oracleBuildMs: number;
  scanned: number;
}

let ready: Ready | null = null;

function db(): any {
  const spike = (databases as any).spike;
  if (!spike) {
    throw new Error(`spike database missing; databases=${Object.keys(databases as any).join(",")}`);
  }
  return spike;
}

async function owned<T>(fn: () => Promise<T>): Promise<T> {
  return await (transaction as any)({}, fn);
}

function tfFromTokens(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

async function bumpStat(stat: any, id: string, dl: number): Promise<void> {
  const cur = await stat.get(id);
  await stat.put({ id, n: (cur?.n ?? 0) + 1, sumDl: (cur?.sumDl ?? 0) + dl });
}

async function bumpDf(table: any, id: string): Promise<void> {
  const cur = await table.get(id);
  await table.put({ id, df: (cur?.df ?? 0) + 1 });
}

function nsToMs(ns: bigint): number {
  return Number(ns) / 1e6;
}

async function ingest(body: { arm?: Arm; n?: number; seed?: number }): Promise<unknown> {
  const arm: Arm = body.arm ?? "baseline";
  const n = body.n ?? 0;
  const seed = body.seed ?? 2047;
  if (!Number.isInteger(n) || n <= 0) throw new Error(`n must be a positive integer, got ${n}`);
  const model = buildModel(n, seed);
  const tables = db();
  const target =
    arm === "baseline" ? tables.SpikeBase :
    arm === "terms" ? tables.SpikeTerms :
    tables.SpikeAlt;
  if (arm === "terms-noagg" || arm === "terms-df") {
    if (typeof target.clear === "function") await target.clear();
    if (arm === "terms-df" && typeof tables.SpikeTermDf.clear === "function") await tables.SpikeTermDf.clear();
  }

  const putMs: number[] = [];
  const tokenizeMs: number[] = [];
  const combinedMs: number[] = [];
  const docLens: number[] = [];
  const uniqueCounts: number[] = [];
  let tfBytes = 0;
  let contentBytes = 0;
  let termEntries = 0;
  const scopeCounts = new Map<string, number>();
  const wall0 = process.hrtime.bigint();

  for (let i = 0; i < n; i++) {
    const d = docAt(model, i);
    contentBytes += d.content.length;
    scopeCounts.set(d.agentId, (scopeCounts.get(d.agentId) || 0) + 1);
    let tokens: string[] = [];
    let packed = "";
    let terms: string[] = [];
    let tokMs = 0;
    if (arm !== "baseline") {
      const t0 = process.hrtime.bigint();
      tokens = tokenize(d.content);
      tokMs = nsToMs(process.hrtime.bigint() - t0);
      tokenizeMs.push(tokMs);
      const tf = tfFromTokens(tokens);
      packed = packTf(tf);
      terms = [...tf.keys()].sort();
      tfBytes += packed.length;
      termEntries += terms.length;
      docLens.push(tokens.length);
      uniqueCounts.push(terms.length);
    } else {
      docLens.push(d.docLen);
      uniqueCounts.push(d.terms.length);
    }

    const row: any = {
      id: d.id,
      agentId: d.agentId,
      archived: false,
      content: d.content,
      docLen: arm === "baseline" ? d.docLen : tokens.length,
    };
    if (arm !== "baseline") {
      row.tfPacked = packed;
      row.terms = terms;
    }

    const p0 = process.hrtime.bigint();
    await owned(async () => {
      await target.put(row);
      if (arm === "terms") {
        await bumpStat(tables.SpikeScopeStat, d.agentId, row.docLen);
        await bumpStat(tables.SpikeScopeStat, "__all__", row.docLen);
      }
      if (arm === "terms-df") {
        for (const term of terms) {
          await bumpDf(tables.SpikeTermDf, `${d.agentId}\u0000${term}`);
          await bumpDf(tables.SpikeTermDf, `__all__\u0000${term}`);
        }
      }
    });
    const pMs = nsToMs(process.hrtime.bigint() - p0);
    putMs.push(pMs);
    combinedMs.push(pMs + tokMs);
    if ((i + 1) % 2000 === 0) console.log(`spike: ingest ${arm} ${i + 1}/${n}`);
  }

  const wallMs = nsToMs(process.hrtime.bigint() - wall0);
  let contentAgreesWithBaseline: boolean | null = null;
  if (arm === "terms") {
    const stored = await owned(() => tables.SpikeBase.get(docId(0)));
    contentAgreesWithBaseline = stored?.content === docAt(model, 0).content;
  }
  console.log(`spike: ingest ${arm} done n=${n} wallMs=${wallMs.toFixed(0)}`);
  return {
    arm,
    n,
    seed,
    V: model.V,
    dominantScope: model.dominantScope,
    wallMs,
    docsPerSec: n / (wallMs / 1000),
    put: dist(putMs),
    tokenize: dist(tokenizeMs),
    putPlusTokenize: dist(arm === "baseline" ? putMs : combinedMs),
    docLen: dist(docLens),
    uniqueTerms: dist(uniqueCounts),
    contentBytes,
    tfBytes,
    termEntries,
    meanIndexEntriesPerPut: termEntries / n,
    contentAgreesWithBaseline,
    scopes: [...scopeCounts.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count),
  };
}

async function coldBuild(): Promise<unknown> {
  const tables = db();
  const index = new Bm25Index();
  const oracle = new Oracle();
  const t0 = process.hrtime.bigint();
  let scanned = 0;
  await owned(async () => {
    for await (const row of tables.SpikeBase.search({
      select: ["id", "content", "agentId", "archived"],
    })) {
      index.upsert({
        id: row.id,
        content: row.content,
        agentId: row.agentId,
        archived: row.archived,
      });
      scanned++;
    }
  });
  const coldBuildMs = nsToMs(process.hrtime.bigint() - t0);

  const t1 = process.hrtime.bigint();
  await owned(async () => {
    for await (const row of tables.SpikeBase.search({
      select: ["id", "content", "agentId"],
    })) {
      const tokens = tokenize(row.content || "");
      const tf = tfFromTokens(tokens);
      oracle.add({ id: row.id, agentId: row.agentId, docLen: tokens.length, tf });
    }
  });
  const oracleBuildMs = nsToMs(process.hrtime.bigint() - t1);
  ready = { model: buildModel(scanned, 0), index, oracle, coldBuildMs, oracleBuildMs, scanned };
  // buildModel(scanned, 0) is only a placeholder for V-independent fields; the
  // query bank uses the V stored from ingest via readyModel below.
  console.log(`spike: cold build ${scanned} docs in ${coldBuildMs.toFixed(0)}ms index=${index.size}`);
  return {
    scanned,
    coldBuildMs,
    oracleBuildMs,
    indexSize: index.size,
    postings: index.postingCount,
    terms: index.termCount,
  };
}

let queryModel: CorpusModel | null = null;

function rememberModel(n: number, seed: number): CorpusModel {
  queryModel = buildModel(n, seed);
  return queryModel;
}

function modelOrThrow(): CorpusModel {
  if (!queryModel) throw new Error("no corpus model; ingest first");
  return queryModel;
}

function conditions(scopeAgent: string | null) {
  const archived = { attribute: "archived", comparator: "equals", value: false };
  if (scopeAgent === null) return [archived];
  return [
    { attribute: "agentId", comparator: "equals", value: scopeAgent },
    archived,
  ];
}

async function memoryQuery(index: Bm25Index, q: QuerySpec, scopeAgent: string | null, limit: number): Promise<number> {
  const t0 = process.hrtime.bigint();
  const ids = index.rank({ q: q.text, conditions: conditions(scopeAgent), limit });
  const ms = nsToMs(process.hrtime.bigint() - t0);
  if (!ids) throw new Error(`Bm25Index declined ${q.text}`);
  return ms;
}

interface HarperRank extends RankResult {
  ms: number;
  planLead?: string;
}

async function loadPostings(table: any, term: string, scopeAgent: string | null): Promise<{ id: string; dl: number; tf: number }[]> {
  const conds: any[] = [
    { attribute: "terms", comparator: "equals", value: term },
    { attribute: "archived", comparator: "equals", value: false },
  ];
  if (scopeAgent !== null) conds.push({ attribute: "agentId", comparator: "equals", value: scopeAgent });
  const hits: { id: string; dl: number; tf: number }[] = [];
  await owned(async () => {
    for await (const row of table.search({
      conditions: conds,
      select: ["id", "docLen", "tfPacked", "agentId", "archived"],
    })) {
      if (scopeAgent !== null && row.agentId !== scopeAgent) continue;
      if (row.archived === true) continue;
      const tf = tfOf(row.tfPacked || "", term);
      if (!tf) continue;
      hits.push({ id: row.id, dl: Number(row.docLen) || 0, tf });
    }
  });
  return hits;
}

async function scopeAggregate(scopeAgent: string | null): Promise<{ N: number; sumDl: number }> {
  const id = scopeAgent ?? "__all__";
  const row = await owned(() => db().SpikeScopeStat.get(id));
  return { N: row?.n ?? 0, sumDl: row?.sumDl ?? 0 };
}

async function harperRankShipped(q: QuerySpec, scopeAgent: string | null, limit: number, stats: "aggregate" | "scan"): Promise<HarperRank> {
  const table = db().SpikeTerms;
  const t0 = process.hrtime.bigint();
  let N = 0;
  let sumDl = 0;
  if (stats === "aggregate") {
    const agg = await scopeAggregate(scopeAgent);
    N = agg.N;
    sumDl = agg.sumDl;
  } else {
    await owned(async () => {
      for await (const row of table.search({ conditions: conditions(scopeAgent), select: ["docLen"] })) {
        N++;
        sumDl += Number(row.docLen) || 0;
      }
    });
  }
  const avgdl = sumDl / (N || 1);
  const lengthNorm = avgdl || 1;
  const perTerm: { id: string; dl: number; tf: number }[][] = [];
  const df: number[] = [];
  for (const term of q.terms) {
    const hits = await loadPostings(table, term, scopeAgent);
    perTerm.push(hits);
    df.push(hits.length);
  }
  const scores = new Map<string, number>();
  for (let i = 0; i < q.terms.length; i++) {
    const nDf = df[i];
    if (nDf === 0) continue;
    const idf = Math.log(1 + (N - nDf + 0.5) / (nDf + 0.5));
    for (const hit of perTerm[i]) {
      const numer = hit.tf * (BM25_K1 + 1);
      const denom = hit.tf + BM25_K1 * (1 - BM25_B + BM25_B * (hit.dl / lengthNorm));
      scores.set(hit.id, (scores.get(hit.id) || 0) + idf * (numer / denom));
    }
  }
  const hits: RankHit[] = [];
  for (const [id, score] of scores) if (score > 0) hits.push({ id, score });
  hits.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { hits: hits.slice(0, limit), N, sumDl, avgdl, df, ms: nsToMs(process.hrtime.bigint() - t0) };
}

async function explainLead(q: QuerySpec, scopeAgent: string | null): Promise<unknown> {
  const conds: any[] = [
    { attribute: "terms", comparator: "equals", value: q.terms[0] },
    { attribute: "archived", comparator: "equals", value: false },
  ];
  if (scopeAgent !== null) conds.push({ attribute: "agentId", comparator: "equals", value: scopeAgent });
  const explained = await owned(() => db().SpikeTerms.search({ conditions: conds, explain: true }));
  const lead = explained?.conditions?.[0];
  return {
    query: q.text,
    scope: scopeAgent,
    lead: lead ? { attribute: lead.attribute, comparator: lead.comparator, value: lead.value, estimated_count: lead.estimated_count } : explained,
  };
}

async function timeGlobalDf(term: string, reps: number): Promise<{ dist: Dist; value?: number; error?: string; indexKeys?: string[] }> {
  const table = db().SpikeTerms;
  const indices = table.indices;
  const indexKeys = indices ? Object.keys(indices) : [];
  const idx = indices?.terms;
  if (!idx || typeof idx.getValuesCount !== "function") {
    return { dist: dist([]), error: "terms index has no getValuesCount", indexKeys };
  }
  const samples: number[] = [];
  let value = 0;
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    value = idx.getValuesCount(term);
    samples.push(nsToMs(process.hrtime.bigint() - t0));
  }
  return { dist: dist(samples), value, indexKeys };
}

async function timeScopePoint(reps: number): Promise<Dist> {
  const samples: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    await scopeAggregate(null);
    await scopeAggregate(modelOrThrow().dominantScope);
    samples.push(nsToMs(process.hrtime.bigint() - t0));
  }
  return dist(samples);
}

function compareRank(label: string, expected: RankResult, got: RankResult, limit: number): unknown {
  const diffs: unknown[] = [];
  const n = Math.min(limit, Math.max(expected.hits.length, got.hits.length));
  let mismatch = 0;
  for (let i = 0; i < n; i++) {
    const e = expected.hits[i];
    const g = got.hits[i];
    if (!e || !g || e.id !== g.id || e.score !== g.score) {
      mismatch++;
      if (diffs.length < 5) diffs.push({ rank: i, expected: e ?? null, got: g ?? null });
    }
  }
  return {
    label,
    match: mismatch === 0 && expected.hits.length === got.hits.length,
    expectedN: expected.N,
    gotN: got.N,
    expectedAvgdl: expected.avgdl,
    gotAvgdl: got.avgdl,
    expectedDf: expected.df,
    gotDf: got.df,
    compared: n,
    mismatches: mismatch,
    diffs,
  };
}

async function measure(body: { reps?: number; warmup?: number; limit?: number; n?: number; seed?: number }): Promise<unknown> {
  if (!ready) throw new Error("coldBuild first");
  const model = body.n ? rememberModel(body.n, body.seed ?? 2047) : modelOrThrow();
  const reps = body.reps ?? 10;
  const warmup = body.warmup ?? 2;
  const limit = body.limit ?? 50;
  const queries = queryBank(model.V);
  const scopes: { name: string; agent: string | null }[] = [
    { name: "single", agent: model.dominantScope },
    { name: "broad", agent: null },
  ];

  const memoryCells: unknown[] = [];
  const harperCells: unknown[] = [];
  const scanCells: unknown[] = [];

  for (const scope of scopes) {
    for (const q of queries) {
      for (let i = 0; i < warmup; i++) await memoryQuery(ready.index, q, scope.agent, limit);
      const samples: number[] = [];
      for (let i = 0; i < reps; i++) samples.push(await memoryQuery(ready.index, q, scope.agent, limit));
      memoryCells.push({
        scope: scope.name,
        band: q.band,
        requestedTerms: q.requestedTerms,
        terms: q.terms.length,
        query: q.text,
        ...dist(samples),
      });
    }
  }

  for (const scope of scopes) {
    for (const q of queries) {
      for (let i = 0; i < warmup; i++) await harperRankShipped(q, scope.agent, limit, "aggregate");
      const samples: number[] = [];
      for (let i = 0; i < reps; i++) samples.push((await harperRankShipped(q, scope.agent, limit, "aggregate")).ms);
      harperCells.push({
        scope: scope.name,
        band: q.band,
        requestedTerms: q.requestedTerms,
        terms: q.terms.length,
        query: q.text,
        stats: "maintained-N-avgdl + df-from-postings",
        ...dist(samples),
      });
    }
  }

  // N/avgdl by scanning the scope, df still from the term postings. A few reps:
  // this is the "index conditions" strategy and it walks the scope on every query.
  const scanReps = Math.min(3, reps);
  for (const scope of scopes) {
    for (const q of queries.filter((item) => item.requestedTerms === 1 || item.requestedTerms === 8)) {
      const samples: number[] = [];
      for (let i = 0; i < scanReps; i++) samples.push((await harperRankShipped(q, scope.agent, limit, "scan")).ms);
      scanCells.push({
        scope: scope.name,
        band: q.band,
        requestedTerms: q.requestedTerms,
        terms: q.terms.length,
        query: q.text,
        stats: "scan-scope-for-N-avgdl + df-from-postings",
        ...dist(samples),
      });
    }
  }

  const plans = [];
  for (const scope of scopes) {
    for (const q of queries.filter((item) => item.band === "head")) {
      plans.push(await explainLead(q, scope.agent));
    }
  }

  const dfProbe = await timeGlobalDf("t1", Math.max(reps, 20));
  const scopePoint = await timeScopePoint(Math.max(reps, 20));

  const equivalence: unknown[] = [];
  for (const scope of scopes) {
    for (const q of queries) {
      const expected = ready.oracle.rank(q.terms, scope.agent, limit);
      const got = await harperRankShipped(q, scope.agent, limit, "aggregate");
      const ids = ready.index.rank({ q: q.text, conditions: conditions(scope.agent), limit });
      const idMatch = !!ids && ids.length === expected.hits.length && ids.every((id, i) => id === expected.hits[i].id);
      equivalence.push({
        ...compareRank(`${q.band}/${q.terms.length}/${scope.name}`, expected, got, limit) as object,
        memoryIndexIdMatch: idMatch,
      });
    }
  }

  if (ready.scanned !== model.n) {
    throw new Error(`cold build scanned ${ready.scanned} rows but the query model has n=${model.n}`);
  }
  console.log("spike: measure done");
  return {
    n: model.n,
    V: model.V,
    dominantScope: model.dominantScope,
    reps,
    warmup,
    limit,
    coldBuildMs: ready.coldBuildMs,
    oracleBuildMs: ready.oracleBuildMs,
    scanned: ready.scanned,
    memory: memoryCells,
    harperHybrid: harperCells,
    harperScopeScan: scanCells,
    plans,
    globalDfCount: dfProbe,
    scopeAggregatePointRead: scopePoint,
    equivalence,
  };
}

async function dfProbe(reps: number): Promise<unknown> {
  const model = modelOrThrow();
  const table = db().SpikeTermDf;
  const globalId = "__all__\u0000t1";
  const scopeId = `${model.dominantScope}\u0000t1`;
  const sample = await owned(() => table.get(globalId));
  if (!sample) return { skipped: true, reason: "SpikeTermDf has no __all__\\0t1 row" };
  const samples: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    await owned(() => table.get(globalId));
    await owned(() => table.get(scopeId));
    samples.push(nsToMs(process.hrtime.bigint() - t0));
  }
  return { skipped: false, globalDf: sample.df, pointReads: dist(samples) };
}

export class Bm25TermsSpike extends Resource {
  static path = "/Bm25TermsSpike";
  allowCreate() { return true; }

  async post(body: any) {
    const op = body?.op;
    if (op === "health") {
      const spike = (databases as any).spike;
      return { ok: true, tables: spike ? Object.keys(spike) : [], databases: Object.keys(databases as any) };
    }
    if (op === "ingest") {
      const result = await ingest(body);
      if (body?.arm === "baseline" || body?.arm === "terms" || body?.arm === undefined) {
        rememberModel(body.n, body.seed ?? 2047);
      }
      return result;
    }
    if (op === "coldBuild") return await coldBuild();
    if (op === "measure") return await measure(body);
    if (op === "dfProbe") return await dfProbe(body?.reps ?? 20);
    throw new Error(`unknown op ${String(op)}`);
  }
}
