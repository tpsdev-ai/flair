import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EMBED_GPU_FALLBACK_MSG } from "../../resources/embed-gpu.ts";
import {
  EMBED_GPU_DOCTOR_MARKER,
  describeEmbedGpuDoctorFinding,
} from "../../src/lib/embed-gpu-doctor.ts";

/**
 * flair#1437 PLAN ACCEPTED condition (1): the fail-loud Metal fallback must
 * surface as a `flair doctor` line. Health alone is not what an operator reads.
 */
describe("describeEmbedGpuDoctorFinding (flair#1437 — doctor line)", () => {
  it("the server fallback sentence carries the doctor marker", () => {
    expect(EMBED_GPU_FALLBACK_MSG).toContain(EMBED_GPU_DOCTOR_MARKER);
    expect(EMBED_GPU_DOCTOR_MARKER).toBe("requested GPU offload; Metal did not engage");
  });

  it("Health embedding.fallback → doctor finding with the required sentence", () => {
    const finding = describeEmbedGpuDoctorFinding({
      backend: "cpu",
      gpuLayers: 0,
      source: "env",
      fallback: EMBED_GPU_FALLBACK_MSG,
    });
    expect(finding).not.toBeNull();
    expect(finding!.isIssue).toBe(true);
    expect(finding!.icon).toBe("error");
    expect(finding!.message).toContain("requested GPU offload; Metal did not engage");
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

describe("flair doctor plumbing (flair#1437)", () => {
  it("doctor.ts prints describeEmbedGpuDoctorFinding — Health alone is not enough", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "commands", "doctor.ts"),
      "utf8",
    );
    expect(src).toContain("describeEmbedGpuDoctorFinding");
    expect(src).toContain("embedding");
  });
});
