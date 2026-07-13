/**
 * cli-rem-rapid.test.ts — Unit tests for the `flair rem rapid` execute-mode
 * flip (specs/FLAIR-NIGHTLY-REM-SLICE-2-DISTILLATION.md § 3C, issue #707).
 *
 * Tests the pure helpers formatCandidateLine + describeReflectError. Same
 * pattern as cli-rem-promote-reject.test.ts: the action callback itself
 * spawns api() + process.exit, which makes it high-effort/low-value to
 * drive directly (no CLI harness that mocks fetch/commander exists for the
 * rem subcommands — this repo's convention is to extract the decision logic
 * into pure, exported functions instead of inventing one). These two
 * functions are the actual contract: formatCandidateLine is the
 * staged-candidate summary line format (§ 3C item 1: "per-candidate claim
 * first ~80 chars + id"); describeReflectError is the 503-vs-502 error UX
 * classification (§ 3C item 3).
 */

import { describe, test, expect } from "bun:test";
import { formatCandidateLine, describeReflectError } from "../../src/cli.ts";

describe("formatCandidateLine", () => {
  test("renders id + claim for a short claim", () => {
    expect(formatCandidateLine({ id: "cand_abc", claim: "short claim" })).toBe("  [cand_abc] short claim");
  });

  test("truncates a claim longer than 80 chars with an ellipsis", () => {
    const claim = "x".repeat(120);
    const line = formatCandidateLine({ id: "cand_abc", claim });
    expect(line).toBe(`  [cand_abc] ${"x".repeat(80)}…`);
    expect(line.length).toBeLessThan(claim.length + 20);
  });

  test("does not truncate a claim exactly at the limit", () => {
    const claim = "x".repeat(80);
    const line = formatCandidateLine({ id: "cand_abc", claim });
    expect(line).toBe(`  [cand_abc] ${claim}`);
    expect(line).not.toContain("…");
  });

  test("respects a custom maxClaimLen", () => {
    const line = formatCandidateLine({ id: "c1", claim: "0123456789" }, 5);
    expect(line).toBe("  [c1] 01234…");
  });

  test("falls back to '?' for a missing id", () => {
    expect(formatCandidateLine({ claim: "orphan" })).toBe("  [?] orphan");
  });

  test("handles a missing claim as an empty string", () => {
    expect(formatCandidateLine({ id: "c1" })).toBe("  [c1] ");
  });
});

describe("describeReflectError", () => {
  test("classifies the 503 no-backend body", () => {
    const body = JSON.stringify({ error: "No generative backend configured. See the models configuration docs." });
    const r = describeReflectError(body);
    expect(r.kind).toBe("no-backend");
    expect(r.text).toBe("No generative backend configured. See the models configuration docs.");
  });

  test("classifies the 502 distillation_failed body, surfacing detail", () => {
    const body = JSON.stringify({ error: "distillation_failed", detail: "model output did not validate after one retry" });
    const r = describeReflectError(body);
    expect(r.kind).toBe("distillation-failed");
    expect(r.text).toBe("model output did not validate after one retry");
  });

  test("falls back to the error string when distillation_failed has no detail", () => {
    const body = JSON.stringify({ error: "distillation_failed" });
    const r = describeReflectError(body);
    expect(r.kind).toBe("distillation-failed");
    expect(r.text).toBe("distillation_failed");
  });

  test("treats an unrelated structured error (e.g. actor-resolution 400/403) as 'other'", () => {
    const body = JSON.stringify({ error: "forbidden: can only reflect on own memories" });
    const r = describeReflectError(body);
    expect(r.kind).toBe("other");
    expect(r.text).toBe("forbidden: can only reflect on own memories");
  });

  test("falls back to the raw message for a non-JSON error (network failure)", () => {
    const r = describeReflectError("fetch failed: connection reset");
    expect(r.kind).toBe("other");
    expect(r.text).toBe("fetch failed: connection reset");
  });

  test("falls back to 'other' for a JSON body with no error field", () => {
    const r = describeReflectError(JSON.stringify({ status: "weird" }));
    expect(r.kind).toBe("other");
  });
});
