/**
 * cli-rem-promote-reject.test.ts — Unit tests for the FLAIR-NIGHTLY-REM
 * slice 2 promote/reject CLI helpers (ops-2qq).
 *
 * Tests the pure validators + decideCandidateAction. The action callbacks
 * themselves spawn process.exit and call api() — those side effects make
 * direct callback testing high-effort low-value. The helpers are the
 * contract; the callbacks thread them.
 */

import { describe, test, expect } from "bun:test";
import {
  validatePromoteOpts,
  validateRejectOpts,
  decideCandidateAction,
  derivePromotedTags,
  isMachineReviewerId,
  validateHumanReviewerId,
  MACHINE_REVIEWER_PREFIX,
  MACHINE_REVIEWER_ADK_AUTO_PROMOTE,
  type SourceMemoryFetch,
} from "../../src/cli.ts";

describe("validatePromoteOpts", () => {
  test("accepts a fully-specified memory promotion", () => {
    expect(validatePromoteOpts({ rationale: "matches existing rule", to: "memory" })).toBeNull();
  });

  test("accepts a fully-specified soul promotion with key", () => {
    expect(validatePromoteOpts({ rationale: "concrete behavioral guardrail", to: "soul", key: "no-secrets" })).toBeNull();
  });

  test("rejects missing rationale", () => {
    expect(validatePromoteOpts({ to: "memory" })).toMatch(/--rationale is required/);
  });

  test("rejects whitespace-only rationale", () => {
    expect(validatePromoteOpts({ rationale: "   ", to: "memory" })).toMatch(/--rationale is required/);
  });

  test("rejects missing target", () => {
    expect(validatePromoteOpts({ rationale: "x" })).toMatch(/--to must be 'soul' or 'memory'/);
  });

  test("rejects invalid target", () => {
    expect(validatePromoteOpts({ rationale: "x", to: "graphql" as any })).toMatch(/--to must be 'soul' or 'memory'/);
  });

  test("requires --key when --to=soul", () => {
    expect(validatePromoteOpts({ rationale: "x", to: "soul" })).toMatch(/--key is required when --to=soul/);
  });

  test("rejects whitespace-only --key for soul", () => {
    expect(validatePromoteOpts({ rationale: "x", to: "soul", key: "  " })).toMatch(/--key is required when --to=soul/);
  });

  test("does NOT require --key when --to=memory", () => {
    expect(validatePromoteOpts({ rationale: "x", to: "memory" })).toBeNull();
    expect(validatePromoteOpts({ rationale: "x", to: "memory", key: undefined })).toBeNull();
  });
});

describe("validateRejectOpts", () => {
  test("accepts a non-empty reason", () => {
    expect(validateRejectOpts({ reason: "low-signal duplicate" })).toBeNull();
  });

  test("rejects missing reason", () => {
    expect(validateRejectOpts({})).toMatch(/--reason is required/);
  });

  test("rejects empty-string reason", () => {
    expect(validateRejectOpts({ reason: "" })).toMatch(/--reason is required/);
  });

  test("rejects whitespace-only reason", () => {
    expect(validateRejectOpts({ reason: "  \t\n" })).toMatch(/--reason is required/);
  });
});

describe("decideCandidateAction", () => {
  test("ok for a pending candidate being promoted", () => {
    const r = decideCandidateAction({ status: "pending" }, "promote");
    expect(r.ok).toBe(true);
  });

  test("ok for a pending candidate being rejected", () => {
    const r = decideCandidateAction({ status: "pending" }, "reject");
    expect(r.ok).toBe(true);
  });

  test("error for a null candidate (not found)", () => {
    const r = decideCandidateAction(null, "promote") as any;
    expect(r.ok).toBe(false);
    expect(r.severity).toBe("error");
    expect(r.message).toMatch(/not found/);
  });

  test("error for promoting an already-promoted candidate", () => {
    const r = decideCandidateAction({ status: "promoted", target: "soul", reviewerId: "flint" }, "promote") as any;
    expect(r.ok).toBe(false);
    expect(r.severity).toBe("error");
    expect(r.message).toMatch(/already promoted/);
    expect(r.message).toMatch(/target=soul/);
    expect(r.message).toMatch(/reviewer=flint/);
  });

  test("error for rejecting an already-promoted candidate", () => {
    const r = decideCandidateAction({ status: "promoted" }, "reject") as any;
    expect(r.ok).toBe(false);
    expect(r.severity).toBe("error");
    expect(r.message).toMatch(/cannot reject after promotion/);
  });

  test("error for promoting an already-rejected candidate", () => {
    const r = decideCandidateAction({ status: "rejected" }, "promote") as any;
    expect(r.ok).toBe(false);
    expect(r.severity).toBe("error");
    expect(r.message).toMatch(/already rejected/);
  });

  test("INFO (idempotent) for rejecting an already-rejected candidate", () => {
    const r = decideCandidateAction({ status: "rejected", decidedAt: "2026-05-03T12:00:00Z", reviewerId: "flint" }, "reject") as any;
    expect(r.ok).toBe(false);
    expect(r.severity).toBe("info");
    expect(r.message).toMatch(/already rejected on 2026-05-03/);
    expect(r.message).toMatch(/by flint/);
  });
});

// ─── ADK tag-lineage on promote (#1205a) ─────────────────────────────────────

const ADK_TAG = "adk:myapp:alice%3Aadmin"; // an escaped compound scope tag
const OTHER_ADK_TAG = "adk:myapp:bob";

describe("derivePromotedTags", () => {
  test("NON-ADK candidate (readable sources, no adk tag) → provenance only, unchanged", () => {
    // Positive control: this MUST match the historical hard-coded tag set so
    // non-ADK promotion is byte-for-byte unchanged.
    const sources: SourceMemoryFetch[] = [
      { ok: true, tags: ["episodic", "topic:infra"] },
      { ok: true, tags: [] },
    ];
    const r = derivePromotedTags("cand_1", sources);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.adkSourced).toBe(false);
    expect(r.tags).toEqual(["nightly-rem-promoted", "from:cand_1"]);
  });

  test("NON-ADK candidate with an unreadable source (no adk evidence) → still promotes, unchanged", () => {
    // A transient/deleted source on a non-ADK candidate must NOT fail closed.
    const sources: SourceMemoryFetch[] = [
      { ok: true, tags: ["episodic"] },
      { ok: false },
    ];
    const r = derivePromotedTags("cand_2", sources);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.adkSourced).toBe(false);
    expect(r.tags).toEqual(["nightly-rem-promoted", "from:cand_2"]);
  });

  test("candidate with NO sources → non-ADK, provenance only", () => {
    const r = derivePromotedTags("cand_3", []);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.adkSourced).toBe(false);
    expect(r.tags).toEqual(["nightly-rem-promoted", "from:cand_3"]);
  });

  test("ADK-sourced (single tag, all readable) → propagates scope tag ALONGSIDE provenance", () => {
    const sources: SourceMemoryFetch[] = [
      { ok: true, tags: [ADK_TAG, "episodic"] },
      { ok: true, tags: [ADK_TAG] },
    ];
    const r = derivePromotedTags("cand_4", sources);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.adkSourced).toBe(true);
    expect(r.tags).toEqual([ADK_TAG, "nightly-rem-promoted", "from:cand_4"]);
    // provenance tags are retained (added to, not replaced by, the scope tag):
    expect(r.tags).toContain("nightly-rem-promoted");
    expect(r.tags).toContain("from:cand_4");
  });

  test("ADK-sourced but a source is UNREADABLE → FAIL CLOSED", () => {
    const sources: SourceMemoryFetch[] = [
      { ok: true, tags: [ADK_TAG] },
      { ok: false }, // could carry a different scope tag — cannot confirm
    ];
    const r = derivePromotedTags("cand_5", sources);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/unreadable|fail-closed/i);
  });

  test("ADK-sourced spanning MULTIPLE distinct scope tags → FAIL CLOSED", () => {
    const sources: SourceMemoryFetch[] = [
      { ok: true, tags: [ADK_TAG] },
      { ok: true, tags: [OTHER_ADK_TAG] },
    ];
    const r = derivePromotedTags("cand_6", sources);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toMatch(/multiple scope tags/i);
    expect(r.reason).toContain(ADK_TAG);
    expect(r.reason).toContain(OTHER_ADK_TAG);
  });
});

// ─── Machine reviewer namespace (#1205a, Sherlock #4) ────────────────────────

describe("isMachineReviewerId / machine reviewer namespace", () => {
  test("the canonical machine reviewerId is in the reserved namespace and distinguishable", () => {
    expect(MACHINE_REVIEWER_ADK_AUTO_PROMOTE.startsWith(MACHINE_REVIEWER_PREFIX)).toBe(true);
    expect(isMachineReviewerId(MACHINE_REVIEWER_ADK_AUTO_PROMOTE)).toBe(true);
  });

  test("machine ids are recognized; human/agent ids are not", () => {
    expect(isMachineReviewerId("machine:adk-auto-promote")).toBe(true);
    expect(isMachineReviewerId("machine:anything")).toBe(true);
    expect(isMachineReviewerId("admin")).toBe(false);
    expect(isMachineReviewerId("flint")).toBe(false);
    expect(isMachineReviewerId("adk:app:user")).toBe(false); // not a reviewer namespace
    expect(isMachineReviewerId("")).toBe(false);
    expect(isMachineReviewerId(undefined)).toBe(false);
    expect(isMachineReviewerId(null)).toBe(false);
  });
});

describe("validateHumanReviewerId", () => {
  test("allows a human/agent reviewer id", () => {
    expect(validateHumanReviewerId("admin")).toBeNull();
    expect(validateHumanReviewerId("flint")).toBeNull();
  });

  test("rejects a human --reviewer that claims the reserved machine namespace", () => {
    const err = validateHumanReviewerId(MACHINE_REVIEWER_ADK_AUTO_PROMOTE);
    expect(err).not.toBeNull();
    expect(err).toMatch(/reserved/);
    expect(err).toContain(MACHINE_REVIEWER_PREFIX);
  });
});
