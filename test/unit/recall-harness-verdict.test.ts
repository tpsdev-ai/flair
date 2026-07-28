import { describe, test, expect } from "bun:test";

import { classifyDelta, MRR_RESOLUTION_RR_POINTS } from "../bench/recall-harness/verdict";

// flair#888 — the rule that decides whether an A/B delta is a real difference.
//
// THE BUG THIS PINS: the naive rule is "|Δ| > standard error ⇒ significant".
// Every measurement this harness has ever produced came back with ±0.000
// run-to-run variance (deterministic corpus, deterministic HNSW build), so
// under that rule ANY nonzero delta is significant — including a delta
// smaller than one query. The first real rerank measurement landed exactly
// there (ΔMRR = +0.003 at ±0.000 SE), and calling that a win would have been
// the same species of error as reporting a config you never ran.

const V2_QUERIES = 126;

describe("classifyDelta — the deterministic-corpus trap", () => {
  test("the measured rerank A/B (ΔMRR +0.003 at SE ±0.000) is BELOW RESOLUTION, not significant", () => {
    const c = classifyDelta({ dP3: 0, dMrr: 0.949 - 0.946, seP3: 0, seMrr: 0, nQueries: V2_QUERIES });
    expect(c.verdict).toBe("below-resolution");
    // Zero queries changed top-3 membership; MRR moved under half a
    // reciprocal-rank point across the whole set.
    expect(c.p3Queries).toBeCloseTo(0, 6);
    expect(Math.abs(c.mrrPoints)).toBeLessThan(MRR_RESOLUTION_RR_POINTS);
    expect(c.explanation).toContain("Not a difference");
  });

  test("a nonzero delta at SE=0 is NOT automatically resolved (the naive rule's failure)", () => {
    // Under "|Δ| > SE ⇒ significant" this returns significant. It must not.
    const c = classifyDelta({ dP3: 0, dMrr: 0.001, seP3: 0, seMrr: 0, nQueries: V2_QUERIES });
    expect(c.verdict).not.toBe("resolved");
  });

  test("a delta of exactly zero is not a difference", () => {
    expect(classifyDelta({ dP3: 0, dMrr: 0, seP3: 0, seMrr: 0, nQueries: V2_QUERIES }).verdict).toBe("below-resolution");
  });
});

describe("classifyDelta — deltas the instrument CAN see", () => {
  test("one whole query leaving the top 3 is resolved", () => {
    // Δp@3 of exactly 1/N is one query — the smallest movement p@3 can express.
    const c = classifyDelta({ dP3: -1 / V2_QUERIES, dMrr: -0.5 / V2_QUERIES, seP3: 0, seMrr: 0, nQueries: V2_QUERIES });
    expect(c.verdict).toBe("resolved");
    expect(c.p3Queries).toBeCloseTo(-1, 6);
  });

  test("a large MRR reshuffle with no p@3 change is still resolved", () => {
    // Four queries moving rank 2 → rank 1: 2.0 reciprocal-rank points, none
    // of them crossing the top-3 boundary. Real, and worth reporting.
    const c = classifyDelta({ dP3: 0, dMrr: 2 / V2_QUERIES, seP3: 0, seMrr: 0, nQueries: V2_QUERIES });
    expect(c.verdict).toBe("resolved");
    expect(c.mrrPoints).toBeCloseTo(2, 6);
  });

  test("the v1 prefix regression (Δp@3 -0.033 at N=30 = one query) is resolved, matching the README's own reading", () => {
    const c = classifyDelta({ dP3: -0.033, dMrr: -0.036, seP3: 0, seMrr: 0, nQueries: 30 });
    expect(c.verdict).toBe("resolved");
    expect(c.p3Queries).toBeCloseTo(-0.99, 2);
  });
});

describe("classifyDelta — noise and missing variance", () => {
  test("a genuinely noisy instrument still gets the error-bar test", () => {
    // Big enough to clear resolution, but swamped by run-to-run noise.
    const c = classifyDelta({ dP3: 0.02, dMrr: 0.02, seP3: 0.05, seMrr: 0.05, nQueries: V2_QUERIES });
    expect(c.verdict).toBe("inside-error-bars");
  });

  test("a delta above both floors is resolved", () => {
    const c = classifyDelta({ dP3: 0.10, dMrr: 0.10, seP3: 0.01, seMrr: 0.01, nQueries: V2_QUERIES });
    expect(c.verdict).toBe("resolved");
  });

  test("a single run has NO variance estimate and must say so, not assume zero noise", () => {
    const c = classifyDelta({ dP3: 0.10, dMrr: 0.10, seP3: null, seMrr: null, nQueries: V2_QUERIES });
    expect(c.verdict).toBe("no-variance-estimate");
    expect(c.explanation).toContain("--runs 3");
  });
});

describe("classifyDelta — unit conversion is the readable form", () => {
  test("p3Queries and mrrPoints are the delta expressed per query set", () => {
    const c = classifyDelta({ dP3: 0.5, dMrr: 0.25, seP3: 0, seMrr: 0, nQueries: 40 });
    expect(c.p3Queries).toBeCloseTo(20, 6);
    expect(c.mrrPoints).toBeCloseTo(10, 6);
  });
});
