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
import { validatePromoteOpts, validateRejectOpts, decideCandidateAction } from "../../src/cli.ts";

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
