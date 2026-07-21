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
import { buildTrustBlock, attachTrust } from "../../resources/trust-block.ts";

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

describe("buildTrustBlock — usage signal", () => {
  it("maps usageCount", () => {
    expect(buildTrustBlock({ agentId: "a", usageCount: 7 }, NOW).usageCount).toBe(7);
  });
  it("absent usageCount reads as 0", () => {
    expect(buildTrustBlock({ agentId: "a" }, NOW).usageCount).toBe(0);
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
});
