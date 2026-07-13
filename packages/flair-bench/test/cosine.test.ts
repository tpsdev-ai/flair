import { describe, test, expect } from "bun:test";
import { cosineSimilarity, rankOf } from "../src/cosine.js";

describe("cosineSimilarity", () => {
  test("identical vectors -> 1", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10);
  });

  test("orthogonal vectors -> 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  test("opposite vectors -> -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  test("scale-invariant (magnitude doesn't affect similarity)", () => {
    expect(cosineSimilarity([1, 1], [2, 2])).toBeCloseTo(1, 10);
  });

  test("dimension mismatch throws", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow();
  });

  test("zero vector -> 0, not NaN", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("rankOf", () => {
  const query = [1, 0];
  // index 0: identical -> sim=1 (best); index 1: orthogonal -> sim=0; index 2: opposite -> sim=-1 (worst)
  const corpus = [
    [1, 0],
    [0, 1],
    [-1, 0],
  ];

  test("best match ranks 0", () => {
    expect(rankOf(query, corpus, 0)).toBe(0);
  });

  test("worst match ranks last", () => {
    expect(rankOf(query, corpus, 2)).toBe(2);
  });

  test("middle match ranks in between", () => {
    expect(rankOf(query, corpus, 1)).toBe(1);
  });
});
