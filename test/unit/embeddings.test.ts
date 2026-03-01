import { describe, it, expect } from "bun:test";
import { embed, cosineSimilarity } from "../../dist/resources/embeddings.js";

describe("embeddings", () => {
  it("generates 256-dimensional vector", () => {
    const vec = embed("hello world");
    expect(vec).toHaveLength(512);
  });

  it("produces normalized vectors", () => {
    const vec = embed("this is a test of the embedding system");
    const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
    expect(Math.abs(norm - 1.0)).toBeLessThan(0.001);
  });

  it("similar texts have higher similarity than dissimilar", () => {
    const a = embed("fixing CI pipeline typescript errors");
    const b = embed("CI build failures in typescript compilation");
    const c = embed("recipe for chocolate cake with frosting");

    const simAB = cosineSimilarity(a, b);
    const simAC = cosineSimilarity(a, c);

    expect(simAB).toBeGreaterThan(simAC);
  });

  it("identical texts have similarity 1.0", () => {
    const text = "Harper v5 HNSW vector index";
    const a = embed(text);
    const b = embed(text);
    const sim = cosineSimilarity(a, b);
    expect(Math.abs(sim - 1.0)).toBeLessThan(0.001);
  });

  it("empty-ish text returns zero vector", () => {
    const vec = embed("");
    const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
    expect(norm).toBe(0);
  });
});
