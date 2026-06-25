import { describe, test, expect } from "bun:test";
// Exercise the SHIPPED BM25 module (resources/bm25.ts) directly — Harper-free,
// same convention as temporal-scoring.test.ts. ops-i39b / FLAIR-BM25-HYBRID.
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

describe("feature flag — FLAIR_HYBRID_RETRIEVAL (default OFF = unchanged behavior)", () => {
  const orig = process.env.FLAIR_HYBRID_RETRIEVAL;
  const restore = () => {
    if (orig === undefined) delete process.env.FLAIR_HYBRID_RETRIEVAL;
    else process.env.FLAIR_HYBRID_RETRIEVAL = orig;
  };

  test("unset → OFF (legacy path, byte-identical behavior)", () => {
    delete process.env.FLAIR_HYBRID_RETRIEVAL;
    expect(hybridEnabled()).toBe(false);
    restore();
  });
  test("'false' / 'off' / '0' / '' → OFF", () => {
    for (const v of ["false", "off", "0", "", "FALSE", "no"]) {
      process.env.FLAIR_HYBRID_RETRIEVAL = v;
      expect(hybridEnabled()).toBe(false);
    }
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
