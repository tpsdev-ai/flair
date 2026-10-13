/**
 * embedding-space-doctor.test.ts — the flair doctor finding for the
 * query-time embedding-space guard's verdict (flair#2530).
 *
 * The guard reports `embeddingSpace: { state, reason }` on /Health; this drives
 * the pure decision for the four states and the doctor rendering/issue weight
 * the action uses (the same extraction convention as embed-gpu-doctor.test.ts).
 */
import { describe, expect, test } from "bun:test";
import {
  boundedScanFailureReason,
  describeEmbeddingSpaceDoctorFinding,
} from "../../src/lib/embedding-space-doctor.ts";
import { renderEmbeddingSpaceDoctorFinding } from "../../src/commands/doctor.ts";

describe("describeEmbeddingSpaceDoctorFinding (flair#2530)", () => {
  test("uniform: an OK line, not an issue", () => {
    expect(describeEmbeddingSpaceDoctorFinding({ state: "uniform", reason: null })).toEqual({
      isIssue: false,
      icon: "ok",
      message: "embedding space verified uniform",
    });
  });

  test("mixed: a blocking finding carrying the reembed remedy", () => {
    const f = describeEmbeddingSpaceDoctorFinding({ state: "mixed", reason: null });
    expect(f?.isIssue).toBe(true);
    expect(f?.icon).toBe("error");
    expect(String(f?.fixHint)).toContain("flair reembed --stale-only");
  });

  test("unverified: an advisory naming the not-yet-verified state", () => {
    const f = describeEmbeddingSpaceDoctorFinding({ state: "unverified", reason: null });
    expect(f?.isIssue).toBe(false);
    expect(f?.icon).toBe("warn");
    expect(String(f?.message)).toContain("not yet verified");
  });

  test("scan-failed: an advisory naming the bounded reason", () => {
    const f = describeEmbeddingSpaceDoctorFinding({ state: "scan-failed", reason: "the Memory corpus scan failed" });
    expect(f?.isIssue).toBe(false);
    expect(f?.icon).toBe("warn");
    expect(String(f?.message)).toContain("last scan failed (the Memory corpus scan failed)");
  });

  test("an absent or unrecognized field prints nothing", () => {
    expect(describeEmbeddingSpaceDoctorFinding(undefined)).toBeNull();
    expect(describeEmbeddingSpaceDoctorFinding(null)).toBeNull();
    expect(describeEmbeddingSpaceDoctorFinding({})).toBeNull();
    expect(describeEmbeddingSpaceDoctorFinding({ state: "something-else" })).toBeNull();
  });

  test("boundedScanFailureReason bounds an over-long or control-character reason", () => {
    expect(boundedScanFailureReason("x".repeat(200))).toBe("unspecified");
    expect(boundedScanFailureReason("bad\u0000text")).toBe("unspecified");
    expect(boundedScanFailureReason(undefined)).toBe("unspecified");
    expect(boundedScanFailureReason("short reason")).toBe("short reason");
  });
});

describe("renderEmbeddingSpaceDoctorFinding (flair#2530)", () => {
  test("only a mixed store weighs on the issue count", () => {
    const mixed: string[] = [];
    expect(renderEmbeddingSpaceDoctorFinding({ state: "mixed" }, (l) => mixed.push(l)).issueDelta).toBe(1);
    expect(mixed.some((l) => l.includes("Fix:"))).toBe(true);

    for (const state of ["uniform", "unverified", "scan-failed"]) {
      const lines: string[] = [];
      const r = renderEmbeddingSpaceDoctorFinding({ state, reason: "the Memory corpus scan failed" }, (l) => lines.push(l));
      expect(r.issueDelta).toBe(0);
      expect(lines.length).toBeGreaterThan(0);
    }
  });

  test("an absent field renders nothing", () => {
    const lines: string[] = [];
    expect(renderEmbeddingSpaceDoctorFinding(undefined, (l) => lines.push(l))).toEqual({ lines: [], issueDelta: 0 });
    expect(lines).toEqual([]);
  });
});
