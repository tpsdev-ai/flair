/**
 * bm25-index-equivalence-1357.test.ts — flair#1357's LOAD-BEARING check.
 *
 * The fix replaces a per-query `buildBM25(wholeScopedCorpus)` with a
 * persistent index. Kern's ruling made the contract latency-only and
 * RANKING-IDENTICAL: recall is the product floor and hybrid is default-on, so
 * a reordering — however defensible in the abstract — is a regression, not an
 * improvement.
 *
 * This suite runs a FIXED store through the SHIPPED `retrieveCandidates()`
 * twice per query — once with `FLAIR_BM25_INDEX=false` (the legacy corpus
 * scan, i.e. the pre-fix code, which is still in the file as the fallback) and
 * once with the index — and asserts the two responses are BYTE-IDENTICAL:
 * same ids, same order, same fields, same numbers. Not "same set", not
 * "close enough".
 *
 * ── CORPUS ORDER AND TIES ───────────────────────────────────────────────────
 * `buildBM25().rank()` sorts with `(a,b) => b.score - a.score`, and
 * `Array.prototype.sort` is stable, so EQUAL-SCORING documents come back in
 * corpus-iteration order — which, measured against a live instance
 * (test/integration/bm25-index-scan-order-1357.test.ts), is a QUERY-PLANNER
 * artifact: own-agent rows lead under the multi-agent scope OR-group, plain
 * primary-key order under a tag/subject filter. The index cannot reproduce
 * that, so it DECLINES any query whose returned window contains a score tie
 * and the legacy scan answers instead. The mock below iterates in primary-key
 * order (one of the two real orders), inserts ids in shuffled order, and plants
 * exact-duplicate contents so the decline path is genuinely exercised.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";

// ─── In-memory Harper mock ───────────────────────────────────────────────────

let memoryStore: Map<string, any>;
let corpusScans: number;
let feedListeners: ((ev: any) => void)[] = [];

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function matchesCondition(record: any, cond: any): boolean {
  if (cond.operator && Array.isArray(cond.conditions)) {
    const results = cond.conditions.map((c: any) => matchesCondition(record, c));
    return cond.operator === "or" ? results.some(Boolean) : results.every(Boolean);
  }
  const v = record[cond.attribute];
  if (cond.comparator === "equals") return Array.isArray(v) ? v.includes(cond.value) : v === cond.value;
  if (cond.comparator === "not_equal") return Array.isArray(v) ? !v.includes(cond.value) : v !== cond.value;
  return true;
}

/** Harper's `select` projection: the keys of `select` the row actually
 *  carries, in `select` declaration order. (Measured — see the integration
 *  companion to this file.) */
function project(record: any, select?: string[]): any {
  const { embedding, ...rest } = record;
  if (!select) return rest;
  const out: any = {};
  for (const k of select) if (k in rest) out[k] = rest[k];
  return out;
}

function memorySearch(query: any) {
  const conditions = Array.isArray(query?.conditions) ? query.conditions : [];
  // ASCENDING PRIMARY KEY — Harper's real scan order.
  let records = [...memoryStore.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const cond of conditions) records = records.filter((r) => matchesCondition(r, cond));

  if (query?.sort?.attribute === "embedding") {
    const target = query.sort.target as number[];
    const scored = records
      .map((r) => ({ r, d: 1 - cosine(target, Array.isArray(r.embedding) ? r.embedding : []) }))
      // Stable on ties, so the HNSW leg is deterministic across both runs.
      .sort((a, b) => a.d - b.d)
      .slice(0, query.limit ?? records.length);
    const singleton = records.length === 1;
    async function* gen() {
      for (const { r, d } of scored) {
        const base = project(r, query.select?.filter((s: string) => s !== "$distance"));
        yield singleton ? base : { ...base, $distance: d };
      }
    }
    return gen();
  }

  corpusScans++;
  async function* gen() {
    for (const r of records) yield project(r, query.select);
  }
  return gen();
}

const databasesMock = {
  flair: {
    Memory: {
      search: (q: any) => memorySearch(q),
      get: async (id: string) => memoryStore.get(id) ?? null,
      subscribe: async () => {
        // An async iterable driven by `emit()` below — the shape
        // `Memory.subscribe({omitCurrent:true})` returns on a real instance
        // (verified: {type:'put'|'delete', id, value}).
        const queue: any[] = [];
        let wake: (() => void) | null = null;
        feedListeners.push((ev) => { queue.push(ev); wake?.(); });
        return {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              while (queue.length > 0) yield queue.shift();
              await new Promise<void>((r) => { wake = r; });
            }
          },
        };
      },
    },
  },
};

mock.module("harper", () => ({ databases: databasesMock, Resource: class {} }));

const { retrieveCandidates } = await import("../../resources/semantic-retrieval-core.ts");
const { __resetBm25IndexForTests, bm25IndexStatus, noteMemoryUpsert, noteMemoryDelete, indexedBm25Ids } =
  await import("../../resources/bm25-index-service.ts");

function emit(ev: any) { for (const l of feedListeners) l(ev); }

// ─── Fixture ─────────────────────────────────────────────────────────────────

const AGENTS = ["agent-a", "agent-b", "agent-c"];
// The terms the query set is drawn from...
const QUERY_VOCAB = [
  "vertex", "ingress", "proxy", "certificate", "fingerprint", "handshake", "buffer",
  "throughput", "benchmark", "rollout", "runbook", "cluster", "budget", "release",
  "cycle", "decision", "flag", "latency", "retrieval", "corpus", "index", "harper",
  "memory", "embedding", "cosine", "lexical", "ranking", "fusion", "candidate",
];
// ...plus filler, so documents are mostly distinct. A tiny vocabulary makes
// exact BM25 score ties the norm rather than the exception, and the index
// DECLINES a tie (see resources/bm25-index.ts) — with a 29-word vocabulary the
// suite would spend its time proving the fallback works and never exercise the
// indexed path at all. The deliberate tie triple below still covers decline.
const FILLER = Array.from({ length: 600 }, (_, i) => `w${i}`);
const VOCAB = [...QUERY_VOCAB, ...FILLER];
const TAGS = ["infra", "product", "research", "ops"];
const SUBJECTS = ["nathan", "flint", "kern", "sherlock"];

// Deterministic PRNG — no Math.random anywhere in a ranking fixture.
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIM = 8;
const BASE_TIME = Date.parse("2026-06-01T00:00:00.000Z");

function seedCorpus(n: number): void {
  memoryStore = new Map();
  const rnd = mulberry32(20260823);
  const rows: any[] = [];
  for (let i = 0; i < n; i++) {
    const words: string[] = [];
    const len = 6 + Math.floor(rnd() * 18);
    for (let w = 0; w < len; w++) {
      words.push(rnd() < 0.2
        ? QUERY_VOCAB[Math.floor(rnd() * QUERY_VOCAB.length)]
        : FILLER[Math.floor(rnd() * FILLER.length)]);
    }
    const embedding = Array.from({ length: DIM }, () => rnd() * 2 - 1);
    const agentId = AGENTS[Math.floor(rnd() * AGENTS.length)];
    const createdAt = new Date(BASE_TIME + i * 3600_000).toISOString();
    const row: any = {
      // ids are NOT generated in insertion order — the fixture must not make
      // "insertion order" and "ascending id" the same thing.
      id: `mem-${String((i * 7919) % 100000).padStart(5, "0")}-${i}`,
      agentId,
      content: words.join(" "),
      contentHash: `h${i}`,
      embedding,
      durability: "standard",
      createdAt,
      updatedAt: createdAt,
    };
    const v = rnd();
    if (v < 0.15) row.visibility = "private";
    else if (v < 0.5) row.visibility = "shared";
    // else: no visibility field at all (the legacy-row shape)
    if (rnd() < 0.4) row.tags = [TAGS[Math.floor(rnd() * TAGS.length)]];
    if (rnd() < 0.5) row.subject = SUBJECTS[Math.floor(rnd() * SUBJECTS.length)];
    if (rnd() < 0.12) row.archived = true;
    if (rnd() < 0.08) row.expiresAt = new Date(BASE_TIME - 86400_000).toISOString(); // already expired
    if (rnd() < 0.08) row.expiresAt = new Date(BASE_TIME + 400 * 86400_000).toISOString(); // future
    if (rnd() < 0.06) row.validTo = new Date(BASE_TIME - 86400_000).toISOString(); // closed out
    if (rnd() < 0.06) row.validFrom = createdAt;
    if (rnd() < 0.05) row.supersedes = rows.length > 0 ? rows[Math.floor(rnd() * rows.length)].id : undefined;
    rows.push(row);
  }
  // TIE FODDER: exact-duplicate bodies. Their BM25 scores are bit-identical for
  // any query, so they are the decline guard's fixture. Their vocabulary is
  // PRIVATE to them (`tiemarker`, `tz*` — absent from QUERY_VOCAB and FILLER),
  // because three identical documents sharing the query vocabulary would tie
  // inside the window of nearly every query and push the whole suite onto the
  // fallback path, which is exactly what it must not silently do.
  const twin = "tiemarker tz1 tz2 tz3 tz4 tz5 tz6 tz7";
  for (const [suffix, agentId] of [["zzz", "agent-a"], ["aaa", "agent-a"], ["mmm", "agent-b"]] as const) {
    rows.push({
      id: `mem-tie-${suffix}`, agentId, content: twin, contentHash: `tie-${suffix}`,
      embedding: Array.from({ length: DIM }, () => 0.1), durability: "standard",
      createdAt: new Date(BASE_TIME).toISOString(), updatedAt: new Date(BASE_TIME).toISOString(),
      tags: ["infra"], subject: "flint",
    });
  }
  // Insert in SHUFFLED order so Map insertion order ≠ id order.
  const order = rows.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(mulberry32(i * 7 + 3)() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const i of order) memoryStore.set(rows[i].id, rows[i]);
}

function scopeFor(agentId: string) {
  const condition = {
    operator: "or",
    conditions: [
      { attribute: "agentId", comparator: "equals", value: agentId },
      { attribute: "visibility", comparator: "not_equal", value: "private" },
    ],
  };
  const isAllowed: any = (r: any) => !!r && (r.agentId === agentId || r.visibility !== "private");
  isAllowed.scopableOnly = true;
  return { condition, isAllowed };
}

function qEmbFor(seed: number): number[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: DIM }, () => rnd() * 2 - 1);
}

// ─── The query matrix ────────────────────────────────────────────────────────

interface Case { name: string; params: Record<string, any> }

function buildCases(): Case[] {
  const cases: Case[] = [];
  const reader = "agent-a";
  const { condition, isAllowed } = scopeFor(reader);
  const notArchived = { attribute: "archived", comparator: "not_equal", value: true };

  const texts = [
    "vertex ingress certificate fingerprint",
    "rollout cluster release cycle",
    "retrieval corpus index latency ranking",
    "harper memory embedding cosine",
    "decision flag benchmark throughput",
    "vertex ingress proxy certificate fingerprint handshake rollout cluster",
    "candidate fusion lexical ranking",
    "buffer proxy budget runbook",
  ];

  for (let i = 0; i < texts.length; i++) {
    const q = texts[i];
    const base = {
      q, conditions: [condition, notArchived], limit: 20, agentId: reader,
      isAllowed, hybrid: true, scoring: "raw", minScore: 0,
    };
    cases.push({ name: `plain/${i}`, params: { ...base, queryEmbedding: qEmbFor(100 + i) } });
    cases.push({ name: `no-embedding/${i}`, params: { ...base, queryEmbedding: null } });
    cases.push({
      name: `tag/${i}`,
      params: {
        ...base, queryEmbedding: qEmbFor(200 + i),
        conditions: [condition, notArchived, { attribute: "tags", comparator: "equals", value: TAGS[i % TAGS.length] }],
      },
    });
    cases.push({
      name: `subject-single/${i}`,
      params: {
        ...base, queryEmbedding: qEmbFor(300 + i),
        conditions: [condition, notArchived, { attribute: "subject", comparator: "equals", value: SUBJECTS[i % SUBJECTS.length] }],
      },
    });
    cases.push({
      name: `subject-or/${i}`,
      params: {
        ...base, queryEmbedding: qEmbFor(400 + i),
        conditions: [condition, notArchived, {
          operator: "or",
          conditions: [
            { attribute: "subject", comparator: "equals", value: "flint" },
            { attribute: "subject", comparator: "equals", value: "kern" },
          ],
        }],
      },
    });
    // Both facets at once — the aggregates cannot express the intersection, so
    // this drives the index's EXACT statistics walk.
    cases.push({
      name: `tag+subject/${i}`,
      params: {
        ...base, queryEmbedding: qEmbFor(500 + i),
        conditions: [condition, notArchived,
          { attribute: "tags", comparator: "equals", value: "infra" },
          { attribute: "subject", comparator: "equals", value: "flint" }],
      },
    });
    // sinceDate / asOf — also the exact walk.
    cases.push({
      name: `since/${i}`,
      params: { ...base, queryEmbedding: qEmbFor(600 + i), sinceDate: new Date(BASE_TIME + 50 * 3600_000) },
    });
    cases.push({
      name: `asOf/${i}`,
      params: { ...base, queryEmbedding: qEmbFor(700 + i), asOf: new Date(BASE_TIME + 120 * 3600_000).toISOString() },
    });
    cases.push({ name: `composite/${i}`, params: { ...base, queryEmbedding: qEmbFor(800 + i), scoring: "composite" } });
    cases.push({ name: `minScore/${i}`, params: { ...base, queryEmbedding: qEmbFor(900 + i), minScore: 0.3 } });
    cases.push({ name: `superseded/${i}`, params: { ...base, queryEmbedding: qEmbFor(1000 + i), includeSuperseded: true } });
    cases.push({ name: `semSim/${i}`, params: { ...base, queryEmbedding: qEmbFor(1100 + i), withSemSimilarity: true } });
    cases.push({ name: `narrow-limit/${i}`, params: { ...base, queryEmbedding: qEmbFor(1200 + i), limit: 3 } });
    cases.push({ name: `deep-limit/${i}`, params: { ...base, queryEmbedding: qEmbFor(1300 + i), limit: 200 } });
    // An UNSCOPED read (admin-shaped: no agentId, no isAllowed).
    cases.push({
      name: `unscoped/${i}`,
      params: { ...base, queryEmbedding: qEmbFor(1400 + i), conditions: [notArchived], isAllowed: undefined, agentId: undefined },
    });
    // Bootstrap's shape: scope condition ONLY, no archived exclusion.
    cases.push({ name: `bootstrap/${i}`, params: { ...base, queryEmbedding: qEmbFor(1500 + i), conditions: [condition] } });
  }
  // No lexical signal at all — the full scoped listing branch.
  cases.push({
    name: "listing",
    params: {
      q: undefined, queryEmbedding: null, conditions: [condition, notArchived], limit: 500,
      agentId: reader, isAllowed, hybrid: true, scoring: "raw", minScore: 0,
    },
  });
  // Embedding but no text.
  cases.push({
    name: "embedding-only",
    params: {
      q: undefined, queryEmbedding: qEmbFor(31337), conditions: [condition, notArchived], limit: 20,
      agentId: reader, isAllowed, hybrid: true, scoring: "raw", minScore: 0,
    },
  });
  return cases;
}

async function runBoth(params: Record<string, any>): Promise<{ legacy: any[]; indexed: any[] }> {
  process.env.FLAIR_BM25_INDEX = "false";
  __resetBm25IndexForTests();
  const legacy = await retrieveCandidates({ ...params } as any);

  process.env.FLAIR_BM25_INDEX = "true";
  const indexed = await retrieveCandidates({ ...params } as any);
  return { legacy, indexed };
}

describe("flair#1357 — the indexed lexical leg is byte-identical to the legacy corpus rebuild", () => {
  beforeEach(() => {
    seedCorpus(400);
    corpusScans = 0;
    feedListeners = [];
    __resetBm25IndexForTests();
    delete process.env.FLAIR_BM25_INDEX;
  });
  afterEach(() => { delete process.env.FLAIR_BM25_INDEX; __resetBm25IndexForTests(); });

  const cases = buildCases();

  it(`covers ${cases.length} query shapes over a fixed 403-record store`, () => {
    expect(cases.length).toBeGreaterThan(100);
    expect(memoryStore.size).toBe(403);
  });

  it("every query returns byte-identical results on both paths", async () => {
    // Build ONCE, then reuse across every case — the realistic shape, and it
    // also proves the index is not silently rebuilding per query.
    process.env.FLAIR_BM25_INDEX = "true";
    __resetBm25IndexForTests();
    await retrieveCandidates({ ...cases[0].params } as any);
    expect(bm25IndexStatus().state).toBe("ready");
    const scansAfterBuild = corpusScans;

    const mismatches: string[] = [];
    const fellBack: string[] = [];
    for (const c of cases) {
      process.env.FLAIR_BM25_INDEX = "false";
      const legacy = await retrieveCandidates({ ...c.params } as any);
      process.env.FLAIR_BM25_INDEX = "true";
      // A corpus scan during the INDEXED run means the index declined the
      // query and the legacy fallback ran instead.
      const before = corpusScans;
      const indexed = await retrieveCandidates({ ...c.params } as any);
      if (corpusScans > before) fellBack.push(c.name);

      const a = JSON.stringify(legacy);
      const b = JSON.stringify(indexed);
      if (a !== b) {
        mismatches.push(
          `${c.name}: legacy ids=${JSON.stringify(legacy.map((r: any) => r.id))}\n` +
          `             indexed ids=${JSON.stringify(indexed.map((r: any) => r.id))}`,
        );
      }
    }
    expect(mismatches.join("\n"), `${mismatches.length}/${cases.length} query shapes diverged`).toBe("");

    // ── THE ANTI-VACUITY CONTROL ─────────────────────────────────────────────
    // Everything above would pass trivially if the index quietly declined every
    // query and both "paths" were the same legacy code. Fallbacks are expected
    // for the no-query-text listing (no lexical leg to serve) and for any query
    // whose returned window contains a BM25 score tie (the decline guard), so
    // this asserts a FLOOR on how much the index actually served rather than
    // exact equality — but a floor high enough that a blanket decline fails.
    const served = cases.length - fellBack.length;
    console.log(`\n  BM25 INDEX SERVE RATE: ${served}/${cases.length} query shapes ` +
      `(${((100 * served) / cases.length).toFixed(0)}%); the rest hit the tie-decline guard ` +
      `or have no query text.\n`);
    expect(fellBack, "the no-text listing must fall back").toContain("listing");
    // The index must actually serve SOMETHING, or every "both paths agree"
    // assertion above is two runs of the same legacy code agreeing with itself.
    expect(served, "the index served nothing — every equivalence assertion above is vacuous").toBeGreaterThan(0);
    expect(corpusScans).toBeGreaterThan(scansAfterBuild); // legacy control ran
    expect(bm25IndexStatus().state).toBe("ready");
  }, 120_000);

  it("the equivalence check CAN fail — a corrupted index is caught", async () => {
    // Positive control. Without this, an equivalence assertion that compares
    // two runs of the same code path would pass vacuously forever. The victim
    // is an id the index is DEMONSTRABLY supplying to the lexical leg — nothing
    // is proved by corrupting a record the query was never going to use.
    process.env.FLAIR_BM25_INDEX = "true";
    __resetBm25IndexForTests();
    const all = buildCases().filter((x) => x.params.q);
    await retrieveCandidates({ ...all[0].params } as any); // build
    // Find a case the index genuinely SERVES — corrupting the index proves
    // nothing about a query that was going to decline and fall back anyway.
    let c = all[0];
    let servedIds: string[] | null = null;
    for (const cand of all) {
      const ids = await indexedBm25Ids({
        q: cand.params.q, conditions: cand.params.conditions as any, timeFilters: {},
        isAllowed: cand.params.isAllowed, limit: 50,
      });
      if (ids && ids.length > 0) { c = cand; servedIds = ids; break; }
    }
    expect(servedIds, "this control needs a query the index actually serves").not.toBeNull();

    process.env.FLAIR_BM25_INDEX = "false";
    const legacy = await retrieveCandidates({ ...c.params } as any);
    process.env.FLAIR_BM25_INDEX = "true";
    expect(JSON.stringify(await retrieveCandidates({ ...c.params } as any))).toBe(JSON.stringify(legacy));

    // Now drop the lexical leg's top hit from the index ONLY (the store still
    // has it), and the two paths must part company.
    noteMemoryDelete(servedIds![0]);
    const corrupted = await retrieveCandidates({ ...c.params } as any);
    expect(JSON.stringify(corrupted)).not.toBe(JSON.stringify(legacy));
  }, 60_000);

  it("a score tie in the returned window makes the index DECLINE, and the answer still matches", async () => {
    const { condition, isAllowed } = scopeFor("agent-a");
    const params = {
      q: "tiemarker tz1 tz2 tz3",
      queryEmbedding: qEmbFor(4242),
      conditions: [condition, { attribute: "archived", comparator: "not_equal", value: true }],
      limit: 200, agentId: "agent-a", isAllowed, hybrid: true, scoring: "raw", minScore: 0,
    };
    process.env.FLAIR_BM25_INDEX = "true";
    __resetBm25IndexForTests();
    await retrieveCandidates({ ...params } as any); // build
    // The three exact-duplicate bodies tie on this query, so the index must
    // refuse to serve the lexical leg at all.
    const declined = await indexedBm25Ids({
      q: params.q, conditions: params.conditions as any, timeFilters: {},
      isAllowed: params.isAllowed, limit: 50,
    });
    expect(declined, "a window containing tied scores must be declined, not guessed").toBeNull();

    const { legacy, indexed } = await runBoth(params);
    const tieOrder = (rs: any[]) => rs.map((r: any) => r.id).filter((id: string) => id.startsWith("mem-tie-"));
    expect(tieOrder(legacy).length).toBe(3);
    expect(tieOrder(indexed)).toEqual(tieOrder(legacy));
    expect(JSON.stringify(indexed)).toBe(JSON.stringify(legacy));
  }, 60_000);
});

// ─── Incremental maintenance ─────────────────────────────────────────────────

describe("flair#1357 — incremental maintenance keeps the lexical leg current", () => {
  const reader = "agent-a";
  const { condition, isAllowed } = scopeFor(reader);
  const notArchived = { attribute: "archived", comparator: "not_equal", value: true };

  function search(q: string, extra: Record<string, any> = {}) {
    return retrieveCandidates({
      q, queryEmbedding: null, conditions: [condition, notArchived], limit: 50,
      agentId: reader, isAllowed, hybrid: true, scoring: "raw", minScore: 0, ...extra,
    } as any);
  }

  beforeEach(async () => {
    seedCorpus(120);
    feedListeners = [];
    __resetBm25IndexForTests();
    process.env.FLAIR_BM25_INDEX = "true";
    await search("vertex"); // force the build
    expect(bm25IndexStatus().state).toBe("ready");
  });
  afterEach(() => { delete process.env.FLAIR_BM25_INDEX; __resetBm25IndexForTests(); });

  const NEEDLE = "quokka";

  it("a write is IMMEDIATELY searchable in the lexical leg (read-your-write)", async () => {
    expect((await search(NEEDLE)).length).toBe(0);
    const row = {
      id: "mem-new-write", agentId: reader, content: `a ${NEEDLE} appeared in the cluster`,
      durability: "standard", createdAt: new Date(BASE_TIME).toISOString(),
    };
    memoryStore.set(row.id, row);
    noteMemoryUpsert(row); // exactly what resources/Memory.ts's put/post now call
    const hits = await search(NEEDLE);
    expect(hits.map((r: any) => r.id)).toEqual(["mem-new-write"]);
  });

  it("a delete removes it from the lexical leg", async () => {
    const row = { id: "mem-doomed", agentId: reader, content: `${NEEDLE} doomed`, durability: "standard", createdAt: new Date(BASE_TIME).toISOString() };
    memoryStore.set(row.id, row);
    noteMemoryUpsert(row);
    expect((await search(NEEDLE)).length).toBe(1);
    memoryStore.delete(row.id);
    noteMemoryDelete(row.id);
    expect((await search(NEEDLE)).length).toBe(0);
  });

  it("an ARCHIVE flip excludes it (the `archived not_equal true` transition)", async () => {
    const row: any = { id: "mem-archflip", agentId: reader, content: `${NEEDLE} archival`, durability: "standard", createdAt: new Date(BASE_TIME).toISOString() };
    memoryStore.set(row.id, row);
    noteMemoryUpsert(row);
    expect((await search(NEEDLE)).length).toBe(1);
    const archived = { ...row, archived: true, archivedAt: new Date().toISOString() };
    memoryStore.set(row.id, archived);
    noteMemoryUpsert(archived);
    expect((await search(NEEDLE)).length).toBe(0);
    // ...and back again — the flip is not one-way.
    memoryStore.set(row.id, row);
    noteMemoryUpsert(row);
    expect((await search(NEEDLE)).length).toBe(1);
  });

  it("a CONTENT edit re-tokenizes: the old term stops matching, the new one starts", async () => {
    const row = { id: "mem-edit", agentId: reader, content: `${NEEDLE} before`, durability: "standard", createdAt: new Date(BASE_TIME).toISOString() };
    memoryStore.set(row.id, row);
    noteMemoryUpsert(row);
    expect((await search(NEEDLE)).length).toBe(1);
    const edited = { ...row, content: "wombat after" };
    memoryStore.set(row.id, edited);
    noteMemoryUpsert(edited);
    expect((await search(NEEDLE)).length).toBe(0);
    expect((await search("wombat")).map((r: any) => r.id)).toEqual(["mem-edit"]);
  });

  it("EPHEMERAL EXPIRY: a past expiresAt drops out with no write at all (wall-clock only)", async () => {
    const row = {
      id: "mem-ephemeral", agentId: reader, content: `${NEEDLE} ephemeral`, durability: "ephemeral",
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    memoryStore.set(row.id, row);
    noteMemoryUpsert(row);
    expect((await search(NEEDLE)).length).toBe(1);
    // No write, no hook — only time passes. The aggregates must sweep it out
    // and the candidate filter must drop it.
    const later = Date.parse(row.expiresAt) + 1000;
    const spy = Date.now;
    (Date as any).now = () => later;
    try {
      expect((await search(NEEDLE)).length).toBe(0);
    } finally { (Date as any).now = spy; }
  });

  it("a SUPERSEDE close (validTo in the past) drops out", async () => {
    const row: any = { id: "mem-superseded", agentId: reader, content: `${NEEDLE} superseded`, durability: "standard", createdAt: new Date(BASE_TIME).toISOString() };
    memoryStore.set(row.id, row);
    noteMemoryUpsert(row);
    expect((await search(NEEDLE)).length).toBe(1);
    const closed = { ...row, validTo: new Date(Date.now() - 1000).toISOString() };
    memoryStore.set(row.id, closed);
    noteMemoryUpsert(closed); // closeSupersededRecord's hook
    expect((await search(NEEDLE)).length).toBe(0);
  });

  it("the CHANGE FEED alone carries a write that no hook reported", async () => {
    // The replication / operations-API / other-worker shape: nothing in flair's
    // JS write paths ran, so no hook fired — only the table's change feed did.
    const row = { id: "mem-from-feed", agentId: reader, content: `${NEEDLE} via feed`, durability: "standard", createdAt: new Date(BASE_TIME).toISOString() };
    memoryStore.set(row.id, row);
    emit({ type: "put", id: row.id, value: row });
    await new Promise((r) => setTimeout(r, 5));
    expect((await search(NEEDLE)).map((r: any) => r.id)).toEqual(["mem-from-feed"]);

    memoryStore.delete(row.id);
    emit({ type: "delete", id: row.id, value: null });
    await new Promise((r) => setTimeout(r, 5));
    expect((await search(NEEDLE)).length).toBe(0);
  });

  it("an UNKNOWN feed event marks the index stale rather than trusting it", async () => {
    // Harper emits a bare `reload` marker when a base copy / resync replaces
    // table contents wholesale. There are no per-row events to apply, so the
    // only safe response is to rebuild.
    emit({ type: "reload" });
    await new Promise((r) => setTimeout(r, 5));
    expect(bm25IndexStatus().state).toBe("empty");
    const row = { id: "mem-after-reload", agentId: reader, content: `${NEEDLE} after reload`, durability: "standard", createdAt: new Date(BASE_TIME).toISOString() };
    memoryStore.set(row.id, row);
    // No hook: the rebuild triggered by the next query must pick it up from
    // the table itself.
    expect((await search(NEEDLE)).map((r: any) => r.id)).toEqual(["mem-after-reload"]);
    expect(bm25IndexStatus().state).toBe("ready");
  });

  it("a heavy update churn stays correct across index compaction", async () => {
    // upsert = tombstone + append, so repeated updates accumulate dead
    // postings until compact() reclaims them. Correctness must not depend on
    // which side of that threshold we land.
    const row: any = { id: "mem-churn", agentId: reader, content: "seed", durability: "standard", createdAt: new Date(BASE_TIME).toISOString() };
    memoryStore.set(row.id, row);
    for (let i = 0; i < 500; i++) {
      const next = { ...row, content: `churn ${i} ${NEEDLE}` };
      memoryStore.set(row.id, next);
      noteMemoryUpsert(next);
    }
    expect(bm25IndexStatus().size).toBe(memoryStore.size);
    const hits = await search(NEEDLE);
    expect(hits.map((r: any) => r.id)).toEqual(["mem-churn"]);
    // ...and the whole corpus still ranks identically after all that churn.
    process.env.FLAIR_BM25_INDEX = "false";
    const legacy = await search("vertex ingress cluster");
    process.env.FLAIR_BM25_INDEX = "true";
    const indexed = await search("vertex ingress cluster");
    expect(JSON.stringify(indexed)).toBe(JSON.stringify(legacy));
  }, 60_000);
});

// ─── Concurrency ─────────────────────────────────────────────────────────────

describe("flair#1357 — concurrency", () => {
  const reader = "agent-a";
  const { condition, isAllowed } = scopeFor(reader);
  const notArchived = { attribute: "archived", comparator: "not_equal", value: true };

  function search(q: string) {
    return retrieveCandidates({
      q, queryEmbedding: null, conditions: [condition, notArchived], limit: 50,
      agentId: reader, isAllowed, hybrid: true, scoring: "raw", minScore: 0,
    } as any);
  }

  beforeEach(() => {
    seedCorpus(200);
    feedListeners = [];
    __resetBm25IndexForTests();
    process.env.FLAIR_BM25_INDEX = "true";
  });
  afterEach(() => { delete process.env.FLAIR_BM25_INDEX; __resetBm25IndexForTests(); });

  it("concurrent cold queries share ONE build and all agree", async () => {
    corpusScans = 0;
    const runs = await Promise.all(Array.from({ length: 12 }, () => search("vertex ingress cluster")));
    // Exactly one BUILD, however many queries raced into it. (A query may also
    // scan because the index declined a tie; what must not happen is twelve
    // concurrent builds.)
    expect(bm25IndexStatus().state).toBe("ready");
    expect(bm25IndexStatus().size).toBe(memoryStore.size);
    expect(corpusScans).toBeLessThanOrEqual(13);
    const first = JSON.stringify(runs[0]);
    for (const r of runs) expect(JSON.stringify(r)).toBe(first);
  }, 60_000);

  it("writes landing DURING the build are not lost", async () => {
    // The build starts, and mid-scan a write and a delete arrive. Buffered
    // events are replayed after the cursor finishes, so the newer event wins
    // regardless of whether the cursor had already visited the row.
    const doomed = [...memoryStore.values()][0];
    const inflight = { id: "mem-inflight", agentId: reader, content: "narwhal inflight", durability: "standard", createdAt: new Date(BASE_TIME).toISOString() };

    const building = search("vertex");
    memoryStore.set(inflight.id, inflight);
    noteMemoryUpsert(inflight);
    memoryStore.delete(doomed.id);
    noteMemoryDelete(doomed.id);
    await building;

    expect((await search("narwhal")).map((r: any) => r.id)).toEqual(["mem-inflight"]);
    expect(bm25IndexStatus().size).toBe(memoryStore.size);
  }, 60_000);

  it("interleaved queries and writes never observe a half-applied index", async () => {
    await search("vertex");
    const results: string[] = [];
    await Promise.all([
      (async () => { for (let i = 0; i < 40; i++) results.push(JSON.stringify((await search("vertex ingress")).map((r: any) => r.id))); })(),
      (async () => {
        for (let i = 0; i < 40; i++) {
          const row = { id: `mem-conc-${i}`, agentId: reader, content: `concurrent ${i} narwhal`, durability: "standard", createdAt: new Date(BASE_TIME).toISOString() };
          memoryStore.set(row.id, row);
          noteMemoryUpsert(row);
          await Promise.resolve();
        }
      })(),
    ]);
    expect(results.length).toBe(40);
    expect(bm25IndexStatus().size).toBe(memoryStore.size);
    // Whatever interleaving happened, the FINAL state is exactly what a
    // from-scratch legacy scan would produce.
    process.env.FLAIR_BM25_INDEX = "false";
    const legacy = await search("vertex ingress narwhal");
    process.env.FLAIR_BM25_INDEX = "true";
    const indexed = await search("vertex ingress narwhal");
    expect(JSON.stringify(indexed)).toBe(JSON.stringify(legacy));
  }, 60_000);
});
