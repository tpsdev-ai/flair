import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  METAL_PREBUILT,
  EMBED_GPU_FALLBACK_MSG,
  detectUsableMetalBackend,
  resolveEmbedGpuChoice,
  resolveEmbedGpuLayers,
  parseMetalEngaged,
  confirmMetalEngagement,
  applyEmbedGpuChoice,
  previewEmbedGpuStatement,
  getEmbedGpuStatement,
  formatEmbedGpuLogLine,
  withEmbedGpuHealth,
  captureIoDuring,
  _resetEmbedGpuStatementForTests,
} from "../../resources/embed-gpu.ts";

/**
 * flair#1437 — stated gpuLayers default. These cases are the product
 * contract: detect a *usable* Metal backend (not merely the platform),
 * derive 99/0, honor FLAIR_EMBED_GPU_LAYERS, and fail loud when offload
 * was requested but Metal did not engage.
 */
describe("detectUsableMetalBackend (flair#1437)", () => {
  it("rejects non-darwin platforms even when the prebuilt would resolve", () => {
    expect(
      detectUsableMetalBackend({
        platform: "linux",
        arch: "arm64",
        resolve: () => "/fake/mac-arm64-metal",
      }),
    ).toBe(false);
    expect(
      detectUsableMetalBackend({
        platform: "darwin",
        arch: "x64",
        resolve: () => "/fake/mac-arm64-metal",
      }),
    ).toBe(false);
  });

  it("rejects darwin+arm64 when the Metal prebuilt is not resolvable", () => {
    expect(
      detectUsableMetalBackend({
        platform: "darwin",
        arch: "arm64",
        resolve: () => {
          throw new Error("Cannot find module");
        },
      }),
    ).toBe(false);
  });

  it("accepts darwin+arm64 only when @node-llama-cpp/mac-arm64-metal resolves", () => {
    let seen: string | undefined;
    expect(
      detectUsableMetalBackend({
        platform: "darwin",
        arch: "arm64",
        resolve: (id) => {
          seen = id;
          return "/node_modules/@node-llama-cpp/mac-arm64-metal";
        },
      }),
    ).toBe(true);
    expect(seen).toBe(METAL_PREBUILT);
  });

  it("honors an explicit usable override (test seam) over platform", () => {
    expect(detectUsableMetalBackend({ usable: true, platform: "linux" })).toBe(true);
    expect(detectUsableMetalBackend({ usable: false, platform: "darwin", arch: "arm64" })).toBe(false);
  });

  it("this host's live detect is false unless we are actually Metal-capable", () => {
    const live = detectUsableMetalBackend();
    if (process.platform === "darwin" && process.arch === "arm64") {
      // Live darwin-arm64 still requires the prebuilt; do not assume Metal.
      expect(typeof live).toBe("boolean");
    } else {
      expect(live).toBe(false);
    }
  });
});

describe("resolveEmbedGpuLayers / resolveEmbedGpuChoice (flair#1437)", () => {
  const SAVED = process.env.FLAIR_EMBED_GPU_LAYERS;

  beforeEach(() => {
    delete process.env.FLAIR_EMBED_GPU_LAYERS;
  });

  afterEach(() => {
    if (SAVED === undefined) delete process.env.FLAIR_EMBED_GPU_LAYERS;
    else process.env.FLAIR_EMBED_GPU_LAYERS = SAVED;
  });

  it("unset + no Metal → 0, source=default (never omit / never inherit a silent HFE 0)", () => {
    const choice = resolveEmbedGpuChoice({}, { usable: false });
    expect(choice).toEqual({ gpuLayers: 0, source: "default", metalUsable: false });
    expect(resolveEmbedGpuLayers({}, { usable: false })).toBe(0);
  });

  it("unset + usable Metal → 99, source=detected", () => {
    const choice = resolveEmbedGpuChoice({}, { usable: true });
    expect(choice).toEqual({ gpuLayers: 99, source: "detected", metalUsable: true });
    expect(resolveEmbedGpuLayers({}, { usable: true })).toBe(99);
  });

  it("FLAIR_EMBED_GPU_LAYERS=0 pins CPU even on Metal, source=env", () => {
    const choice = resolveEmbedGpuChoice(
      { FLAIR_EMBED_GPU_LAYERS: "0" },
      { usable: true },
    );
    expect(choice).toEqual({ gpuLayers: 0, source: "env", metalUsable: true });
    expect(resolveEmbedGpuLayers({ FLAIR_EMBED_GPU_LAYERS: "0" }, { usable: true })).toBe(0);
  });

  it("FLAIR_EMBED_GPU_LAYERS=99 honors the override on a no-GPU host, source=env", () => {
    const choice = resolveEmbedGpuChoice(
      { FLAIR_EMBED_GPU_LAYERS: "99" },
      { usable: false },
    );
    expect(choice).toEqual({ gpuLayers: 99, source: "env", metalUsable: false });
    expect(resolveEmbedGpuLayers({ FLAIR_EMBED_GPU_LAYERS: "99" }, { usable: false })).toBe(99);
  });

  it("trims whitespace on the env override", () => {
    expect(resolveEmbedGpuLayers({ FLAIR_EMBED_GPU_LAYERS: "  99  " }, { usable: false })).toBe(99);
  });

  it("invalid env values fall through to the derived default", () => {
    for (const raw of ["", "   ", "abc", "-1", "1.5", "NaN", "99gpu"]) {
      expect(resolveEmbedGpuLayers({ FLAIR_EMBED_GPU_LAYERS: raw }, { usable: false })).toBe(0);
      expect(resolveEmbedGpuLayers({ FLAIR_EMBED_GPU_LAYERS: raw }, { usable: true })).toBe(99);
    }
  });

  it("reads process.env when the env arg is omitted", () => {
    process.env.FLAIR_EMBED_GPU_LAYERS = "0";
    expect(resolveEmbedGpuLayers(undefined, { usable: true })).toBe(0);
    expect(resolveEmbedGpuChoice(undefined, { usable: true }).source).toBe("env");
  });
});

describe("parseMetalEngaged (flair#1437 — same signal as #1597)", () => {
  const metalLog = [
    "ggml_metal_init: use fusion = true",
    "sched_reserve: MTL0 compute buffer size = 120.02 MiB",
  ].join("\n");

  it("both markers → engaged", () => {
    const r = parseMetalEngaged(metalLog);
    expect(r.engaged).toBe(true);
    expect(r.hasInit).toBe(true);
    expect(r.hasComputeBuffer).toBe(true);
    expect(r.evidence.length).toBe(2);
  });

  it("hyphenated compute-buffer also matches", () => {
    expect(parseMetalEngaged("ggml_metal_init: ok\ncompute-buffer 64 MiB").engaged).toBe(true);
  });

  it("init without buffer → not engaged", () => {
    expect(parseMetalEngaged("ggml_metal_init: allocating").engaged).toBe(false);
  });

  it("empty / unrelated log → not engaged", () => {
    expect(parseMetalEngaged("").engaged).toBe(false);
    expect(parseMetalEngaged("harper started\nlistening on").engaged).toBe(false);
  });
});

describe("confirmMetalEngagement / fail-loud (flair#1437)", () => {
  const metalLog = [
    "ggml_metal_init: use fusion = true",
    "sched_reserve: MTL0 compute buffer size = 120.02 MiB",
  ].join("\n");

  it("gpuLayers=0 → CPU, no fallback (nothing was claimed)", () => {
    const r = confirmMetalEngagement({
      requestedGpuLayers: 0,
      metalUsable: false,
      warmupLog: "",
      source: "default",
    });
    expect(r.engaged).toBe(false);
    expect(r.statement).toEqual({ backend: "cpu", gpuLayers: 0, source: "default" });
    expect(r.statement.fallback).toBeUndefined();
  });

  it("forced GPU on a no-GPU box STATE fallback — never a silent CPU-under-GPU-claim", () => {
    const r = confirmMetalEngagement({
      requestedGpuLayers: 99,
      metalUsable: false,
      warmupLog: "",
      source: "env",
    });
    expect(r.engaged).toBe(false);
    expect(r.statement.backend).toBe("cpu");
    expect(r.statement.gpuLayers).toBe(0);
    expect(r.statement.source).toBe("env");
    expect(r.statement.fallback).toBe(EMBED_GPU_FALLBACK_MSG);
  });

  it("usable Metal + both log markers → backend=metal, gpuLayers=99, no fallback", () => {
    const r = confirmMetalEngagement({
      requestedGpuLayers: 99,
      metalUsable: true,
      warmupLog: metalLog,
      source: "detected",
    });
    expect(r.engaged).toBe(true);
    expect(r.statement).toEqual({ backend: "metal", gpuLayers: 99, source: "detected" });
  });

  it("usable Metal + missing ggml_metal_init confirmation → STATE fallback", () => {
    const r = confirmMetalEngagement({
      requestedGpuLayers: 99,
      metalUsable: true,
      warmupLog: "harper started\nno metal here",
      source: "detected",
    });
    expect(r.engaged).toBe(false);
    expect(r.statement.backend).toBe("cpu");
    expect(r.statement.gpuLayers).toBe(0);
    expect(r.statement.fallback).toBe(EMBED_GPU_FALLBACK_MSG);
  });
});

describe("stated snapshot + Health field (flair#1437)", () => {
  beforeEach(() => {
    _resetEmbedGpuStatementForTests();
  });

  afterEach(() => {
    _resetEmbedGpuStatementForTests();
  });

  it("preview of a Metal-derived choice does not claim metal before confirmation", () => {
    const preview = previewEmbedGpuStatement({
      gpuLayers: 99,
      source: "detected",
      metalUsable: true,
    });
    expect(preview.backend).toBe("cpu");
    expect(preview.gpuLayers).toBe(99);
    expect(preview.fallback).toBeUndefined();
  });

  it("applyEmbedGpuChoice stores the confirmed statement for /Health", () => {
    const statement = applyEmbedGpuChoice(
      { gpuLayers: 99, source: "detected", metalUsable: true },
      "ggml_metal_init: ok\ncompute buffer size = 1",
    );
    expect(getEmbedGpuStatement()).toEqual(statement);
    expect(statement.backend).toBe("metal");
  });

  it("withEmbedGpuHealth always attaches embedding {backend,gpuLayers,source}", () => {
    applyEmbedGpuChoice({ gpuLayers: 0, source: "default", metalUsable: false }, "");
    const body = withEmbedGpuHealth({ ok: true, searchReady: true });
    expect(body.embedding).toEqual({ backend: "cpu", gpuLayers: 0, source: "default" });
    expect(body.ok).toBe(true);
  });

  it("Health field carries fallback when forced-GPU did not engage", () => {
    applyEmbedGpuChoice({ gpuLayers: 99, source: "env", metalUsable: false }, "");
    const body = withEmbedGpuHealth({ ok: true });
    expect(body.embedding.backend).toBe("cpu");
    expect(body.embedding.gpuLayers).toBe(0);
    expect(body.embedding.source).toBe("env");
    expect(body.embedding.fallback).toBe(EMBED_GPU_FALLBACK_MSG);
  });

  it("getEmbedGpuStatement derives a preview when nothing has been stated yet", () => {
    const statement = getEmbedGpuStatement({ usable: false });
    expect(statement.backend).toBe("cpu");
    expect(statement.gpuLayers).toBe(0);
    expect(statement.source).toBe("default");
  });
});

describe("formatEmbedGpuLogLine (flair#1437 — boot log STATES the choice)", () => {
  it("CPU default names the missing backend", () => {
    expect(formatEmbedGpuLogLine({ backend: "cpu", gpuLayers: 0, source: "default" }))
      .toContain("embedding: CPU (no GPU backend detected)");
  });

  it("Metal names GPU (Metal) and the layer count + source", () => {
    const line = formatEmbedGpuLogLine({ backend: "metal", gpuLayers: 99, source: "detected" });
    expect(line).toContain("embedding: GPU (Metal), 99 layers");
    expect(line).toContain("source=detected");
  });

  it("env CPU pin is stated as env, not as 'no backend'", () => {
    const line = formatEmbedGpuLogLine({ backend: "cpu", gpuLayers: 0, source: "env" });
    expect(line).toContain("embedding: CPU, 0 layers");
    expect(line).toContain("source=env");
  });

  it("public /Health and /HealthDetail attach the stated embedding field", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "resources", "health.ts"), "utf8");
    expect(src).toContain("withEmbedGpuHealth");
    expect(src).toContain("stats.embedding");
  });

  it("captureIoDuring records console + stderr writes", async () => {
    const { value, log } = await captureIoDuring(async () => {
      console.log("ggml_metal_init: use fusion = true");
      process.stderr.write("sched_reserve: MTL0 compute buffer size = 1\n");
      return 7;
    });
    expect(value).toBe(7);
    expect(log).toContain("ggml_metal_init");
    expect(log).toContain("compute buffer");
  });

  it("fallback is the fail-loud sentence, never a GPU claim", () => {
    const line = formatEmbedGpuLogLine({
      backend: "cpu",
      gpuLayers: 0,
      source: "env",
      fallback: EMBED_GPU_FALLBACK_MSG,
    });
    expect(line).toContain(EMBED_GPU_FALLBACK_MSG);
    expect(line).not.toMatch(/GPU \(Metal\), 99/);
  });
});
