import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { EMBED_GPU_FALLBACK_MSG, EMBED_GPU_UNCONFIRMED_MSG } from "../../resources/embed-gpu.ts";
import {
  confirmMetalEngagement,
  applyEmbedGpuChoice,
  embedGpuStatusWarning,
  formatEmbedGpuLogLine,
  withEmbedGpuHealth,
  setEmbedGpuStatement,
  _resetEmbedGpuStatementForTests,
} from "../../resources/embed-gpu.ts";
import {
  EMBED_GPU_DETECTED_MESSAGE,
  EMBED_GPU_UNCONFIRMED_DOCTOR_MESSAGE,
  describeEmbedGpuDoctorFinding,
} from "../../src/lib/embed-gpu-doctor.ts";
import { renderEmbedGpuDoctorFinding } from "../../src/commands/doctor.ts";

/**
 * flair#2031 — Metal engagement is the engine's GPU type and offloaded layer
 * count, not a scrape of captured stdio. Three states:
 *   engaged (Metal, N layers) when readback says so
 *   not engaged (CPU) only when the engine says so
 *   unconfirmed when no readback is available — never backend cpu / gpuLayers 0
 *
 * The launchd regression: the engine is engaged, the capture is empty
 * (ggml wrote to fd 2), and status must not say "did not engage".
 */

const EMPTY_CAPTURE = "";
const METAL_LOG = [
  "ggml_metal_init: picking default device: Apple M4",
  "ggml_metal_init: use fusion = true",
  "sched_reserve: MTL0 compute buffer size = 120.02 MiB",
].join("\n");

/** HFE EmbeddingEngine's public surface — no gpu / gpuLayers getters. */
function hfeEngine() {
  return { modelIdentity: "nomic-embed-text", ensureReady() {} };
}

describe("engine readback states (flair#2031)", () => {
  it("readback Metal + 99 layers → engaged, no warning", () => {
    const r = confirmMetalEngagement({
      requestedGpuLayers: 99,
      metalUsable: true,
      source: "detected",
      warmupLog: EMPTY_CAPTURE,
      capturedLog: EMPTY_CAPTURE,
      engine: { gpu: "metal", gpuLayers: 99 },
    });
    expect(r.engaged).toBe(true);
    expect(r.statement).toEqual({ backend: "metal", gpuLayers: 99, source: "detected" });
    expect(r.statement.fallback).toBeUndefined();
    expect(formatEmbedGpuLogLine(r.statement)).not.toContain("did not engage");
    expect(embedGpuStatusWarning(r.statement)).toBeNull();
    expect(describeEmbedGpuDoctorFinding(r.statement)).toBeNull();
  });

  it("LlamaModel shape (llama.gpu + gpuLayers) is the same engaged readback", () => {
    const r = confirmMetalEngagement({
      requestedGpuLayers: 99,
      metalUsable: true,
      source: "detected",
      engine: { llama: { gpu: "metal" }, gpuLayers: 99 },
    });
    expect(r.statement).toEqual({ backend: "metal", gpuLayers: 99, source: "detected" });
  });

  it("binding getGpuType() + gpuLayers is the same engaged readback", () => {
    const r = confirmMetalEngagement({
      requestedGpuLayers: 99,
      metalUsable: true,
      source: "detected",
      engine: { getGpuType: () => "metal", gpuLayers: 99 },
    });
    expect(r.statement.backend).toBe("metal");
    expect(r.statement.gpuLayers).toBe(99);
  });

  it("readback CPU → not engaged, advisory for source=detected", () => {
    const r = confirmMetalEngagement({
      requestedGpuLayers: 99,
      metalUsable: true,
      source: "detected",
      // Markers in the capture must not override the engine.
      warmupLog: METAL_LOG,
      capturedLog: METAL_LOG,
      engine: { gpu: false, gpuLayers: 0 },
    });
    expect(r.engaged).toBe(false);
    expect(r.statement.backend).toBe("cpu");
    expect(r.statement.gpuLayers).toBe(0);
    expect(r.statement.fallback).toBe(EMBED_GPU_FALLBACK_MSG);
    expect(embedGpuStatusWarning(r.statement)).toBe(EMBED_GPU_FALLBACK_MSG);

    const finding = describeEmbedGpuDoctorFinding(r.statement);
    expect(finding).not.toBeNull();
    expect(finding!.isIssue).toBe(false);
    expect(finding!.icon).toBe("warn");
    expect(finding!.message).toBe(EMBED_GPU_DETECTED_MESSAGE);
    const rendered = renderEmbedGpuDoctorFinding(r.statement, () => {});
    expect(rendered.issueDelta).toBe(0);
    expect(rendered.lines.join("\n")).not.toContain("did not engage");
  });

  it("readback CPU via getGpuType() false ignores a Metal-looking capture", () => {
    const r = confirmMetalEngagement({
      requestedGpuLayers: 99,
      metalUsable: true,
      source: "env",
      warmupLog: METAL_LOG,
      engine: { getGpuType: () => false, gpuLayers: 99 },
    });
    expect(r.statement.backend).toBe("cpu");
    expect(r.statement.gpuLayers).toBe(0);
    expect(r.statement.fallback).toBe(EMBED_GPU_FALLBACK_MSG);
    const finding = describeEmbedGpuDoctorFinding(r.statement);
    expect(finding!.isIssue).toBe(true);
    expect(finding!.icon).toBe("error");
  });

  it("readback unavailable → unconfirmed; Health does not say cpu or gpuLayers 0", () => {
    _resetEmbedGpuStatementForTests();
    const r = confirmMetalEngagement({
      requestedGpuLayers: 99,
      metalUsable: true,
      source: "detected",
      warmupLog: EMPTY_CAPTURE,
      capturedLog: EMPTY_CAPTURE,
      engine: {},
    });
    expect(r.engaged).toBe(false);
    expect(r.statement.backend).toBe("unconfirmed");
    expect(r.statement.gpuLayers).toBeNull();
    expect(r.statement.gpuLayers).not.toBe(0);
    expect(r.statement.backend).not.toBe("cpu");
    expect(r.statement.fallback).toBeUndefined();
    expect(formatEmbedGpuLogLine(r.statement)).not.toContain("did not engage");
    expect(formatEmbedGpuLogLine(r.statement)).not.toContain("running CPU");
    expect(embedGpuStatusWarning(r.statement)).toBe(EMBED_GPU_UNCONFIRMED_MSG);

    setEmbedGpuStatement(r.statement);
    const body = withEmbedGpuHealth({ ok: true });
    expect(body.embedding.backend).toBe("unconfirmed");
    expect(body.embedding.backend).not.toBe("cpu");
    expect(body.embedding.gpuLayers).not.toBe(0);
    expect(body.embedding.gpuLayers).toBeNull();

    const finding = describeEmbedGpuDoctorFinding(body.embedding);
    expect(finding!.isIssue).toBe(false);
    expect(finding!.message).toBe(EMBED_GPU_DETECTED_MESSAGE);
    expect(finding!.message).not.toContain("did not engage");
    expect(finding!.message).not.toContain("running CPU");
  });

  it("Metal markers in the capture do not confirm engagement and do not invent CPU", () => {
    const r = confirmMetalEngagement({
      requestedGpuLayers: 99,
      metalUsable: true,
      source: "detected",
      warmupLog: METAL_LOG,
      capturedLog: METAL_LOG,
      engine: hfeEngine(),
      probeGpuType: () => undefined,
    });
    expect(r.statement.backend).toBe("unconfirmed");
    expect(r.statement.gpuLayers).toBeNull();
    expect(embedGpuStatusWarning(r.statement) ?? "").not.toContain("did not engage");
  });

  it("a throwing probe is unconfirmed, not CPU", () => {
    const r = confirmMetalEngagement({
      requestedGpuLayers: 99,
      metalUsable: true,
      source: "detected",
      engine: hfeEngine(),
      probeGpuType: () => {
        throw new Error("addon unavailable");
      },
    });
    expect(r.statement.backend).toBe("unconfirmed");
    expect(r.statement.gpuLayers).not.toBe(0);
  });
});

describe("launchd false negative (flair#2031)", () => {
  beforeEach(() => {
    _resetEmbedGpuStatementForTests();
  });
  afterEach(() => {
    _resetEmbedGpuStatementForTests();
  });

  it("engine engaged, empty capture — status does not say did not engage", () => {
    // ggml_metal_init went to fd 2. Node's capture is empty. The engine
    // (binding getGpuType after warmup) reports Metal and the model was
    // constructed with 99 layers.
    const statement = applyEmbedGpuChoice(
      { gpuLayers: 99, source: "detected", metalUsable: true },
      hfeEngine(),
      () => "metal",
    );
    expect(statement.backend).toBe("metal");
    expect(statement.gpuLayers).toBe(99);
    expect(statement.fallback).toBeUndefined();
    expect(formatEmbedGpuLogLine(statement)).toContain("GPU (Metal), 99 layers");
    expect(formatEmbedGpuLogLine(statement)).not.toContain("did not engage");

    const body = withEmbedGpuHealth({ ok: true });
    expect(body.embedding.backend).toBe("metal");
    expect(body.embedding.gpuLayers).toBe(99);
    // flair status prints HealthDetail warnings from this string.
    expect(embedGpuStatusWarning(body.embedding) ?? "").not.toContain("did not engage");
    expect(describeEmbedGpuDoctorFinding(body.embedding)).toBeNull();
  });

  it("engine fields win over a contradictory binding probe", () => {
    const r = confirmMetalEngagement({
      requestedGpuLayers: 99,
      metalUsable: true,
      source: "detected",
      warmupLog: EMPTY_CAPTURE,
      engine: { gpu: "metal", gpuLayers: 99 },
      probeGpuType: () => false,
    });
    expect(r.statement.backend).toBe("metal");
    expect(r.statement.gpuLayers).toBe(99);
    expect(embedGpuStatusWarning(r.statement)).toBeNull();
  });

  it("HFE probe CPU is not engaged even when the capture contains Metal markers", () => {
    const r = confirmMetalEngagement({
      requestedGpuLayers: 99,
      metalUsable: true,
      source: "detected",
      warmupLog: METAL_LOG,
      engine: hfeEngine(),
      probeGpuType: () => false,
    });
    expect(r.statement.backend).toBe("cpu");
    expect(r.statement.gpuLayers).toBe(0);
    expect(r.statement.fallback).toBe(EMBED_GPU_FALLBACK_MSG);
    expect(describeEmbedGpuDoctorFinding(r.statement)!.isIssue).toBe(false);
  });

  it("HFE probe missing is unconfirmed, including when the capture is empty", () => {
    const statement = applyEmbedGpuChoice(
      { gpuLayers: 99, source: "detected", metalUsable: true },
      hfeEngine(),
      () => undefined,
    );
    expect(statement.backend).toBe("unconfirmed");
    expect(statement.gpuLayers).toBeNull();
    const warning = embedGpuStatusWarning(statement) ?? "";
    expect(warning).not.toContain("did not engage");
    expect(warning).not.toContain("running CPU");
    const body = withEmbedGpuHealth({ ok: true });
    expect(body.embedding.backend).not.toBe("cpu");
    expect(body.embedding.gpuLayers).not.toBe(0);
  });
});

describe("doctor unconfirmed wording (flair#2031)", () => {
  it("detected unconfirmed stays advisory and does not say CPU", () => {
    const embedding = { backend: "unconfirmed", gpuLayers: null, source: "detected" };
    const rendered = renderEmbedGpuDoctorFinding(embedding, () => {});
    expect(rendered.issueDelta).toBe(0);
    expect(rendered.lines[0]).toContain(EMBED_GPU_DETECTED_MESSAGE);
    expect(rendered.lines.join("\n")).not.toContain("did not engage");
    expect(rendered.lines.join("\n")).not.toContain("running CPU");
  });

  it("env unconfirmed is blocking and does not claim CPU", () => {
    const embedding = { backend: "unconfirmed", gpuLayers: null, source: "env" };
    const finding = describeEmbedGpuDoctorFinding(embedding);
    expect(finding!.isIssue).toBe(true);
    expect(finding!.icon).toBe("error");
    expect(finding!.message).toBe(EMBED_GPU_UNCONFIRMED_DOCTOR_MESSAGE);
    expect(finding!.message).not.toContain("did not engage");
    expect(finding!.message).not.toContain("running CPU");
    const rendered = renderEmbedGpuDoctorFinding(embedding, () => {});
    expect(rendered.issueDelta).toBe(1);
  });
});
