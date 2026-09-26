/**
 * retrieval-bm25-only-arm.test.ts — the `FLAIR_RETRIEVAL_MODE="bm25-only"`
 * arm must measure the LEXICAL leg and NOTHING else.
 *
 * WHY THIS IS THE TEST THAT MATTERS: the bm25-only arm exists to answer "how
 * much recall does BM25 alone recover, with the vector leg switched off?" — a
 * positioning number. If the arm silently kept the HNSW leg, it would report
 * the hybrid number under a BM25 label: the measurement would look healthy and
 * mean the opposite of what it says. The fixture is built so the two legs point
 * in OPPOSITE directions on purpose:
 *
 *   - "vec" is the VECTOR-NEAREST neighbour of the query (cosine 1.0) but
 *     shares NO token with it — only a semantic leg can find it.
 *   - "lex" shares the query's tokens but sits at cosine 0 — only a lexical
 *     leg can find it.
 *
 * So hybrid and vector-only must return "vec"; bm25-only must NOT, and must
 * rank "lex" first. A defensive bm25-only that still consulted the embedding
 * (even without a query-embedding call — the embedding here is handed in) fails
 * the first assertion; the mutation ("point bm25-only at the hybrid branch")
 * turns this red.
 *
 * Runs the SHIPPED retrieveCandidates() against a mocked Harper (in-memory
 * store, real cosine math, faithful singleton-`$distance` quirk) with REAL BM25
 * — only the `harper` module boundary is mocked. unit-isolated because
 * mock.module is process-global (flair#691).
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";

// ─── In-memory Harper mock ───────────────────────────────────────────────────

let memoryStore: Map<string, any>;
let getCalls: string[];

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
  if (cond.comparator === "equals") return v === cond.value;
  if (cond.comparator === "not_equal") return v !== cond.value;
  return true;
}

function memorySearch(query: any) {
  const conditions = Array.isArray(query?.conditions) ? query.conditions : [];
  let records = Array.from(memoryStore.values());
  for (const cond of conditions) records = records.filter((r) => matchesCondition(r, cond));

  if (query?.sort?.attribute === "embedding") {
    const target = query.sort.target as number[];
    const scored = records
      .map((r) => ({ r, d: 1 - cosine(target, Array.isArray(r.embedding) ? r.embedding : []) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, query.limit ?? records.length);
    const singleton = records.length === 1;
    async function* gen() {
      for (const { r, d } of scored) {
        const { embedding, ...rest } = r;
        yield singleton ? { ...rest } : { ...rest, $distance: d };
      }
    }
    return gen();
  }

  async function* gen() {
    for (const r of records) {
      const { embedding, ...rest } = r;
      yield rest;
    }
  }
  return gen();
}

const databasesMock = {
  flair: {
    Memory: {
      search: (q: any) => memorySearch(q),
      get: async (id: string) => {
        getCalls.push(id);
        return memoryStore.get(id) ?? null;
      },
    },
  },
};

mock.module("harper", () => ({ databases: databasesMock, Resource: class {} }));

const { retrieveCandidates } = await import("../../resources/semantic-retrieval-core.ts");

// ─── Fixture: the two legs point in opposite directions ──────────────────────

const AGENT = "agent-a";

const qText = "apples oranges";
// 4-dim unit embeddings: the query vector is [1,0,0,0].
const qEmb = [1, 0, 0, 0];
const eVec = [1, 0, 0, 0]; // cosine 1.0 with the query — vector-nearest
const eLex = [0, 1, 0, 0]; // cosine 0.0 with the query — far away

const vecContent = "quantum turbine bearings";       // shares NO token with the query
const lexContent = "apples oranges harvest season";   // shares the query's tokens

function seed() {
  memoryStore = new Map();
  getCalls = [];
  memoryStore.set("vec", { id: "vec", agentId: AGENT, content: vecContent, embedding: eVec, durability: "standard", createdAt: new Date().toISOString() });
  memoryStore.set("lex", { id: "lex", agentId: AGENT, content: lexContent, embedding: eLex, durability: "standard", createdAt: new Date().toISOString() });
}

const baseConditions = [
  { attribute: "agentId", comparator: "equals", value: AGENT },
  { attribute: "archived", comparator: "not_equal", value: true },
];

function run(overrides: Record<string, any> = {}) {
  // queryEmbedding is passed in EVERY mode — including bm25-only, where it must
  // be IGNORED. That is what makes the exclusion below a real guard.
  return retrieveCandidates({
    queryEmbedding: qEmb,
    q: qText,
    conditions: baseConditions as any,
    limit: 10,
    scoring: "raw",
    minScore: 0,
    agentId: AGENT,
    mode: "hybrid",
    ...overrides,
  } as any);
}

const ids = (rows: any[]) => rows.map((r) => r.id);

describe("FLAIR_RETRIEVAL_MODE=bm25-only measures the lexical leg alone", () => {
  beforeEach(seed);

  it("hybrid returns the vector-nearest doc even though it shares NO token with the query", async () => {
    const r = await run({ mode: "hybrid" });
    expect(ids(r)).toContain("vec");
  });

  it("vector-only returns the vector-nearest doc", async () => {
    const r = await run({ mode: "vector-only" });
    expect(ids(r)).toContain("vec");
  });

  it("bm25-only does NOT return the vector-nearest doc — even with that doc's embedding handed in", async () => {
    const r = await run({ mode: "bm25-only" });
    expect(ids(r)).toEqual(["lex"]);
    expect(ids(r)).not.toContain("vec");
  });

  it("bm25-only ranks the token-sharing doc first", async () => {
    const r = await run({ mode: "bm25-only" });
    expect(r[0]!.id).toBe("lex");
  });

  it("bm25-only result carries the same shape as the other modes (keys, no `_rank`)", async () => {
    const bm = await run({ mode: "bm25-only" });
    const vec = await run({ mode: "vector-only" });
    const lex = vec.find((x: any) => x.id === "lex")!;
    expect(Object.keys(bm[0]!).sort()).toEqual(Object.keys(lex).sort());
    for (const row of bm) expect("_rank" in row).toBe(false);
  });
});
