/**
 * abstention.test.ts — resources/abstention.ts's abstention decision core
 * (flair#744 slice 2: first-class recall abstention, "no memory covers this").
 *
 * Pure-function coverage — no Harper mocking needed. The recall wrappers
 * (SemanticSearch.post / BootstrapMemories.post) do only thin glue around these
 * two functions (read the `abstain` flag, feed the candidate pool in, act on the
 * verdict), so exercising the decision here against candidate-shaped arrays is
 * the substantive test of the slice's behavior:
 *   - below-threshold ⇒ abstention verdict (wrapper returns it INSTEAD of the
 *     weak matches);
 *   - at/above threshold ⇒ no abstention (wrapper returns normal results);
 *   - no embedding-based confidence to judge (null) ⇒ never abstain
 *     (conservative — return what was found);
 *   - the threshold is a single GLOBAL constant, and the decision reads ONLY a
 *     confidence number — never a principal (the no-per-principal invariant is
 *     structurally guarded in abstention-no-per-principal-tripwire.test.ts).
 */
import { describe, it, expect } from "bun:test";
import {
  ABSTENTION_THRESHOLD,
  evaluateAbstention,
  bestSemanticSimilarity,
} from "../../resources/abstention.ts";

const T = ABSTENTION_THRESHOLD;

describe("ABSTENTION_THRESHOLD — single global, conservative constant", () => {
  it("is a finite number in (0,1)", () => {
    expect(typeof ABSTENTION_THRESHOLD).toBe("number");
    expect(Number.isFinite(ABSTENTION_THRESHOLD)).toBe(true);
    expect(ABSTENTION_THRESHOLD).toBeGreaterThan(0);
    expect(ABSTENTION_THRESHOLD).toBeLessThan(1);
  });

  it("is conservative — below bootstrap's own task-relevance floor (0.3)", () => {
    // Abstention must err toward returning results, not over-abstaining: the
    // floor sits under the score band bootstrap already trusts, so it fires only
    // when there is essentially nothing near the query. (Calibrating this to
    // promote abstention to the default is a separate recall-bench follow-up.)
    expect(ABSTENTION_THRESHOLD).toBeLessThan(0.3);
  });
});

describe("evaluateAbstention — the decision (score-only, global threshold)", () => {
  it("below threshold ⇒ abstains, with reason + bestScore + threshold", () => {
    const v = evaluateAbstention(T - 0.05);
    expect(v.abstained).toBe(true);
    expect(v.reason).toBe("no memory above confidence threshold");
    expect(v.bestScore).toBe(T - 0.05);
    expect(v.threshold).toBe(T);
  });

  it("at threshold ⇒ does NOT abstain (>= floor returns results)", () => {
    const v = evaluateAbstention(T);
    expect(v.abstained).toBe(false);
    expect(v.reason).toBeUndefined();
    expect(v.bestScore).toBe(T);
    expect(v.threshold).toBe(T);
  });

  it("above threshold ⇒ does NOT abstain (normal results)", () => {
    const v = evaluateAbstention(0.9);
    expect(v.abstained).toBe(false);
    expect(v.reason).toBeUndefined();
    expect(v.bestScore).toBe(0.9);
  });

  it("null (no embedding-based match to judge) ⇒ never abstain, bestScore null", () => {
    const v = evaluateAbstention(null);
    expect(v.abstained).toBe(false);
    expect(v.bestScore).toBeNull();
    expect(v.threshold).toBe(T);
  });

  it("zero confidence ⇒ abstains (0 < floor)", () => {
    expect(evaluateAbstention(0).abstained).toBe(true);
  });

  it("the threshold in the verdict is ALWAYS the global constant (not caller-supplied)", () => {
    // evaluateAbstention takes no threshold parameter — there is no lever to
    // vary the floor per call / per principal (Sherlock binding condition 2).
    expect(evaluateAbstention(0.01).threshold).toBe(ABSTENTION_THRESHOLD);
    expect(evaluateAbstention(0.99).threshold).toBe(ABSTENTION_THRESHOLD);
  });
});

describe("bestSemanticSimilarity — best absolute confidence across the pool", () => {
  it("returns the max `_semSimilarity` across candidates", () => {
    const pool = [{ _semSimilarity: 0.2 }, { _semSimilarity: 0.7 }, { _semSimilarity: 0.4 }];
    expect(bestSemanticSimilarity(pool)).toBe(0.7);
  });

  it("ignores candidates with no / null / non-finite similarity", () => {
    const pool = [
      { _semSimilarity: 0.3 },
      {},                                   // BM25-lexical-only — no cosine
      { _semSimilarity: null },
      { _semSimilarity: Number.NaN as any },
      { _semSimilarity: 0.55 },
    ];
    expect(bestSemanticSimilarity(pool)).toBe(0.55);
  });

  it("returns null when NO candidate carries a similarity (degraded / empty pool)", () => {
    expect(bestSemanticSimilarity([])).toBeNull();
    expect(bestSemanticSimilarity([{}, { _semSimilarity: null }])).toBeNull();
  });

  it("reads ONLY `_semSimilarity` — other fields on a candidate cannot change it", () => {
    // A candidate carrying an author/tier/agentId must not influence the
    // confidence the abstention decision sees (score-only, zero authority).
    const withAuthority = [
      { _semSimilarity: 0.1, agentId: "agt_alice", tier: "endorsed", _score: 1.0 },
      { _semSimilarity: 0.1, agentId: "agt_bob", tier: "unverified", _score: 0.2 },
    ];
    const plain = [{ _semSimilarity: 0.1 }, { _semSimilarity: 0.1 }];
    expect(bestSemanticSimilarity(withAuthority)).toBe(bestSemanticSimilarity(plain));
  });
});

describe("end-to-end decision over a candidate pool (the wrapper's exact logic)", () => {
  it("strong match present ⇒ NOT abstained (wrapper returns normal results)", () => {
    const pool = [{ _semSimilarity: 0.62, _score: 1.0 }, { _semSimilarity: 0.2, _score: 0.4 }];
    const v = evaluateAbstention(bestSemanticSimilarity(pool));
    expect(v.abstained).toBe(false);
    expect(v.bestScore).toBe(0.62);
  });

  it("all-weak pool ⇒ ABSTAINED (wrapper returns the verdict, no weak matches)", () => {
    const pool = [{ _semSimilarity: 0.08, _score: 1.0 }, { _semSimilarity: 0.05, _score: 0.6 }];
    const v = evaluateAbstention(bestSemanticSimilarity(pool));
    expect(v.abstained).toBe(true);
    expect(v.bestScore).toBe(0.08);
  });

  it("pool without any semantic confidence (keyword-only) ⇒ NOT abstained", () => {
    // No embedding-based match at all — abstention stays conservative and the
    // wrapper returns whatever it found rather than a confident "nothing covers".
    const pool = [{ _score: 0.05 }, { _score: 0.05 }];
    const v = evaluateAbstention(bestSemanticSimilarity(pool));
    expect(v.abstained).toBe(false);
    expect(v.bestScore).toBeNull();
  });

  it("the SAME best score yields the SAME verdict regardless of candidate authorship", () => {
    // Global, not per-principal: identical confidence ⇒ identical outcome even
    // when the pools are authored by different principals at different tiers.
    const poolA = [{ _semSimilarity: 0.09, agentId: "agt_alice", tier: "endorsed" }];
    const poolB = [{ _semSimilarity: 0.09, agentId: "agt_bob", tier: "unverified" }];
    const va = evaluateAbstention(bestSemanticSimilarity(poolA));
    const vb = evaluateAbstention(bestSemanticSimilarity(poolB));
    expect(va).toEqual(vb);
    expect(va.abstained).toBe(true);
  });
});
