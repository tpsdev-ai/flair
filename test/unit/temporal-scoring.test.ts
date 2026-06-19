import { describe, test, expect } from "bun:test";
// OPS-AYGD: import the REAL scoring functions from scoring.ts. This file
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

describe("retrieval boost (OPS-AYGD: graduated, capped at 1.5)", () => {
  test("zero retrievals = no boost", () => {
    expect(retrievalBoost(0)).toBe(1.0);
  });

  test("a single retrieval is not yet boosted", () => {
    expect(retrievalBoost(1)).toBe(1.0);
  });

  test("boost is capped at 1.5 — graduated, not binary", () => {
    // log2(10) ≈ 3.32 → 1 + 0.1*3.32 = 1.332 (below cap, graduated)
    expect(retrievalBoost(10)).toBeCloseTo(1.332, 2);
    // log2(100) ≈ 6.64 → 1 + 0.1*6.64 = 1.664 → clamped to 1.5
    expect(retrievalBoost(100)).toBe(1.5);
    expect(retrievalBoost(1_000_000)).toBe(1.5);
  });
});

describe("composite scoring (OPS-AYGD: query-relative tie-breaker)", () => {
  test("doc at topScore is boosted", () => {
    const top = compositeScore(0.8, { durability: "standard", createdAt: now(), retrievalCount: 100 }, 0.8);
    const cold = compositeScore(0.8, { durability: "standard", createdAt: now(), retrievalCount: 0 }, 0.8);
    expect(top).toBeGreaterThan(cold);
  });

  test("doc within delta (topScore - 0.04) is boosted", () => {
    // 0.76 >= 0.8 - 0.05 = 0.75 → eligible → boosted
    const nearTop = compositeScore(0.76, { durability: "standard", createdAt: now(), retrievalCount: 100 }, 0.8);
    const cold = compositeScore(0.76, { durability: "standard", createdAt: now(), retrievalCount: 0 }, 0.8);
    expect(nearTop).toBeGreaterThan(cold);
  });

  test("doc below delta (topScore - 0.10) is NOT boosted", () => {
    // 0.70 < 0.8 - 0.05 = 0.75 → not eligible → no boost
    const below = compositeScore(0.70, { durability: "standard", createdAt: now(), retrievalCount: 1000 }, 0.8);
    const cold = compositeScore(0.70, { durability: "standard", createdAt: now(), retrievalCount: 0 }, 0.8);
    expect(below).toBeCloseTo(cold, 5);
  });

  test("MAGNET FIX: a low-relative popular doc cannot outrank a high-semantic fresh doc", () => {
    // topRaw = 0.9. The magnet at 0.55 is far below delta (0.9 - 0.05 = 0.85)
    // → no boost. The relevant doc at 0.88 is within delta → gets boost.
    // Relevant must outrank magnet.
    const magnet = compositeScore(0.55, { durability: "standard", createdAt: now(), retrievalCount: 1000 }, 0.9);
    const relevant = compositeScore(0.88, { durability: "standard", createdAt: now(), retrievalCount: 5 }, 0.9);
    expect(relevant).toBeGreaterThan(magnet);
  });

  test("default topScore = semanticScore keeps ungated callers boosting (backward compat)", () => {
    // Without an explicit topScore, the doc is always within delta of itself → boosted
    const boosted = compositeScore(0.3, { durability: "standard", createdAt: now(), retrievalCount: 100 });
    const cold = compositeScore(0.3, { durability: "standard", createdAt: now(), retrievalCount: 0 });
    expect(boosted).toBeGreaterThan(cold);
  });

  test("permanent + fresh + high semantic = a high score", () => {
    // 0.9 sem * 1.0 (permanent) * ~1.0 (fresh) * capped boost ≈ high
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
