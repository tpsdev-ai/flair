import { describe, test, expect } from "bun:test";
// OPS-AYGD: import the REAL scoring functions from SemanticSearch.ts. This file
// previously re-declared them ("they're not exported, so we test the logic
// independently") — a simulator that could not catch changes to the real module.
// The functions are now exported so these tests exercise the shipped code.
import { recencyFactor, retrievalBoost, usageBoost, compositeScore, getCompositeDiscountFloor } from "../../resources/scoring.ts";

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

// flair#683: usageBoost is the SAME shape as retrievalBoost by design (K&S
// verdict — the only variable in the harness rematch should be signal
// QUALITY, not magnitude). Mirrors the block above exactly.
describe("usage boost (flair#683: same gentle-nudge shape as retrievalBoost)", () => {
  test("zero usage = no boost", () => {
    expect(usageBoost(0)).toBe(1.0);
  });

  test("a single usage report is not yet boosted", () => {
    expect(usageBoost(1)).toBe(1.0);
  });

  test("boost is capped at 1.1 — a tie-breaker, never an override", () => {
    expect(usageBoost(10)).toBe(1.1);
    expect(usageBoost(100)).toBe(1.1);
    expect(usageBoost(1_000_000)).toBe(1.1);
  });
});

describe("composite scoring (flair#683: usageBoost REPLACES retrievalBoost)", () => {
  test("retrievalCount alone (no usageCount) no longer affects compositeScore — the contamination is actually gone", () => {
    // THE regression this PR must prove: a huge retrievalCount used to lift
    // compositeScore via retrievalBoost (OPS-AYGD's magnet bug). Kern's Q1
    // verdict was to drop retrievalBoost from compositeScore OUTRIGHT, not
    // just outweigh it — so a record with retrievalCount=1000 and NO
    // usageCount must score IDENTICALLY to one with retrievalCount=0.
    const popularByRetrieval = compositeScore(0.7, { durability: "standard", createdAt: now(), retrievalCount: 1000 });
    const cold = compositeScore(0.7, { durability: "standard", createdAt: now() });
    expect(popularByRetrieval).toBeCloseTo(cold, 10);
  });

  test("below the relevance floor, a heavily-used doc gets NO usage boost", () => {
    // semanticScore 0.3 < 0.5 floor → boost must not apply despite huge usageCount
    const popular = compositeScore(0.3, { durability: "standard", createdAt: now(), usageCount: 1000 });
    const cold = compositeScore(0.3, { durability: "standard", createdAt: now(), usageCount: 0 });
    expect(popular).toBeCloseTo(cold, 5);
  });

  test("above the relevance floor, the (capped) usage boost applies", () => {
    const boosted = compositeScore(0.7, { durability: "standard", createdAt: now(), usageCount: 1000 });
    const cold = compositeScore(0.7, { durability: "standard", createdAt: now(), usageCount: 0 });
    expect(boosted).toBeGreaterThan(cold);
    expect(boosted / cold).toBeCloseTo(1.1, 2); // capped at +10%
  });

  test("MAGNET GUARD: a low-semantic heavily-used doc cannot outrank a high-semantic unused doc", () => {
    const magnet = compositeScore(0.45, { durability: "standard", createdAt: now(), usageCount: 1000 }); // below floor → no lift
    const relevant = compositeScore(0.6, { durability: "standard", createdAt: now(), usageCount: 0 });
    expect(relevant).toBeGreaterThan(magnet);
  });

  test("permanent + fresh + high semantic + real usage = a high score", () => {
    // 0.9 sem * 1.0 (permanent) * ~1.0 (fresh) * 1.1 (capped boost) ≈ 0.99
    expect(compositeScore(0.9, { durability: "permanent", createdAt: now(), usageCount: 5 })).toBeGreaterThan(0.95);
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

describe("composite scoring (flair#623 follow-up: bounded + relevance-gated dWeight/rFactor)", () => {
  // recall-harness's stress-pair shape (test/bench/recall-harness/corpus.ts):
  // a `standard`/weeks-old CORRECT match vs a `permanent`/2-day-old, adjacent
  // -but-wrong DISTRACTOR, both clearing the relevance floor. This is the
  // exact mechanism that collapsed composite p@3 to 0.067 pre-fix.
  test("REGRESSION GUARD: a high-relevance stale/standard match still outranks a lower-relevance permanent/fresh distractor", () => {
    const oldStandardDaysAgo = new Date(Date.now() - 75 * 24 * 3600_000).toISOString();
    const freshPermanent = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    const correct = compositeScore(0.984, { durability: "standard", createdAt: oldStandardDaysAgo });
    const distractor = compositeScore(0.871, { durability: "permanent", createdAt: freshPermanent });
    expect(correct).toBeGreaterThan(distractor);
  });

  test("the durability/recency discount is bounded — it can never exceed (1 - discountFloor) of rawScore", () => {
    const floor = getCompositeDiscountFloor();
    // Worst case: ephemeral (lowest dWeight) and maximally decayed (rFactor -> 0).
    const ancient = new Date(Date.now() - 10_000 * 24 * 3600_000).toISOString();
    const worstCase = compositeScore(0.9, { durability: "ephemeral", createdAt: ancient });
    expect(worstCase).toBeGreaterThanOrEqual(0.9 * floor - 1e-9);
  });

  test("durability/recency remains a monotonic (if bounded) signal among relevant candidates", () => {
    const n = now();
    const perm = compositeScore(0.8, { durability: "permanent", createdAt: n });
    const std = compositeScore(0.8, { durability: "standard", createdAt: n });
    const eph = compositeScore(0.8, { durability: "ephemeral", createdAt: n });
    expect(perm).toBeGreaterThanOrEqual(std);
    expect(std).toBeGreaterThanOrEqual(eph);
  });

  test("below the relevance floor, the durability/recency multiplier is fully neutral (no discount at all)", () => {
    const oldEphemeral = new Date(Date.now() - 1000 * 24 * 3600_000).toISOString();
    const belowFloor = compositeScore(0.2, { durability: "ephemeral", createdAt: oldEphemeral });
    expect(belowFloor).toBeCloseTo(0.2, 5); // multiplier === 1.0, unlike a naive floor-less discount
  });
});
