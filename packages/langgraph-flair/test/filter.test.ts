import { describe, it, expect } from "bun:test";
import { matchesFilter, matchesAllFilters } from "../src/index";

// Coverage target per Kern's #370 review: all 7 operator branches of
// matchesFilter ($eq, $ne, $gt, $gte, $lt, $lte, bare-value), plus
// matchesAllFilters' multi-field AND semantics and edge cases.

describe("matchesFilter (single field)", () => {
  describe("bare value (implicit $eq)", () => {
    it("matches equal strings", () => {
      expect(matchesFilter("active", "active")).toBe(true);
      expect(matchesFilter("active", "stale")).toBe(false);
    });
    it("matches equal numbers", () => {
      expect(matchesFilter(42, 42)).toBe(true);
      expect(matchesFilter(42, 43)).toBe(false);
    });
    it("treats null as a bare value", () => {
      expect(matchesFilter(null, null)).toBe(true);
      expect(matchesFilter("x", null)).toBe(false);
    });
    it("returns false when types don't match (strict equality)", () => {
      expect(matchesFilter("42", 42)).toBe(false);
    });
  });

  describe("$eq", () => {
    it("matches when equal", () => {
      expect(matchesFilter("a", { $eq: "a" })).toBe(true);
      expect(matchesFilter(42, { $eq: 42 })).toBe(true);
    });
    it("rejects when unequal", () => {
      expect(matchesFilter("a", { $eq: "b" })).toBe(false);
    });
  });

  describe("$ne", () => {
    it("matches when unequal", () => {
      expect(matchesFilter("a", { $ne: "b" })).toBe(true);
    });
    it("rejects when equal", () => {
      expect(matchesFilter("a", { $ne: "a" })).toBe(false);
    });
  });

  describe("$gt", () => {
    it("matches strictly greater", () => {
      expect(matchesFilter(5, { $gt: 4 })).toBe(true);
    });
    it("rejects equal", () => {
      expect(matchesFilter(5, { $gt: 5 })).toBe(false);
    });
    it("rejects less", () => {
      expect(matchesFilter(3, { $gt: 5 })).toBe(false);
    });
  });

  describe("$gte", () => {
    it("matches strictly greater", () => {
      expect(matchesFilter(5, { $gte: 4 })).toBe(true);
    });
    it("matches equal", () => {
      expect(matchesFilter(5, { $gte: 5 })).toBe(true);
    });
    it("rejects less", () => {
      expect(matchesFilter(3, { $gte: 5 })).toBe(false);
    });
  });

  describe("$lt", () => {
    it("matches strictly less", () => {
      expect(matchesFilter(3, { $lt: 5 })).toBe(true);
    });
    it("rejects equal", () => {
      expect(matchesFilter(5, { $lt: 5 })).toBe(false);
    });
    it("rejects greater", () => {
      expect(matchesFilter(7, { $lt: 5 })).toBe(false);
    });
  });

  describe("$lte", () => {
    it("matches strictly less", () => {
      expect(matchesFilter(3, { $lte: 5 })).toBe(true);
    });
    it("matches equal", () => {
      expect(matchesFilter(5, { $lte: 5 })).toBe(true);
    });
    it("rejects greater", () => {
      expect(matchesFilter(7, { $lte: 5 })).toBe(false);
    });
  });

  describe("multi-operator object (logical AND across operators)", () => {
    it("matches when all operators pass", () => {
      expect(matchesFilter(5, { $gte: 4, $lt: 10 })).toBe(true);
    });
    it("rejects when any operator fails", () => {
      expect(matchesFilter(5, { $gte: 4, $lt: 5 })).toBe(false);
      expect(matchesFilter(5, { $gte: 6, $lt: 10 })).toBe(false);
    });
  });

  describe("unknown operators", () => {
    it("falls back to bare-value equality (so unrecognized $foo doesn't crash)", () => {
      // The unknown-operator branch returns `value === condition`, where
      // condition is the whole object. `5 === { $foo: 5 }` is false, so the
      // contract is "unknown ops never match" — safe-by-default.
      expect(matchesFilter(5, { $foo: 5 })).toBe(false);
    });
  });
});

describe("matchesAllFilters (multi-field AND)", () => {
  it("returns true when no filter is provided", () => {
    expect(matchesAllFilters({ a: 1, b: 2 }, undefined)).toBe(true);
  });
  it("returns true when all field conditions match", () => {
    expect(matchesAllFilters({ status: "active", score: 5 }, { status: "active", score: { $gte: 4 } })).toBe(true);
  });
  it("returns false when any field condition fails", () => {
    expect(matchesAllFilters({ status: "active", score: 3 }, { status: "active", score: { $gte: 4 } })).toBe(false);
  });
  it("returns false when a filtered field is missing on the value", () => {
    expect(matchesAllFilters({ status: "active" }, { score: { $gte: 4 } })).toBe(false);
  });
  it("returns true when filter is an empty object (vacuously true)", () => {
    expect(matchesAllFilters({ a: 1 }, {})).toBe(true);
  });
});
