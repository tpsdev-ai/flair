import { describe, it, expect } from "bun:test";
import { categorizeForHygiene, HYGIENE_TEST_CONTENT_PATTERNS } from "../../src/cli";

const ALL: Set<"compact-id" | "test-content" | "tiny"> = new Set(["compact-id", "test-content", "tiny"]);
const opts = (enabled = ALL, tinyThreshold = 25) => ({ enabled, tinyThreshold });

describe("memory hygiene: categorizeForHygiene", () => {
  describe("compact-id pattern", () => {
    it("matches ids containing -compact-", () => {
      expect(categorizeForHygiene({ id: "kern-compact-1775316911221-0" }, opts())).toContain("compact-id");
      expect(categorizeForHygiene({ id: "anvil-compact-12345" }, opts())).toContain("compact-id");
    });
    it("does not match normal ids", () => {
      expect(categorizeForHygiene({ id: "flint-1773456475560", content: "x".repeat(100) }, opts())).toEqual([]);
      expect(categorizeForHygiene({ id: "flint-uuid-1234-compact", content: "x".repeat(100) }, opts())).toEqual([]); // suffix only, no -compact-
    });
    it("is skipped when not enabled", () => {
      const enabled = new Set(["test-content"] as ("compact-id" | "test-content" | "tiny")[]);
      expect(categorizeForHygiene({ id: "kern-compact-x", content: "x".repeat(100) }, opts(enabled as any))).toEqual([]);
    });
  });

  describe("test-content pattern", () => {
    it("matches the pangram", () => {
      expect(categorizeForHygiene({ id: "x", content: "the quick brown fox jumps over the lazy dog" }, opts())).toContain("test-content");
    });
    it("matches Flair 251 test fixture content", () => {
      expect(categorizeForHygiene({ id: "x", content: "Flair 251 test memory" }, opts())).toContain("test-content");
      expect(categorizeForHygiene({ id: "x", content: "flair  251   test bigger blob" }, opts())).toContain("test-content");
    });
    it("matches upgrade-smoke markers", () => {
      expect(categorizeForHygiene({ id: "x", content: "upgrade-smoke-pre-marker" }, opts())).toContain("test-content");
      expect(categorizeForHygiene({ id: "x", content: "upgrade-smoke-post-marker" }, opts())).toContain("test-content");
    });
    it("does not match real content that mentions a fox without the pangram", () => {
      expect(categorizeForHygiene({ id: "x", content: "a brown fox crossing the street is fine" }, opts())).toEqual([]);
    });
    it("does not match content where 'Flair 251' and 'test' are separated", () => {
      // Regex requires \s*251\s*test — a contiguous match. "Flair 251 was a
      // PR landed in March; not a test fixture" has many words between, so
      // it correctly skips real-prose mentions.
      expect(categorizeForHygiene({ id: "x", content: "Flair 251 was a security PR landed in March; not a test fixture." }, opts())).toEqual([]);
    });
  });

  describe("tiny pattern", () => {
    it("matches content shorter than threshold (default 25)", () => {
      expect(categorizeForHygiene({ id: "x", content: "ok" }, opts())).toContain("tiny");
      expect(categorizeForHygiene({ id: "x", content: "test echo check" }, opts())).toContain("tiny");
    });
    it("respects custom threshold", () => {
      const o = opts(ALL, 5);
      expect(categorizeForHygiene({ id: "x", content: "tiny" }, o)).toContain("tiny");
      expect(categorizeForHygiene({ id: "x", content: "tinyenough" }, o)).toEqual([]);
    });
    it("does not flag normal-length content", () => {
      expect(categorizeForHygiene({ id: "real-id", content: "a".repeat(1000) }, opts())).toEqual([]);
    });
    it("missing content field never counts as tiny", () => {
      expect(categorizeForHygiene({ id: "real-id" }, opts())).toEqual([]);
    });
  });

  describe("multi-category", () => {
    it("a row can match multiple categories", () => {
      // compact-id PLUS tiny content
      const cats = categorizeForHygiene({ id: "k-compact-1", content: "ok" }, opts());
      expect(cats).toContain("compact-id");
      expect(cats).toContain("tiny");
    });
  });

  describe("HYGIENE_TEST_CONTENT_PATTERNS export", () => {
    it("is the canonical set used by the predicate", () => {
      expect(HYGIENE_TEST_CONTENT_PATTERNS.length).toBeGreaterThan(0);
      // sanity: the patterns are RegExp objects
      for (const p of HYGIENE_TEST_CONTENT_PATTERNS) {
        expect(p).toBeInstanceOf(RegExp);
      }
    });
  });
});
