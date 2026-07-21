/**
 * trust-block.test.ts — resources/trust-block.ts's buildTrustBlock() /
 * attachTrust() (flair#744 slice 1: the opt-in inline trust-evidence block on
 * recall results).
 *
 * Pure-function unit coverage — no Harper mocking needed. buildTrustBlock takes
 * a plain Memory-record-shaped object and returns a plain block; attachTrust is
 * the opt-in wrapper search()/get() use. Covers:
 *   - each block field maps to the right ALREADY-STORED record field;
 *   - provenance verified-vs-claimed parsing (incl. legacy null / malformed /
 *     internal-write cases), and that raw claimed.* content is NEVER surfaced;
 *   - validity valid/expired/future + createdAt age (deterministic `now`);
 *   - the block never carries a `tier` (deferred, flair#744 Sherlock cond. 1);
 *   - purity: the input record is never mutated;
 *   - attachTrust opt-in: OFF ⇒ same reference (byte-identical), ON ⇒ additive
 *     copy carrying the block.
 */
import { describe, it, expect } from "bun:test";
import { buildTrustBlock, attachTrust, classifyMatchQuality } from "../../resources/trust-block.ts";
import { ABSTENTION_THRESHOLD, MODERATE_BAND, STRONG_BAND } from "../../resources/abstention.ts";

// A fixed clock so validity/age assertions are deterministic.
const NOW = Date.parse("2026-07-21T00:00:00.000Z");
const DAY = 86_400_000;

function prov(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

describe("buildTrustBlock — author principal (always included)", () => {
  it("surfaces the record's agentId as `author`", () => {
    const b = buildTrustBlock({ agentId: "agt_alice" }, NOW);
    expect(b.author).toBe("agt_alice");
  });

  it("author is null when agentId is missing (never throws)", () => {
    const b = buildTrustBlock({}, NOW);
    expect(b.author).toBeNull();
  });
});

describe("buildTrustBlock — provenance status (verified vs claimed)", () => {
  it("verified: derives status/verifiedAuthor/verifiedAt from provenance.verified", () => {
    const b = buildTrustBlock(
      { agentId: "agt_alice", provenance: prov({ v: 1, verified: { agentId: "agt_alice", timestamp: "2026-07-01T00:00:00.000Z" } }) },
      NOW,
    );
    expect(b.provenanceStatus).toBe("verified");
    expect(b.verifiedAuthor).toBe("agt_alice");
    expect(b.verifiedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(b.hasClaimedProvenance).toBe(false);
  });

  it("internal write (verified.agentId null) reads as unattributed", () => {
    const b = buildTrustBlock(
      { agentId: "agt_alice", provenance: prov({ v: 1, verified: { agentId: null, timestamp: "2026-07-01T00:00:00.000Z" } }) },
      NOW,
    );
    expect(b.provenanceStatus).toBe("unattributed");
    expect(b.verifiedAuthor).toBeNull();
    expect(b.verifiedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("legacy row (provenance null) reads as unattributed, no throw", () => {
    const b = buildTrustBlock({ agentId: "agt_alice", provenance: null }, NOW);
    expect(b.provenanceStatus).toBe("unattributed");
    expect(b.verifiedAuthor).toBeNull();
    expect(b.verifiedAt).toBeNull();
    expect(b.hasClaimedProvenance).toBe(false);
  });

  it("malformed provenance JSON reads as unattributed, no throw", () => {
    const b = buildTrustBlock({ agentId: "agt_alice", provenance: "{not json" }, NOW);
    expect(b.provenanceStatus).toBe("unattributed");
    expect(b.verifiedAuthor).toBeNull();
  });

  it("hasClaimedProvenance is a BOOLEAN — raw claimed.* content is NEVER surfaced", () => {
    const b = buildTrustBlock(
      {
        agentId: "agt_alice",
        provenance: prov({
          v: 1,
          verified: { agentId: "agt_alice", timestamp: "2026-07-01T00:00:00.000Z" },
          claimed: { model: "claude-opus-4-8", client: "claude-code" },
        }),
      },
      NOW,
    );
    expect(b.hasClaimedProvenance).toBe(true);
    // The self-reported values must not leak into the block under any key.
    const serialized = JSON.stringify(b);
    expect(serialized).not.toContain("claude-opus-4-8");
    expect(serialized).not.toContain("claude-code");
    expect((b as any).model).toBeUndefined();
    expect((b as any).client).toBeUndefined();
    expect((b as any).claimed).toBeUndefined();
  });
});

describe("buildTrustBlock — usage signal (flair#744 slice A: absent-vs-0 fix)", () => {
  it("maps a positive usageCount", () => {
    expect(buildTrustBlock({ agentId: "a", usageCount: 3 }, NOW).usageCount).toBe(3);
  });
  it("maps an explicit usageCount: 0 (recorded, zero uses) as 0, NOT null", () => {
    expect(buildTrustBlock({ agentId: "a", usageCount: 0 }, NOW).usageCount).toBe(0);
  });
  it("absent usageCount reads as null — never a false 0 — so a reader can tell 'no usage signal' apart from 'recorded, zero uses'", () => {
    expect(buildTrustBlock({ agentId: "a" }, NOW).usageCount).toBeNull();
  });
});

describe("buildTrustBlock — freshness / validity", () => {
  it("valid: no validTo, validFrom in the past", () => {
    const b = buildTrustBlock({ agentId: "a", validFrom: "2026-07-01T00:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z" }, NOW);
    expect(b.validityStatus).toBe("valid");
    expect(b.validFrom).toBe("2026-07-01T00:00:00.000Z");
    expect(b.validTo).toBeNull();
  });

  it("expired: validTo in the past", () => {
    const b = buildTrustBlock({ agentId: "a", validTo: "2026-07-10T00:00:00.000Z" }, NOW);
    expect(b.validityStatus).toBe("expired");
    expect(b.validTo).toBe("2026-07-10T00:00:00.000Z");
  });

  it("future: validFrom in the future (and no past validTo)", () => {
    const b = buildTrustBlock({ agentId: "a", validFrom: "2026-08-01T00:00:00.000Z" }, NOW);
    expect(b.validityStatus).toBe("future");
  });

  it("expired wins when validTo is past even if validFrom is future (malformed window)", () => {
    const b = buildTrustBlock({ agentId: "a", validFrom: "2026-08-01T00:00:00.000Z", validTo: "2026-07-10T00:00:00.000Z" }, NOW);
    expect(b.validityStatus).toBe("expired");
  });

  it("createdAt → ageDays (whole days), raw createdAt preserved", () => {
    const created = new Date(NOW - 3 * DAY).toISOString();
    const b = buildTrustBlock({ agentId: "a", createdAt: created }, NOW);
    expect(b.createdAt).toBe(created);
    expect(b.ageDays).toBe(3);
  });

  it("ageDays is null when createdAt is absent", () => {
    expect(buildTrustBlock({ agentId: "a" }, NOW).ageDays).toBeNull();
  });
});

describe("buildTrustBlock — supersession", () => {
  it("surfaces the forward `supersedes` pointer", () => {
    expect(buildTrustBlock({ agentId: "a", supersedes: "mem_old" }, NOW).supersedes).toBe("mem_old");
  });
  it("supersedes is null when the record supersedes nothing", () => {
    expect(buildTrustBlock({ agentId: "a" }, NOW).supersedes).toBeNull();
  });
});

describe("buildTrustBlock — tier is DEFERRED (flair#744 Sherlock condition 1)", () => {
  it("the block never carries a `tier` field", () => {
    const b = buildTrustBlock(
      { agentId: "a", provenance: prov({ v: 1, verified: { agentId: "a", timestamp: "2026-07-01T00:00:00.000Z" } }) },
      NOW,
    );
    expect("tier" in b).toBe(false);
  });
});

describe("buildTrustBlock — purity (never mutates the input)", () => {
  it("does not add or change any field on the source record", () => {
    const record = {
      agentId: "agt_alice",
      provenance: prov({ v: 1, verified: { agentId: "agt_alice", timestamp: "2026-07-01T00:00:00.000Z" } }),
      usageCount: 2,
      validFrom: "2026-07-01T00:00:00.000Z",
      validTo: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      supersedes: null,
    };
    const snapshot = JSON.stringify(record);
    buildTrustBlock(record, NOW);
    expect(JSON.stringify(record)).toBe(snapshot);
    expect("trust" in record).toBe(false);
  });
});

describe("classifyMatchQuality — confidence bands (flair#744 refinement)", () => {
  it("strong: sim >= STRONG_BAND", () => {
    expect(classifyMatchQuality(STRONG_BAND)).toBe("strong"); // exact boundary (>=)
    expect(classifyMatchQuality(0.62)).toBe("strong");
    expect(classifyMatchQuality(1.0)).toBe("strong");
  });

  it("moderate: MODERATE_BAND <= sim < STRONG_BAND", () => {
    expect(classifyMatchQuality(MODERATE_BAND)).toBe("moderate"); // exact lower boundary (>=)
    expect(classifyMatchQuality(0.45)).toBe("moderate");
    // Just below the strong floor is still moderate (< is exclusive).
    expect(classifyMatchQuality(STRONG_BAND - 1e-9)).toBe("moderate");
  });

  it("breadcrumb: ABSTENTION_THRESHOLD <= sim < MODERATE_BAND", () => {
    expect(classifyMatchQuality(ABSTENTION_THRESHOLD)).toBe("breadcrumb"); // exact floor (>=)
    expect(classifyMatchQuality(0.25)).toBe("breadcrumb");
    // Just below the moderate floor is still breadcrumb (< is exclusive).
    expect(classifyMatchQuality(MODERATE_BAND - 1e-9)).toBe("breadcrumb");
  });

  it("breadcrumb: a result present BELOW the abstention floor is still the weakest present band (NO 4th band)", () => {
    // Abstention off (or a straggler): a present sub-floor result is labeled the
    // weakest present band, never a distinct 4th band.
    expect(classifyMatchQuality(ABSTENTION_THRESHOLD - 1e-9)).toBe("breadcrumb");
    expect(classifyMatchQuality(0.05)).toBe("breadcrumb");
    expect(classifyMatchQuality(0)).toBe("breadcrumb");
  });

  it("null: no similarity signal to judge ⇒ null, NOT a false label", () => {
    expect(classifyMatchQuality(null)).toBeNull();
    expect(classifyMatchQuality(undefined)).toBeNull();
    expect(classifyMatchQuality(Number.NaN)).toBeNull();
    expect(classifyMatchQuality(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("takes exactly ONE numeric input (global, never per-principal)", () => {
    // Arity 1: there is no principal/tier parameter the band could branch on —
    // the band is a pure function of the similarity number (Sherlock spine).
    expect(classifyMatchQuality.length).toBe(1);
  });
});

describe("classifyMatchQuality — breadcrumb floor IS ABSTENTION_THRESHOLD (Kern BINDING condition 1)", () => {
  it("the breadcrumb band's floor is the SAME shared ABSTENTION_THRESHOLD constant — not a duplicate literal", () => {
    // The bottom of breadcrumb is exactly the top of abstention: a result AT the
    // abstention floor is a breadcrumb, and the value just below it is the point
    // opt-in abstention would fire. Because classifyMatchQuality references the
    // imported ABSTENTION_THRESHOLD (single source of truth), if recall-bench
    // moves that floor this band boundary moves with it — this test tracks the
    // constant, not a hard-coded 0.15, so it stays true after any recalibration.
    expect(classifyMatchQuality(ABSTENTION_THRESHOLD)).toBe("breadcrumb");
    // The whole breadcrumb band [ABSTENTION_THRESHOLD, MODERATE_BAND) classifies
    // as breadcrumb, anchored on the shared constants (not literals).
    const mid = (ABSTENTION_THRESHOLD + MODERATE_BAND) / 2;
    expect(classifyMatchQuality(mid)).toBe("breadcrumb");
  });

  it("the band cut-points are ordered and finite (ABSTENTION_THRESHOLD < MODERATE_BAND < STRONG_BAND)", () => {
    expect(Number.isFinite(ABSTENTION_THRESHOLD)).toBe(true);
    expect(Number.isFinite(MODERATE_BAND)).toBe(true);
    expect(Number.isFinite(STRONG_BAND)).toBe(true);
    expect(ABSTENTION_THRESHOLD).toBeLessThan(MODERATE_BAND);
    expect(MODERATE_BAND).toBeLessThan(STRONG_BAND);
  });
});

describe("buildTrustBlock — matchQuality (flair#744 refinement)", () => {
  it("classifies the record's `_semSimilarity` into a band", () => {
    expect(buildTrustBlock({ agentId: "a", _semSimilarity: 0.7 }, NOW).matchQuality).toBe("strong");
    expect(buildTrustBlock({ agentId: "a", _semSimilarity: 0.4 }, NOW).matchQuality).toBe("moderate");
    expect(buildTrustBlock({ agentId: "a", _semSimilarity: 0.2 }, NOW).matchQuality).toBe("breadcrumb");
  });

  it("matchQuality is null when the record carries no `_semSimilarity` (by-id get / keyword-only)", () => {
    expect(buildTrustBlock({ agentId: "a" }, NOW).matchQuality).toBeNull();
    expect(buildTrustBlock({ agentId: "a", _semSimilarity: null }, NOW).matchQuality).toBeNull();
  });

  it("does NOT surface the raw `_semSimilarity` number — only its band classification", () => {
    const b = buildTrustBlock({ agentId: "a", _semSimilarity: 0.42 }, NOW);
    expect(b.matchQuality).toBe("moderate");
    expect((b as any)._semSimilarity).toBeUndefined();
    expect(JSON.stringify(b)).not.toContain("0.42");
  });
});

describe("attachTrust — opt-in wrapper", () => {
  const record = { id: "m1", agentId: "agt_alice", content: "hi", usageCount: 4, createdAt: "2026-07-01T00:00:00.000Z" };

  it("OFF ⇒ returns the EXACT same reference (byte-identical, no block)", () => {
    const out = attachTrust(record, false, NOW);
    expect(out).toBe(record);
    expect("trust" in out).toBe(false);
  });

  it("ON ⇒ additive copy carrying the block; original untouched", () => {
    const out: any = attachTrust(record, true, NOW);
    expect(out).not.toBe(record);
    expect(out.trust).toBeDefined();
    expect(out.trust.author).toBe("agt_alice");
    expect(out.trust.usageCount).toBe(4);
    // Non-trust fields are carried through unchanged.
    expect(out.id).toBe("m1");
    expect(out.content).toBe("hi");
    // Original record is not mutated.
    expect("trust" in record).toBe(false);
  });

  it("ON ⇒ the block carries matchQuality classified from the record's `_semSimilarity`", () => {
    const withSim = { id: "m2", agentId: "agt_alice", content: "hi", _semSimilarity: 0.62 };
    const out: any = attachTrust(withSim, true, NOW);
    expect(out.trust.matchQuality).toBe("strong");
    // The raw internal signal is not surfaced in the block.
    expect(out.trust._semSimilarity).toBeUndefined();
  });

  it("ON ⇒ matchQuality is null when the record has no `_semSimilarity` (by-id get)", () => {
    const out: any = attachTrust(record, true, NOW);
    expect(out.trust.matchQuality).toBeNull();
  });
});
