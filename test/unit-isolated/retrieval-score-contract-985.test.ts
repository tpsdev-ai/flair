/**
 * retrieval-score-contract-985.test.ts — flair#985: `_score` under
 * `scoring:"raw"` is an ABSOLUTE similarity on the hybrid path, never the
 * RRF rank-normalized value.
 *
 * THE DEFECT THIS PINS: the hybrid path used to report the candidate-union
 * RRF value — normalized so the top result is EXACTLY 1.0 by construction —
 * as `_score`. Every consumer that thresholds `_score` as a similarity then
 * fails open at maximal confidence. The catastrophic consumer was the
 * pre-0.18 flair-client dedup gate (shipped in flair-mcp/pi-flair ≤0.17
 * sources and openclaw-flair's committed dist through 0.21):
 *
 *   // v0.17.0 packages/flair-client/src/client.ts
 *   const existing = await this.search(content, { limit: 1, minScore: threshold, scoring: "raw" });
 *   if (existing.length > 0) { ... return { ...match, deduped: true }; }  // write suppressed
 *   // where search() maps  score: r._score ?? r.score ?? r.similarity ?? 0
 *   // and filters          .filter((r) => r.score >= minScore)   // 0.95
 *
 * Against a hybrid server, that gate saw `_score === 1.0` on the top-1 of
 * EVERY probe — so EVERY memory_store was suppressed into whatever memory
 * happened to rank first, however unrelated (a single shared proper noun via
 * the BM25 leg sufficed). That is the #985 field report: 4/5 writes silently
 * dropped cross-topic, `written:false`, and the sanctioned delete+store
 * update pattern destroying both copies.
 *
 * These tests run the SHIPPED retrieveCandidates() against a mocked Harper
 * (in-memory store, real cosine math from stored embeddings, faithful
 * singleton-`$distance` omission quirk) with REAL BM25 and REAL fusion — only
 * the `harper` module boundary is mocked. unit-isolated because mock.module
 * is process-global (flair#691).
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
    // HNSW leg: sort by cosine distance to the target vector.
    const target = query.sort.target as number[];
    const scored = records
      .map((r) => ({ r, d: 1 - cosine(target, Array.isArray(r.embedding) ? r.embedding : []) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, query.limit ?? records.length);
    // Faithful Harper quirk (see resources/SemanticSearch.ts writeup +
    // test/integration/semantic-search-singleton-score.test.ts): when the
    // post-filter result set is a SINGLETON, `$distance` is omitted.
    const singleton = records.length === 1;
    async function* gen() {
      for (const { r, d } of scored) {
        const { embedding, ...rest } = r;
        yield singleton ? { ...rest } : { ...rest, $distance: d };
      }
    }
    return gen();
  }

  // Corpus scan (BM25 leg) — no sort, no $distance.
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

// ─── Fixtures (the #985 report's shapes) ─────────────────────────────────────

const AGENT = "agent-a";

// 4-dim unit embeddings; the query vector is built so true cosines are exact.
const eMtls = [1, 0, 0, 0];
const eCopy = [0, 1, 0, 0];
const eRunbook = [0, 0, 0, 1];
const qEmb = [0.3, 0.2, Math.sqrt(1 - 0.09 - 0.04), 0]; // cos: mtls 0.3, copy 0.2, runbook 0

const mtlsContent =
  "Vertex mTLS ingress: the proxy-protocol v2 TLV carries the client certificate " +
  "fingerprint; parse the TLV before the TLS handshake completes.";
const copyContent =
  "Copy-buffer sizing: the fast path allocates a 64KB copy buffer per connection; " +
  "256KB improved sustained throughput 18% in the file-transfer benchmark.";
const runbookContent =
  "Deploy runbook: the release cycle rollout for the ingestion cluster is staged; " +
  "pause the rollout if error budgets dip.";

// The new content being stored — a short project decision. Lexical overlap
// with mtls is ONE proper noun ("Vertex"), the #985 attempt-4 shape.
const newDecision = "Decision: adopt the Vertex feature flag for the next release cycle rollout.";

function seedTwoRecords() {
  memoryStore = new Map();
  getCalls = [];
  memoryStore.set("mtls", { id: "mtls", agentId: AGENT, content: mtlsContent, embedding: eMtls, durability: "standard", createdAt: new Date().toISOString() });
  memoryStore.set("copybuf", { id: "copybuf", agentId: AGENT, content: copyContent, embedding: eCopy, durability: "standard", createdAt: new Date().toISOString() });
}

function seedThreeRecords() {
  seedTwoRecords();
  memoryStore.set("runbook", { id: "runbook", agentId: AGENT, content: runbookContent, embedding: eRunbook, durability: "standard", createdAt: new Date().toISOString() });
}

const baseConditions = [
  { attribute: "agentId", comparator: "equals", value: AGENT },
  { attribute: "archived", comparator: "not_equal", value: true },
];

function run(overrides: Record<string, any> = {}) {
  return retrieveCandidates({
    queryEmbedding: qEmb,
    q: newDecision,
    conditions: baseConditions as any,
    limit: 10,
    scoring: "raw",
    minScore: 0,
    agentId: AGENT,
    hybrid: true,
    ...overrides,
  } as any);
}

// ─── The #985 mutation check ─────────────────────────────────────────────────

describe("flair#985 — hybrid raw `_score` is absolute similarity, never rank-normalized", () => {
  beforeEach(seedTwoRecords);

  it("an UNRELATED top-1 never reports _score >= 0.95 (pre-fix: exactly 1.0)", async () => {
    const results = await run();
    expect(results.length).toBe(2);
    // Fusion still ranks mtls first (semantic rank 1 + the BM25 proper-noun
    // hit) — the ordering half of hybrid is intact...
    expect(results[0].id).toBe("mtls");
    // ...but its reported score is the TRUE cosine, not a fabricated 1.0.
    expect(results[0]._score).toBeCloseTo(0.3, 3);
    expect(results[1]._score).toBeCloseTo(0.2, 3);
    for (const r of results) expect(r._score).toBeLessThan(0.95);
  });

  it("the stale-client dedup gate (score >= 0.95 → suppress) finds NOTHING for cross-topic content — the write proceeds", async () => {
    // Replays the v0.17.0 flair-client gate quoted in the header against the
    // modern response: map _score → score, filter at 0.95, suppress if any
    // survivor. Pre-fix the top-1 scored 1.0 and EVERY store was suppressed.
    const results = await run();
    const staleGateSurvivors = results
      .map((r: any) => ({ ...r, score: r._score ?? r.score ?? 0 }))
      .filter((r: any) => r.score >= 0.95);
    expect(staleGateSurvivors.length).toBe(0);
  });

  it("minScore means 'minimum similarity' again: minScore 0.95 with only weak matches returns empty", async () => {
    const results = await run({ minScore: 0.95 });
    expect(results.length).toBe(0);
  });

  it("a genuine near-duplicate still clears a 0.95 gate (the criterion can fire)", async () => {
    // Store a record whose embedding IS the query embedding (cosine 1.0) —
    // the true-near-dup positive control: dedup consumers must still be able
    // to detect real duplicates.
    memoryStore.set("neardup", {
      id: "neardup", agentId: AGENT, embedding: qEmb.slice(),
      content: "Decision: adopt the Vertex feature flag for the next release cycle rollout.",
      durability: "standard", createdAt: new Date().toISOString(),
    });
    const results = await run();
    expect(results[0].id).toBe("neardup");
    // cosine 1.0 + 0.05 substring keyword bump (the query IS the content)
    expect(results[0]._score).toBeGreaterThanOrEqual(0.95);
  });

  it("_rank is an internal ordering key and never leaks into results", async () => {
    const results = await run();
    for (const r of results) expect("_rank" in r).toBe(false);
  });

  it("_semSimilarity stays opt-in: absent by default, real cosine when requested", async () => {
    const plain = await run();
    for (const r of plain) expect("_semSimilarity" in r).toBe(false);
    const withSim = await run({ withSemSimilarity: true });
    expect(withSim[0]._semSimilarity).toBeCloseTo(0.3, 3);
  });
});

describe("flair#985 — hybrid recall is preserved: order and score are decoupled", () => {
  beforeEach(seedThreeRecords);

  it("a BM25-only rescue outranks a stronger-cosine record by fusion, while both report honest scores", async () => {
    // limit 2 keeps the semantic leg to [mtls, copybuf]; "runbook" surfaces
    // ONLY via BM25 (3 shared terms with the query: release, cycle, rollout).
    const results = await run({ limit: 2 });
    const ids = results.map((r: any) => r.id);
    expect(ids).toContain("runbook");
    // Fusion places the BM25 rank-1 rescue above the weaker semantic hit...
    expect(ids.indexOf("runbook")).toBeLessThan(ids.indexOf("copybuf"));
    // ...even though its honest absolute score is LOWER — order ≠ score.
    const runbook = results.find((r: any) => r.id === "runbook");
    const copybuf = results.find((r: any) => r.id === "copybuf");
    expect(runbook._score).toBeLessThan(copybuf._score);
    // The BM25-only candidate's score came from a real point-lookup of its
    // stored embedding (true cosine 0), not a fabricated rank value.
    expect(getCalls).toContain("runbook");
    expect(runbook._score).toBe(0);
  });

  it("composite mode: ordering input and result order are unchanged; _rawScore now reports the absolute value", async () => {
    const results = await run({ scoring: "composite" });
    // Same fusion-driven order as before the fix (compositeScore still takes
    // the rrf ranking value; all records share durability/recency).
    expect(results[0].id).toBe("mtls");
    // _rawScore — "the raw score before composite adjustments" — is the
    // absolute similarity (pre-fix: the rank-normalized 1.0).
    expect(results[0]._rawScore).toBeCloseTo(0.3, 3);
    expect(results[0]._rawScore).toBeLessThan(0.95);
  });
});

describe("flair#985 — the singleton corpus (delete+store death-spiral shape)", () => {
  it("with exactly ONE stored memory ($distance omitted by Harper), _score is the true cosine — not 1.0, not 0", async () => {
    // The #985 reporter's delete+store update pattern: after the delete, the
    // re-store's dedup probe runs against a corpus where the top candidate is
    // a SINGLETON post-filter set — Harper omits $distance. The score must
    // come from the point-lookup cosine fallback.
    memoryStore = new Map();
    getCalls = [];
    memoryStore.set("mtls", { id: "mtls", agentId: AGENT, content: mtlsContent, embedding: eMtls, durability: "standard", createdAt: new Date().toISOString() });
    const results = await run();
    expect(results.length).toBe(1);
    expect(results[0]._score).toBeCloseTo(0.3, 3);
    expect(getCalls).toContain("mtls");
  });
});
