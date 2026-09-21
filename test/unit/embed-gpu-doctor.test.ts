import { describe, it, expect } from "bun:test";

import { EMBED_GPU_FALLBACK_MSG } from "../../resources/embed-gpu.ts";
import {
  EMBED_GPU_DOCTOR_MARKER,
  EMBED_GPU_DETECTED_MESSAGE,
  describeEmbedGpuDoctorFinding,
} from "../../src/lib/embed-gpu-doctor.ts";
import {
  renderEmbedGpuDoctorFinding,
  summarizeDoctorRun,
} from "../../src/commands/doctor.ts";

/**
 * flair#1761 — the Metal-default doctor finding was a blocking `✗` on every
 * darwin-arm64 host where the package resolved but the log heuristic did not
 * confirm Metal. The fix reads `source` off the very Health embedding object
 * the action already passes in:
 *
 *   source === "detected"        → advisory warning, does NOT count as issue
 *   source === "env"             → blocking error
 *   missing / unrecognized source→ blocking error (FAIL CLOSED)
 *
 * The severity lives on the finding (`isIssue`, `icon`); the caller
 * (doctor.ts) renders that icon and only adds to the issue count when
 * `isIssue` is true. These tests drive the REAL doctor rendering/counting
 * path — renderEmbedGpuDoctorFinding (what the action calls) plus
 * summarizeDoctorRun (the real exit-code decision) — with controlled Health
 * responses, rather than greping source text or testing the lib in
 * isolation. A lib-only test would miss the caller defect this pins: the old
 * action printed an unconditional `✗` and incremented the count.
 *
 * The full action callback cannot be driven in-process (Harper probes,
 * network registry reads, console side effects, process.exit — see
 * doctor-summary.test.ts), so the render/count decision is extracted and the
 * action calls the same function the tests do.
 */

/** Sentinel: "the Health embedding has no `source` field at all". */
const NO_SOURCE = Symbol("absent-source");

/** A controlled /Health `embedding` field, exactly as the action reads it. */
function healthEmbedding(source: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = {
    backend: "cpu",
    gpuLayers: 0,
    fallback: EMBED_GPU_FALLBACK_MSG,
  };
  // Omitting `source` entirely is itself a case under test (fail closed), so
  // only attach the key when a caller passed one — `source: undefined` would
  // still be "present" to a `"source" in embedding` check, and this mirrors
  // an old server that never wrote the field.
  if (source !== NO_SOURCE) base.source = source;
  return base;
}

/** Render through the real doctor seam and capture the emitted lines. */
function doctorLines(embedding: unknown): { lines: string[]; issueDelta: number } {
  const lines: string[] = [];
  const result = renderEmbedGpuDoctorFinding(embedding, (line) => {
    lines.push(line);
  });
  expect(result.lines).toEqual(lines);
  return result;
}

/** The real exit-code decision, given how many findings the run counted. */
function doctorExit(issueCount: number): number {
  return summarizeDoctorRun(issueCount, 0, false).exitCode;
}

describe("describeEmbedGpuDoctorFinding (flair#1437 — doctor line)", () => {
  it("the server fallback sentence carries the doctor marker", () => {
    expect(EMBED_GPU_FALLBACK_MSG).toContain(EMBED_GPU_DOCTOR_MARKER);
    expect(EMBED_GPU_DOCTOR_MARKER).toBe("requested GPU offload; Metal did not engage");
  });

  it("explicit request (source=env) → blocking error finding", () => {
    const finding = describeEmbedGpuDoctorFinding(healthEmbedding("env"));
    expect(finding).not.toBeNull();
    expect(finding!.isIssue).toBe(true);
    expect(finding!.icon).toBe("error");
    expect(finding!.message).toBe(EMBED_GPU_FALLBACK_MSG);
  });

  it("CPU default (no fallback) is silent — not a doctor issue", () => {
    expect(describeEmbedGpuDoctorFinding({
      backend: "cpu",
      gpuLayers: 0,
      source: "default",
    })).toBeNull();
  });

  it("Metal engaged (no fallback) is silent", () => {
    expect(describeEmbedGpuDoctorFinding({
      backend: "metal",
      gpuLayers: 99,
      source: "detected",
    })).toBeNull();
  });

  it("env CPU pin (source=env, no fallback) is silent", () => {
    expect(describeEmbedGpuDoctorFinding({
      backend: "cpu",
      gpuLayers: 0,
      source: "env",
    })).toBeNull();
  });

  it("missing / malformed Health embedding is silent (old server)", () => {
    expect(describeEmbedGpuDoctorFinding(undefined)).toBeNull();
    expect(describeEmbedGpuDoctorFinding(null)).toBeNull();
    expect(describeEmbedGpuDoctorFinding("not-an-object")).toBeNull();
    expect(describeEmbedGpuDoctorFinding({ fallback: 99 })).toBeNull();
    expect(describeEmbedGpuDoctorFinding({ fallback: "" })).toBeNull();
  });
});

describe("doctor render/count/exit path with controlled Health (flair#1761)", () => {
  it("derived default (source=detected) → warning, no issue, doctor exits 0", () => {
    const { lines, issueDelta } = doctorLines(healthEmbedding("detected"));
    const rendered = lines.join("\n");

    // Advisory icon, not the blocking ✗.
    expect(lines[0]).toContain("⚠");
    expect(lines[0]).not.toContain("✗");
    // The exact adjudicated wording — and NOT the over-claim.
    expect(lines[0]).toContain(EMBED_GPU_DETECTED_MESSAGE);
    expect(rendered).not.toContain("did not engage");
    // The diagnostic remedy is preserved (CPU pin), and reinstalling an
    // already-resolvable package is NOT presented as the remedy.
    expect(rendered).toContain("FLAIR_EMBED_GPU_LAYERS=0");
    expect(rendered).not.toContain("@node-llama-cpp/mac-arm64-metal");

    expect(issueDelta).toBe(0);
    expect(doctorExit(issueDelta)).toBe(0);
  });

  it("explicit request (source=env) → error, counts as issue, doctor exits 1", () => {
    const { lines, issueDelta } = doctorLines(healthEmbedding("env"));
    const rendered = lines.join("\n");

    expect(lines[0]).toContain("✗");
    expect(lines[0]).not.toContain("⚠");
    // Diagnostic text preserved verbatim for the operator who asked.
    expect(rendered).toContain(EMBED_GPU_FALLBACK_MSG);

    expect(issueDelta).toBe(1);
    expect(doctorExit(issueDelta)).toBe(1);
  });

  it("missing source → error, counts as issue, doctor exits 1 (FAIL CLOSED)", () => {
    const { lines, issueDelta } = doctorLines(healthEmbedding(NO_SOURCE));
    expect(lines[0]).toContain("✗");
    expect(lines.join("\n")).toContain(EMBED_GPU_FALLBACK_MSG);
    expect(issueDelta).toBe(1);
    expect(doctorExit(issueDelta)).toBe(1);
  });

  it("unrecognized source → error, counts as issue, doctor exits 1 (FAIL CLOSED)", () => {
    const { lines, issueDelta } = doctorLines(healthEmbedding("something-new"));
    expect(lines[0]).toContain("✗");
    expect(lines.join("\n")).toContain(EMBED_GPU_FALLBACK_MSG);
    expect(issueDelta).toBe(1);
    expect(doctorExit(issueDelta)).toBe(1);
  });

  it("silent when there is no finding — nothing rendered, nothing counted", () => {
    const { lines, issueDelta } = doctorLines({ backend: "metal", gpuLayers: 99, source: "detected" });
    expect(lines).toEqual([]);
    expect(issueDelta).toBe(0);
    expect(doctorExit(issueDelta)).toBe(0);
  });

  it("the detected warning is PERSISTENT — it renders on every run, never once", () => {
    for (let run = 0; run < 3; run++) {
      const { lines, issueDelta } = doctorLines(healthEmbedding("detected"));
      expect(lines[0]).toContain(EMBED_GPU_DETECTED_MESSAGE);
      expect(issueDelta).toBe(0);
    }
  });

  it("an unrelated blocking finding still fails the run despite the advisory", () => {
    // The detected advisory contributes 0; an unrelated defect contributes 1.
    const advisory = doctorLines(healthEmbedding("detected")).issueDelta;
    const unrelatedBlockingFinding = 1; // e.g. keys dir missing — any real ✗
    const total = advisory + unrelatedBlockingFinding;

    expect(advisory).toBe(0);
    expect(doctorExit(total)).toBe(1);
    expect(summarizeDoctorRun(total, 0, false).line).toContain("1 issue found");
  });
});
