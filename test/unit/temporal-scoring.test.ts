import { describe, test, expect } from "bun:test";
// OPS-AYGD: import the REAL scoring functions from SemanticSearch.ts. This file
// previously re-declared them ("they're not exported, so we test the logic
// independently") — a simulator that could not catch changes to the real module.
// The functions are now exported so these tests exercise the shipped code.
import { recencyFactor, retrievalBoost, compositeScore } from "../../resources/scoring.ts";

const now = () => new Date().toISOString();

describe("temporal decay scoring", () => {
  test("permanent memories never decay", () => {
    const old = new Date(Date.now() - 365 * 24 * 3600_000).toISOString();
    expect(recencyFactor(old, "permanent")).toBe(1.0);
  });

  test("standard memories decay with 30-day half-life", () => {
    const d = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    expect(recencyFactor(d, "standard")).toBeCloseTo(0.5, 1);
  });

  test("ephemeral memories decay fast (7-day half-life)", () => {
    const d = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    expect(recencyFactor(d, "ephemeral")).toBeCloseTo(0.5, 1);
  });

  test("fresh memories have recency ~1.0", () => {
    expect(recencyFactor(now(), "standard")).toBeGreaterThan(0.99);
  });

  test("persistent memories decay slowly (90-day half-life)", () => {
    const d = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();
    expect(recencyFactor(d, "persistent")).toBeCloseTo(0.5, 1);
  });
});

describe("retrieval boost (OPS-AYGD: bounded to a gentle nudge)", () => {
  test("zero retrievals = no boost", () => {
    expect(retrievalBoost(0)).toBe(1.0);
  });

  test("a single retrieval is not yet boosted", () => {
    expect(retrievalBoost(1)).toBe(1.0);
  });

  test("boost is capped at 1.1 — a tie-breaker, never an override", () => {
    // uncapped this would be 1 + 0.1*log2(rc); it clamps to the 1.1 cap by rc≈2
    expect(retrievalBoost(10)).toBe(1.1);
    expect(retrievalBoost(100)).toBe(1.1);
    expect(retrievalBoost(1_000_000)).toBe(1.1);
  });
});

describe("composite scoring (OPS-AYGD: relevance-floor gate)", () => {
  test("below the relevance floor, a popular doc gets NO retrieval boost", () => {
    // semanticScore 0.3 < 0.5 floor → boost must not apply despite huge retrievalCount
    const popular = compositeScore(0.3, { durability: "standard", createdAt: now(), retrievalCount: 1000 });
    const cold = compositeScore(0.3, { durability: "standard", createdAt: now(), retrievalCount: 0 });
    expect(popular).toBeCloseTo(cold, 5);
  });

  test("above the relevance floor, the (capped) boost applies", () => {
    const boosted = compositeScore(0.7, { durability: "standard", createdAt: now(), retrievalCount: 1000 });
    const cold = compositeScore(0.7, { durability: "standard", createdAt: now(), retrievalCount: 0 });
    expect(boosted).toBeGreaterThan(cold);
    expect(boosted / cold).toBeCloseTo(1.1, 2); // capped at +10%
  });

  test("MAGNET FIX: a low-semantic popular doc cannot outrank a high-semantic fresh doc", () => {
    // Pre-fix the magnet's unbounded rBoost lifted it above relevant docs.
    const magnet = compositeScore(0.45, { durability: "standard", createdAt: now(), retrievalCount: 1000 }); // below floor → no lift
    const relevant = compositeScore(0.6, { durability: "standard", createdAt: now(), retrievalCount: 0 });
    expect(relevant).toBeGreaterThan(magnet);
  });

  test("permanent + fresh + high semantic = a high score", () => {
    // 0.9 sem * 1.0 (permanent) * ~1.0 (fresh) * 1.1 (capped boost) ≈ 0.99
    expect(compositeScore(0.9, { durability: "permanent", createdAt: now(), retrievalCount: 5 })).toBeGreaterThan(0.95);
  });

  test("standard + fresh is between permanent and ephemeral", () => {
    const n = now();
    const perm = compositeScore(0.8, { durability: "permanent", createdAt: n });
    const std = compositeScore(0.8, { durability: "standard", createdAt: n });
    const eph = compositeScore(0.8, { durability: "ephemeral", createdAt: n });
    expect(perm).toBeGreaterThan(std);
    expect(std).toBeGreaterThan(eph);
  });

  test("defaults to standard when durability missing", () => {
    const score = compositeScore(0.8, { createdAt: now() });
    const explicit = compositeScore(0.8, { durability: "standard", createdAt: now() });
    expect(Math.abs(score - explicit)).toBeLessThan(0.01);
  });
});
