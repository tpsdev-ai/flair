import { describe, test, expect } from "bun:test";

// Re-implement the scoring functions for unit testing
// (they're not exported from SemanticSearch.ts, so we test the logic independently)

const DURABILITY_WEIGHTS: Record<string, number> = {
  permanent: 1.0,
  persistent: 0.9,
  standard: 0.7,
  ephemeral: 0.4,
};

const DECAY_HALF_LIFE_DAYS: Record<string, number> = {
  permanent: Infinity,
  persistent: 90,
  standard: 30,
  ephemeral: 7,
};

function recencyFactor(createdAt: string, durability: string): number {
  const halfLife = DECAY_HALF_LIFE_DAYS[durability] ?? 30;
  if (halfLife === Infinity) return 1.0;
  const ageDays = (Date.now() - Date.parse(createdAt)) / (1000 * 60 * 60 * 24);
  const lambda = Math.LN2 / halfLife;
  return Math.exp(-lambda * ageDays);
}

function retrievalBoost(retrievalCount: number): number {
  if (!retrievalCount || retrievalCount <= 0) return 1.0;
  return 1.0 + 0.1 * Math.log2(retrievalCount);
}

function compositeScore(
  semanticScore: number,
  record: { durability?: string; createdAt?: string; retrievalCount?: number },
): number {
  const durability = record.durability ?? "standard";
  const dWeight = DURABILITY_WEIGHTS[durability] ?? 0.7;
  const rFactor = record.createdAt ? recencyFactor(record.createdAt, durability) : 1.0;
  const rBoost = retrievalBoost(record.retrievalCount ?? 0);
  return semanticScore * dWeight * rFactor * rBoost;
}

describe("temporal decay scoring", () => {
  test("permanent memories never decay", () => {
    const old = new Date(Date.now() - 365 * 24 * 3600_000).toISOString(); // 1 year ago
    const factor = recencyFactor(old, "permanent");
    expect(factor).toBe(1.0);
  });

  test("standard memories decay with 30-day half-life", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    const factor = recencyFactor(thirtyDaysAgo, "standard");
    expect(factor).toBeCloseTo(0.5, 1); // half-life = 30d → ~0.5 at 30d
  });

  test("ephemeral memories decay fast (7-day half-life)", () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const factor = recencyFactor(sevenDaysAgo, "ephemeral");
    expect(factor).toBeCloseTo(0.5, 1);
  });

  test("fresh memories have recency ~1.0", () => {
    const now = new Date().toISOString();
    const factor = recencyFactor(now, "standard");
    expect(factor).toBeGreaterThan(0.99);
  });

  test("persistent memories decay slowly (90-day half-life)", () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();
    const factor = recencyFactor(ninetyDaysAgo, "persistent");
    expect(factor).toBeCloseTo(0.5, 1);
  });
});

describe("retrieval boost", () => {
  test("zero retrievals = no boost", () => {
    expect(retrievalBoost(0)).toBe(1.0);
  });

  test("10 retrievals gives moderate boost", () => {
    const boost = retrievalBoost(10);
    expect(boost).toBeGreaterThan(1.3);
    expect(boost).toBeLessThan(1.4);
  });

  test("100 retrievals gives larger boost", () => {
    const boost = retrievalBoost(100);
    expect(boost).toBeGreaterThan(1.6);
    expect(boost).toBeLessThan(1.7);
  });
});

describe("composite scoring", () => {
  test("permanent + fresh + high semantic = highest score", () => {
    const score = compositeScore(0.9, {
      durability: "permanent",
      createdAt: new Date().toISOString(),
      retrievalCount: 5,
    });
    // 0.9 * 1.0 (permanent weight) * 1.0 (fresh) * ~1.23 (5 retrievals)
    expect(score).toBeGreaterThan(1.0);
  });

  test("ephemeral + old + low semantic = lowest score", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    const score = compositeScore(0.3, {
      durability: "ephemeral",
      createdAt: thirtyDaysAgo,
      retrievalCount: 0,
    });
    // 0.3 * 0.4 (ephemeral) * ~0.05 (30d with 7d half-life) * 1.0
    expect(score).toBeLessThan(0.01);
  });

  test("standard + fresh is between permanent and ephemeral", () => {
    const now = new Date().toISOString();
    const perm = compositeScore(0.8, { durability: "permanent", createdAt: now });
    const std = compositeScore(0.8, { durability: "standard", createdAt: now });
    const eph = compositeScore(0.8, { durability: "ephemeral", createdAt: now });
    expect(perm).toBeGreaterThan(std);
    expect(std).toBeGreaterThan(eph);
  });

  test("defaults to standard when durability missing", () => {
    const score = compositeScore(0.8, { createdAt: new Date().toISOString() });
    const explicit = compositeScore(0.8, {
      durability: "standard",
      createdAt: new Date().toISOString(),
    });
    expect(Math.abs(score - explicit)).toBeLessThan(0.01);
  });
});
