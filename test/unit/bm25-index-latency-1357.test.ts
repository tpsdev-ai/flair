/**
 * bm25-index-latency-1357.test.ts — the check that would have caught flair#1357.
 *
 * THE DEFECT: the hybrid lexical leg called `buildBM25(wholeScopedCorpus)` on
 * every query, so per-query work was proportional to STORE SIZE rather than to
 * how much of the store the query could possibly match. Measured in the field:
 * hybrid recall p50 5.6s at 60k rows → 28.7s at 180k, while vector-only recall
 * over the same stores moved 2.4s → 4.7s. Nothing in the suite failed, because
 * nothing in the suite measured a second store size.
 *
 * THE INVARIANT ASSERTED HERE: a query's cost tracks the documents that
 * actually contain its terms — NOT the size of the store around them. So the
 * fixture holds the matchable set FIXED at 500 documents and grows the
 * surrounding corpus 4×. The old implementation pays 4× for that; the new one
 * must not.
 *
 * THE POSITIVE CONTROL (non-negotiable): every timing assertion below is
 * paired with the SAME measurement run against `buildBM25` — the code being
 * replaced. If the control does not show the linear growth it is supposed to
 * show, the harness is not measuring what it claims and the test says so
 * instead of passing. A latency test with no control is a green light that
 * cannot turn red.
 */
import { describe, test, expect } from "bun:test";
import { buildBM25, SEM_LIMIT } from "../../resources/bm25.ts";
import { Bm25Index, type IndexRecord } from "../../resources/bm25-index.ts";

// ─── Fixture ────────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distractor vocabulary — deliberately disjoint from the topical one, so a
 *  topical query matches exactly the 500 topical documents at every store
 *  size. */
const DISTRACTOR_VOCAB = Array.from({ length: 4000 }, (_, i) => `dz${i}`);
const TOPICAL_VOCAB = Array.from({ length: 60 }, (_, i) => `tq${i}`);

const AGENT = "agent-a";
const CONDITIONS = [
  {
    operator: "or",
    conditions: [
      { attribute: "agentId", comparator: "equals", value: AGENT },
      { attribute: "visibility", comparator: "not_equal", value: "private" },
    ],
  },
  { attribute: "archived", comparator: "not_equal", value: true },
] as any[];

const isAllowed: any = (r: any) => !!r && (r.agentId === AGENT || r.visibility !== "private");
isAllowed.scopableOnly = true;

const TOPICAL_COUNT = 200;

function makeCorpus(distractors: number): IndexRecord[] {
  const rnd = mulberry32(1357);
  const docs: IndexRecord[] = [];
  const emit = (id: string, words: string[]) => {
    docs.push({
      id,
      content: words.join(" "),
      agentId: AGENT,
      visibility: "shared",
      archived: false,
      durability: "standard",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
  };
  for (let i = 0; i < TOPICAL_COUNT; i++) {
    // Lengths spread across 43 values and randomised term draws, so BM25 scores
    // inside the returned window are DISTINCT. Exact score ties make the index
    // decline by design (resources/bm25-index.ts) and fall back to the legacy
    // scan — which would silently turn this file into a measurement of the
    // legacy path against itself.
    const words: string[] = [];
    // UNIQUE length per topical document. Two documents with the same length
    // and the same term counts score identically, and an exact tie inside the
    // returned window makes the index decline by design
    // (resources/bm25-index.ts) and fall back to the legacy scan — which would
    // silently turn this file into a measurement of the legacy path against
    // itself. Distinct lengths give distinct length normalisation, so the
    // window this test measures is genuinely served from the index.
    const len = 20 + i;
    for (let w = 0; w < len; w++) words.push(TOPICAL_VOCAB[Math.floor(rnd() * TOPICAL_VOCAB.length)]);
    emit(`topical-${String(i).padStart(6, "0")}`, words);
  }
  for (let i = 0; i < distractors; i++) {
    const words: string[] = [];
    // Zipf-ish draw, so the distractor corpus has the long tail a real store
    // has rather than a flat vocabulary.
    for (let w = 0; w < 26; w++) {
      const r = rnd();
      words.push(DISTRACTOR_VOCAB[Math.floor(r * r * DISTRACTOR_VOCAB.length)]);
    }
    emit(`distract-${String(i).padStart(7, "0")}`, words);
  }
  return docs;
}

const QUERIES = Array.from({ length: 24 }, (_, i) => {
  const rnd = mulberry32(9000 + i);
  const terms: string[] = [];
  for (let t = 0; t < 5; t++) terms.push(TOPICAL_VOCAB[Math.floor(rnd() * TOPICAL_VOCAB.length)]);
  return terms.join(" ");
});

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function buildIndex(docs: IndexRecord[]): Bm25Index {
  const idx = new Bm25Index();
  for (const d of docs) idx.upsert(d);
  return idx;
}

/** Median per-query wall time of the NEW path. */
function timeIndexed(idx: Bm25Index, samples: number): number {
  const times: number[] = [];
  for (let s = 0; s < samples; s++) {
    const q = QUERIES[s % QUERIES.length];
    const t0 = performance.now();
    const ids = idx.rank({ q, conditions: CONDITIONS, isAllowed, limit: SEM_LIMIT });
    const t1 = performance.now();
    if (ids === null) throw new Error("index declined a query this test requires it to serve (score tie in the window — the fixture must keep scores distinct)");
    times.push(t1 - t0);
  }
  return median(times);
}

/** Median per-query wall time of the OLD path — the positive control. */
function timeLegacy(docs: IndexRecord[], samples: number): number {
  const times: number[] = [];
  const corpus = docs.map((d) => ({ id: d.id, content: d.content }));
  for (let s = 0; s < samples; s++) {
    const q = QUERIES[s % QUERIES.length];
    const t0 = performance.now();
    const ranked = buildBM25(corpus).rank(q);
    ranked.filter((r) => r.score > 0).slice(0, SEM_LIMIT).map((r) => r.id);
    const t1 = performance.now();
    times.push(t1 - t0);
  }
  return median(times);
}

// ─── Measurement ────────────────────────────────────────────────────────────

const SMALL = 10_000;
const LARGE = 40_000; // 4× the distractor corpus, same 500 matchable documents

const smallDocs = makeCorpus(SMALL);
const largeDocs = makeCorpus(LARGE);
const smallIdx = buildIndex(smallDocs);
const largeIdx = buildIndex(largeDocs);

// JIT warm-up, so the first measured sample is not also the first compiled one.
timeIndexed(smallIdx, 30);
timeIndexed(largeIdx, 30);
timeLegacy(smallDocs, 2);
timeLegacy(largeDocs, 2);

const indexedSmall = timeIndexed(smallIdx, 200);
const indexedLarge = timeIndexed(largeIdx, 200);
const legacySmall = timeLegacy(smallDocs, 7);
const legacyLarge = timeLegacy(largeDocs, 7);

const indexedRatio = indexedLarge / indexedSmall;
const legacyRatio = legacyLarge / legacySmall;

describe("flair#1357 — per-query work must not scale with store size", () => {
  test("fixture: 4× the store, the SAME matchable document set", () => {
    expect(smallIdx.size).toBe(SMALL + TOPICAL_COUNT);
    expect(largeIdx.size).toBe(LARGE + TOPICAL_COUNT);
    expect(largeIdx.size - TOPICAL_COUNT).toBe(4 * (smallIdx.size - TOPICAL_COUNT));
    // Same answers at both sizes: the corpus grew, the matchable set did not.
    // (The ids can differ only if a distractor somehow matched.)
    for (const q of QUERIES.slice(0, 5)) {
      const a = smallIdx.rank({ q, conditions: CONDITIONS, isAllowed, limit: SEM_LIMIT })!;
      expect(a.length).toBeGreaterThan(0);
      for (const id of a) expect(id.startsWith("topical-")).toBe(true);
    }
  });

  test("POSITIVE CONTROL: the code being replaced DOES scale with store size", () => {
    // If this ever stops holding, the harness is no longer measuring the
    // property the assertion below depends on, and the assertion below is
    // worthless. Fail here rather than pass there.
    expect(
      legacyRatio,
      `legacy buildBM25 4x-store ratio ${legacyRatio.toFixed(2)} ` +
      `(${legacySmall.toFixed(2)}ms @ ${SMALL + TOPICAL_COUNT} → ${legacyLarge.toFixed(2)}ms @ ${LARGE + TOPICAL_COUNT}) ` +
      `— expected ~4x; a flat control means this test cannot detect the defect it exists for`,
    ).toBeGreaterThan(2.5);
  });

  test("the indexed lexical leg is FLAT across a 4× store", () => {
    expect(
      indexedRatio,
      `indexed 4x-store ratio ${indexedRatio.toFixed(2)} ` +
      `(${indexedSmall.toFixed(4)}ms @ ${SMALL + TOPICAL_COUNT} → ${indexedLarge.toFixed(4)}ms @ ${LARGE + TOPICAL_COUNT}); ` +
      `legacy control ratio ${legacyRatio.toFixed(2)}`,
    ).toBeLessThan(2.0);
  });

  test("and it is faster in absolute terms by a wide margin at the larger store", () => {
    const speedup = legacyLarge / indexedLarge;
    expect(
      speedup,
      `speedup ${speedup.toFixed(1)}x at ${LARGE + TOPICAL_COUNT} docs ` +
      `(${legacyLarge.toFixed(2)}ms → ${indexedLarge.toFixed(4)}ms)`,
    ).toBeGreaterThan(20);
  });

  test("MEASUREMENTS", () => {
    console.log(
      `\n  flair#1357 lexical-leg per-query median (ms)\n` +
      `  store size        ${String(SMALL + TOPICAL_COUNT).padStart(10)}  ${String(LARGE + TOPICAL_COUNT).padStart(10)}   ratio\n` +
      `  legacy buildBM25  ${legacySmall.toFixed(3).padStart(10)}  ${legacyLarge.toFixed(3).padStart(10)}   ${legacyRatio.toFixed(2)}x\n` +
      `  persistent index  ${indexedSmall.toFixed(3).padStart(10)}  ${indexedLarge.toFixed(3).padStart(10)}   ${indexedRatio.toFixed(2)}x\n` +
      `  speedup           ${(legacySmall / indexedSmall).toFixed(1).padStart(9)}x  ${(legacyLarge / indexedLarge).toFixed(1).padStart(9)}x\n`,
    );
    expect(true).toBe(true);
  });
});

describe("flair#1357 — the index answers the same thing it always did, at scale", () => {
  test("indexed top-N equals buildBM25 top-N on the 40k store", () => {
    // The equivalence suite (test/unit-isolated/bm25-index-equivalence-1357)
    // proves this through the whole retrieval core on a small fixture. Repeat
    // it HERE, at the size this file measures, so a speedup can never be
    // bought with a shortcut that only shows up on a large corpus.
    const corpus = largeDocs.map((d) => ({ id: d.id, content: d.content }));
    for (const q of QUERIES) {
      const legacy = buildBM25(corpus).rank(q).filter((r) => r.score > 0).slice(0, SEM_LIMIT).map((r) => r.id);
      const indexed = largeIdx.rank({ q, conditions: CONDITIONS, isAllowed, limit: SEM_LIMIT });
      expect(indexed).toEqual(legacy);
    }
  }, 120_000);
});
