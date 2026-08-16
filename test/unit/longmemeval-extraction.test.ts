import { describe, test, expect } from "bun:test";
import { normalize, tokenF1, containmentEM, strictEM, scoreExtraction } from "../bench/longmemeval/extraction";

// The F1/EM cross-check must be INDEPENDENT of the LLM judge (Sherlock #5) —
// pure string math against LongMemEval's gold key. These pin its behaviour so a
// silent regression in the anchor is caught.

describe("normalize — SQuAD-style", () => {
  test("lowercases, strips articles + punctuation, collapses whitespace", () => {
    expect(normalize("The  Business Administration!")).toBe("business administration");
    expect(normalize("A dog, and an apple.")).toBe("dog and apple");
  });
});

describe("tokenF1", () => {
  test("exact match after normalization is 1", () => {
    expect(tokenF1("Business Administration", "business administration")).toBe(1);
  });
  test("gold contained in a fluent sentence scores partial (< 1, > 0)", () => {
    const f1 = tokenF1("You graduated with a degree in Business Administration.", "Business Administration");
    expect(f1).toBeGreaterThan(0);
    expect(f1).toBeLessThan(1);
  });
  test("no overlap is 0", () => {
    expect(tokenF1("Computer Science", "Business Administration")).toBe(0);
  });
  test("empty prediction is 0 against a non-empty gold", () => {
    expect(tokenF1("", "anything")).toBe(0);
  });
});

describe("EM variants", () => {
  test("containmentEM matches gold as a token-boundary substring", () => {
    expect(containmentEM("You graduated with a degree in Business Administration.", "Business Administration")).toBe(1);
    expect(containmentEM("You graduated in Computer Science.", "Business Administration")).toBe(0);
  });
  test("containmentEM respects token boundaries (no mid-word match)", () => {
    // "art" must not match inside "Business" etc. — gold "cat" not present as a word.
    expect(containmentEM("concatenate the strings", "cat")).toBe(0);
  });
  test("strictEM only on full normalized equality", () => {
    expect(strictEM("Business Administration", "the business administration")).toBe(1);
    expect(strictEM("a degree in Business Administration", "Business Administration")).toBe(0);
  });
});

describe("scoreExtraction — alias reduction", () => {
  test("takes the best alias (| delimited)", () => {
    const s = scoreExtraction("I moved to Tokyo.", "Kyoto|Tokyo|Osaka");
    expect(s.containmentEM).toBe(1);
    expect(s.f1).toBeGreaterThan(0);
  });
  test("empty gold yields zeros, not a crash", () => {
    expect(scoreExtraction("anything", "")).toEqual({ f1: 0, containmentEM: 0, strictEM: 0 });
  });
});
