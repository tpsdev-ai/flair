import { describe, test, expect } from "bun:test";
// Exercise the SHIPPED BM25 module (resources/bm25.ts) directly — Harper-free,
// same convention as temporal-scoring.test.ts. FLAIR-BM25-HYBRID.
import {
  tokenize,
  buildBM25,
  fuseRrfNormalized,
  rrfScores,
  hybridEnabled,
  BM25_K1,
  BM25_B,
  RRF_K,
  SEM_LIMIT,
} from "../../resources/bm25.ts";

describe("feature flag — FLAIR_HYBRID_RETRIEVAL (ACTIVATED 2026-07-08: default ON)", () => {
  const orig = process.env.FLAIR_HYBRID_RETRIEVAL;
  const restore = () => {
    if (orig === undefined) delete process.env.FLAIR_HYBRID_RETRIEVAL;
    else process.env.FLAIR_HYBRID_RETRIEVAL = orig;
  };

  test("unset → ON (hybrid is now the default retrieval path)", () => {
    delete process.env.FLAIR_HYBRID_RETRIEVAL;
    expect(hybridEnabled()).toBe(true);
    restore();
  });
  test("'false' / 'off' / '0' → OFF (the revert lever: legacy HNSW path, byte-identical to pre-hybrid behavior)", () => {
    for (const v of ["false", "off", "0", "FALSE", "no"]) {
      process.env.FLAIR_HYBRID_RETRIEVAL = v;
      expect(hybridEnabled()).toBe(false);
    }
    restore();
  });
  test("'' (explicitly set to empty string) → OFF — `??` only falls back on null/undefined, not '', so an explicit empty value does NOT inherit the ON default", () => {
    process.env.FLAIR_HYBRID_RETRIEVAL = "";
    expect(hybridEnabled()).toBe(false);
    restore();
  });
  test("'true' / '1' / 'on' (any case) → ON", () => {
    for (const v of ["true", "1", "on", "TRUE", "On"]) {
      process.env.FLAIR_HYBRID_RETRIEVAL = v;
      expect(hybridEnabled()).toBe(true);
    }
    restore();
  });
});

describe("tie-break — score DESC, then ascending id (flair#1363)", () => {
  // Before this comparator was explicit, `rank()` sorted on score alone. A
  // stable sort then left EQUAL-SCORING documents in the order the caller had
  // fetched the corpus in — Harper's, which is a query-plan artifact: measured
  // on a live instance, the same rows for the same query text iterate
  // own-agent-first under the read-scope OR-group and primary-key-first under a
  // tags/subject filter (test/integration/bm25-index-scan-order-1357.test.ts).
  // So hybrid recall was NONDETERMINISTIC for tied documents, and only exact
  // ties moved, which is why nothing caught it. The explicit tie-break is also
  // what makes resources/bm25-index.ts able to serve the lexical leg at all —
  // it can reproduce `id` ascending; it cannot reproduce a planner.
  const tied = [
    { id: "zzz", content: "alpha beta gamma" },
    { id: "aaa", content: "alpha beta gamma" },
    { id: "mmm", content: "alpha beta gamma" },
  ];

  test("documents with identical scores come back in ascending id order", () => {
    const ranked = buildBM25(tied).rank("alpha beta gamma");
    // Genuinely tied — otherwise this asserts nothing about tie-breaking.
    expect(new Set(ranked.map((r) => r.score)).size).toBe(1);
    expect(ranked.map((r) => r.id)).toEqual(["aaa", "mmm", "zzz"]);
  });

  test("insertion order does NOT decide it — the same set in any order ranks the same", () => {
    // This is the property the old stable-sort-only comparator failed: corpus
    // order leaked into the result. Feed the same documents in a different
    // order and the ranking must not move.
    const shuffled = [tied[1], tied[2], tied[0]];
    expect(buildBM25(shuffled).rank("alpha beta gamma").map((r) => r.id))
      .toEqual(buildBM25(tied).rank("alpha beta gamma").map((r) => r.id));
  });

  test("score still dominates — the tie-break only orders EQUAL scores", () => {
    const docs = [
      { id: "zzz", content: "alpha alpha alpha beta" }, // strongest
      { id: "aaa", content: "alpha unrelated words here padding padding padding" },
    ];
    const ranked = buildBM25(docs).rank("alpha");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked.map((r) => r.id)).toEqual(["zzz", "aaa"]); // NOT id order
  });
});

describe("BM25 params (Kern-approved)", () => {
  test("k1≈1.2, b≈0.75, RRF K=60, SEM_LIMIT=50", () => {
    expect(BM25_K1).toBe(1.2);
    expect(BM25_B).toBe(0.75);
    expect(RRF_K).toBe(60);
    expect(SEM_LIMIT).toBe(50);
  });
});

describe("tokenize", () => {
  test("lowercases, splits on non-alphanumeric, drops 1-char tokens", () => {
    expect(tokenize("Hello, WORLD! a x42")).toEqual(["hello", "world", "x42"]);
  });
  test("drops trivial stopwords", () => {
    // "the", "of", "a", "to" are stopwords; "harper" / "user" survive.
    expect(tokenize("the phantom of a Harper user to")).toEqual(["phantom", "harper", "user"]);
  });
  test("handles empty / nullish content", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize(undefined as any)).toEqual([]);
  });
});

describe("BM25 scoring", () => {
  const docs = [
    { id: "a", content: "Harper getUser returns a phantom user for a nonexistent username" },
    { id: "b", content: "the flair npm release flow uses OIDC staging and 2FA approval" },
    { id: "c", content: "Kern and Sherlock production model assignments on ollama" },
    { id: "d", content: "completely unrelated content about gardening and soil" },
  ];

  test("ranks the near-verbatim doc first for a lexical query", () => {
    const bm25 = buildBM25(docs);
    const ranked = bm25.rank("Harper getUser phantom user nonexistent");
    expect(ranked[0].id).toBe("a");
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  test("a doc with no query-term overlap scores exactly 0", () => {
    const bm25 = buildBM25(docs);
    const ranked = bm25.rank("Harper getUser phantom");
    const gardening = ranked.find(r => r.id === "d");
    expect(gardening!.score).toBe(0);
  });

  test("rarer terms (lower df → higher idf) contribute more than common ones", () => {
    // "phantom" appears in 1 doc; "and" is a stopword (dropped). "content"
    // appears once too — but "getuser"/"phantom"/"username" are unique to a.
    const bm25 = buildBM25(docs);
    const rareHit = bm25.rank("phantom")[0];
    expect(rareHit.id).toBe("a");
    expect(rareHit.score).toBeGreaterThan(0);
  });

  test("empty corpus does not throw and yields no positive scores", () => {
    const bm25 = buildBM25([]);
    expect(bm25.N).toBe(0);
    expect(bm25.rank("anything")).toEqual([]);
  });

  test("term frequency saturates per BM25 k1 (not unbounded)", () => {
    const repeated = [
      { id: "x1", content: "alpha" },
      { id: "x5", content: "alpha alpha alpha alpha alpha" },
    ];
    const bm25 = buildBM25(repeated);
    const r = bm25.rank("alpha");
    const s1 = r.find(d => d.id === "x1")!.score;
    const s5 = r.find(d => d.id === "x5")!.score;
    // More occurrences score higher, but sub-linearly (saturation), so 5x tf is
    // far less than 5x the score.
    expect(s5).toBeGreaterThan(s1);
    expect(s5).toBeLessThan(s1 * 5);
  });
});

describe("RRF — union fusion, K=60, normalization", () => {
  test("rrfScores: a doc absent from a list contributes 0 from that list", () => {
    const semIds = ["a", "b", "c"]; // a is rank-1 semantically
    const bm25Ids = ["c", "z"];     // c rank-1, z rank-2 in BM25
    const union = new Set(["a", "b", "c", "z"]);
    const scores = rrfScores([semIds, bm25Ids], union);
    // a: 1/(60+1) from sem only
    expect(scores.get("a")).toBeCloseTo(1 / 61, 12);
    // c: 1/(60+3) from sem + 1/(60+1) from bm25
    expect(scores.get("c")).toBeCloseTo(1 / 63 + 1 / 61, 12);
    // z: 1/(60+2) from bm25 only
    expect(scores.get("z")).toBeCloseTo(1 / 62, 12);
  });

  test("uses K=60 exactly (rank-1 in one list → 1/61)", () => {
    const scores = rrfScores([["only"]], new Set(["only"]));
    expect(scores.get("only")).toBeCloseTo(1 / 61, 12);
  });

  test("fuseRrfNormalized: union dedupes ids and normalizes max to 1.0", () => {
    const semIds = ["a", "b"];
    const bm25Ids = ["b", "c"]; // b appears in both → highest raw RRF
    const norm = fuseRrfNormalized(semIds, bm25Ids);
    // union = {a, b, c}, no duplicates
    expect([...norm.keys()].sort()).toEqual(["a", "b", "c"]);
    // b is in both lists → top score → normalized to exactly 1.0
    expect(norm.get("b")).toBeCloseTo(1.0, 12);
    // every normalized score is in [0,1]
    for (const v of norm.values()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test("BM25-only fusion (empty semantic list) degrades to BM25 ranking", () => {
    // No-embedding fallback: semIds = [] → RRF is BM25-only, normalized.
    const bm25Ids = ["top", "mid", "low"];
    const norm = fuseRrfNormalized([], bm25Ids);
    expect(norm.get("top")).toBeCloseTo(1.0, 12);          // rank-1 normalizes to 1
    expect(norm.get("mid")!).toBeLessThan(norm.get("top")!);
    expect(norm.get("low")!).toBeLessThan(norm.get("mid")!);
  });

  test("empty union normalizes to nothing without dividing by zero", () => {
    const norm = fuseRrfNormalized([], []);
    expect(norm.size).toBe(0);
  });
});
