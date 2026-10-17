/**
 * embedding-space-doctor.test.ts — the flair doctor finding for the
 * query-time embedding-space guard's verdict (flair#2530).
 *
 * The guard reports `embeddingSpace: { state, reason }` on /Health; this drives
 * the pure decision for the five states and the doctor rendering/issue weight
 * the action uses (the same extraction convention as embed-gpu-doctor.test.ts).
 */
import { describe, expect, test } from "bun:test";
import {
  boundedScanFailureReason,
  describeEmbeddingSpaceDoctorFinding,
} from "../../src/lib/embedding-space-doctor.ts";
import { renderEmbeddingSpaceDoctorFinding } from "../../src/commands/doctor.ts";
import { readFlairHealthBody } from "../../src/lib/doctor-run.ts";

describe("describeEmbeddingSpaceDoctorFinding (flair#2530)", () => {
  test("uniform: an OK line, not an issue", () => {
    expect(describeEmbeddingSpaceDoctorFinding({ state: "uniform", reason: null })).toEqual({
      isIssue: false,
      icon: "ok",
      message: "embedding model stamps verified uniform",
    });
  });

  test("excluded: a blocking finding naming the last published count (flair#2573)", () => {
    const f = describeEmbeddingSpaceDoctorFinding({ state: "excluded", reason: null, excluded: 3 });
    expect(f?.isIssue).toBe(true);
    expect(f?.icon).toBe("error");
    expect(String(f?.message)).toContain("the last scan found a stored vector with no trusted current-space stamp");
    expect(String(f?.message)).toContain("excluded from the vector leg: 3 row(s) with no trusted model stamp");
  });

  test("excluded: an absent or malformed count is never invented as zero", () => {
    const base = "the last scan found a stored vector with no trusted current-space stamp — the embedding leg is refused";
    expect(describeEmbeddingSpaceDoctorFinding({ state: "excluded", reason: null, excluded: null })?.message).toBe(base);
    expect(describeEmbeddingSpaceDoctorFinding({ state: "excluded", reason: null, excluded: -1 })?.message).toBe(base);
    expect(describeEmbeddingSpaceDoctorFinding({ state: "excluded", reason: null, excluded: "3" })?.message).toBe(base);
  });

  test("only excluded renders the last published count", () => {
    for (const state of ["uniform", "mixed", "unverified", "scan-failed"]) {
      const f = describeEmbeddingSpaceDoctorFinding({ state, reason: null, excluded: 3 });
      expect(f?.message).not.toContain("3 row(s)");
    }
  });

  test("mixed: a blocking finding carrying the reembed remedy", () => {
    const f = describeEmbeddingSpaceDoctorFinding({ state: "mixed", reason: null });
    expect(f?.isIssue).toBe(true);
    expect(f?.icon).toBe("error");
    expect(String(f?.fixHint)).toContain("flair reembed --stale-only");
  });

  test("mixed after a failed rescan: still blocking, and names the scan error", () => {
    const f = describeEmbeddingSpaceDoctorFinding({ state: "mixed", reason: "the Memory corpus scan failed" });
    expect(f?.isIssue).toBe(true);
    expect(String(f?.message)).toContain("non-current embedding model stamp was observed");
    expect(String(f?.message)).toContain("last scan failed (the Memory corpus scan failed)");
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
  test("the mixed and excluded states add a guard issue; the advisories do not", () => {
    const blocked: string[] = [];
    expect(renderEmbeddingSpaceDoctorFinding({ state: "mixed" }, (l) => blocked.push(l)).issueDelta).toBe(1);
    expect(blocked.some((l) => l.includes("Fix:"))).toBe(true);

    const excluded: string[] = [];
    expect(renderEmbeddingSpaceDoctorFinding({ state: "excluded", excluded: 1 }, (l) => excluded.push(l)).issueDelta).toBe(1);
    expect(excluded.some((l) => l.includes("Fix:"))).toBe(true);

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

describe("readFlairHealthBody (flair#2530)", () => {
  const flair503 = {
    ok: false,
    version: "0.61.0",
    buildCommit: null,
    searchReady: false,
    searchReadyReason: "memory table not queryable",
    capabilities: ["memory-reembed-patch"],
    embeddingSpace: { state: "unverified", reason: null },
  };

  test("a Flair readiness 503 is read, marked not ready, with its reason", () => {
    const r = readFlairHealthBody(503, flair503);
    expect(r?.notReady).toBe(true);
    expect(r?.notReadyReason).toBe("memory table not queryable");
    expect(r?.body.embeddingSpace).toEqual({ state: "unverified", reason: null });
  });

  test("a 2xx body is read and is never not-ready", () => {
    expect(readFlairHealthBody(200, { ok: true })).toEqual({ body: { ok: true }, notReady: false, notReadyReason: null });
  });

  test("a 503 without Flair's shape, or another status, is not read", () => {
    const { version: _v, ...noVersion } = flair503;
    const { capabilities: _c, ...noCapabilities } = flair503;
    expect(readFlairHealthBody(503, noVersion)).toBeNull();
    expect(readFlairHealthBody(503, noCapabilities)).toBeNull();
    expect(readFlairHealthBody(503, { ...flair503, ok: true })).toBeNull();
    expect(readFlairHealthBody(502, flair503)).toBeNull();
    expect(readFlairHealthBody(503, null)).toBeNull();
  });

  test("an unprintable reason is dropped, not printed", () => {
    expect(readFlairHealthBody(503, { ...flair503, searchReadyReason: "bad\u001btext" })?.notReadyReason).toBeNull();
    expect(readFlairHealthBody(503, { ...flair503, searchReadyReason: "x".repeat(201) })?.notReadyReason).toBeNull();
  });
});
