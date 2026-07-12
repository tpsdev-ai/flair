import { describe, test, expect } from "bun:test";
import { pickRecommendation } from "../src/recommend-heuristic.js";
import type { BatchResult, HostFingerprint, ModelBenchResult } from "../src/types.js";

function fixtureHost(overrides: Partial<HostFingerprint> = {}): HostFingerprint {
  return {
    platform: "darwin",
    arch: "arm64",
    cpuModel: "Apple M4 Pro",
    totalRamGiB: 32,
    availableRamGiB: 16,
    backend: "metal",
    gpuDeviceNames: ["Apple M4 Pro"],
    ...overrides,
  };
}

function fixtureModel(overrides: Partial<ModelBenchResult> = {}): ModelBenchResult {
  const perKind = {
    stress: { n: 10, p3: 0.9, mrr: 0.9 },
    trap: { n: 10, p3: 0.9, mrr: 0.9 },
    hard: { n: 10, p3: 0.9, mrr: 0.9 },
    clean: { n: 10, p3: 0.9, mrr: 0.9 },
  };
  return {
    model: {
      fileName: "model.Q4_K_M.gguf",
      sha256: "a".repeat(64),
      sizeBytes: 100_000_000,
      quant: "Q4_K_M",
      quantSource: "gguf-metadata",
      dims: 768,
      paramsApprox: 137_000_000,
      bpw: 4.5,
    },
    loadTimeMs: 500,
    msPerEmbedSerialWarm: 10,
    peakRssDeltaMiB: 500,
    aggregate: { n: 40, p3: 0.9, mrr: 0.9 },
    perKind,
    ...overrides,
  };
}

function fixtureBatch(models: ModelBenchResult[], host: HostFingerprint = fixtureHost()): BatchResult {
  return {
    toolVersion: "0.1.0",
    timestamp: new Date(0).toISOString(),
    corpus: { version: "v2", records: 251, queries: 126 },
    host,
    models,
  };
}

describe("pickRecommendation", () => {
  test("no models -> null recommendation with an explanatory note", () => {
    const { recommendation, notes } = pickRecommendation(fixtureBatch([]));
    expect(recommendation).toBeNull();
    expect(notes.some((n) => n.includes("No models were benchmarked"))).toBe(true);
  });

  test("picks the higher-MRR model when both fit budget", () => {
    const good = fixtureModel({ model: { ...fixtureModel().model, fileName: "good.gguf" }, aggregate: { n: 40, p3: 0.98, mrr: 0.96 } });
    const worse = fixtureModel({ model: { ...fixtureModel().model, fileName: "worse.gguf" }, aggregate: { n: 40, p3: 0.9, mrr: 0.85 } });
    const { recommendation } = pickRecommendation(fixtureBatch([worse, good]));
    expect(recommendation?.fileName).toBe("good.gguf");
    expect(recommendation?.reason).toContain("good.gguf");
    expect(recommendation?.reason).toContain("0.960"); // cites the actual measured MRR
  });

  test("excludes a model whose peak RSS exceeds the RAM headroom budget", () => {
    // host has 16 GiB available, default headroom 0.5 -> 8 GiB (8192 MiB) budget
    const tooHeavy = fixtureModel({
      model: { ...fixtureModel().model, fileName: "too-heavy.gguf" },
      aggregate: { n: 40, p3: 0.99, mrr: 0.99 }, // best recall, but...
      peakRssDeltaMiB: 20_000, // ...way over budget
    });
    const fits = fixtureModel({
      model: { ...fixtureModel().model, fileName: "fits.gguf" },
      aggregate: { n: 40, p3: 0.9, mrr: 0.9 },
      peakRssDeltaMiB: 500,
    });
    const { recommendation, notes } = pickRecommendation(fixtureBatch([tooHeavy, fits]));
    expect(recommendation?.fileName).toBe("fits.gguf");
    expect(notes.join(" ")).not.toContain("No model fit"); // fits.gguf DID fit, so no fallback note
  });

  test("excludes a model whose latency exceeds the threshold", () => {
    const slow = fixtureModel({
      model: { ...fixtureModel().model, fileName: "slow.gguf" },
      aggregate: { n: 40, p3: 0.99, mrr: 0.99 },
      msPerEmbedSerialWarm: 5000,
    });
    const fast = fixtureModel({
      model: { ...fixtureModel().model, fileName: "fast.gguf" },
      aggregate: { n: 40, p3: 0.9, mrr: 0.9 },
      msPerEmbedSerialWarm: 20,
    });
    const { recommendation } = pickRecommendation(fixtureBatch([slow, fast]), { latencyThresholdMsPerEmbed: 500 });
    expect(recommendation?.fileName).toBe("fast.gguf");
  });

  test("falls back to ranking the full set (with an explicit note) when nothing fits budget", () => {
    const a = fixtureModel({ model: { ...fixtureModel().model, fileName: "a.gguf" }, peakRssDeltaMiB: 99_999, aggregate: { n: 40, p3: 0.99, mrr: 0.99 } });
    const b = fixtureModel({ model: { ...fixtureModel().model, fileName: "b.gguf" }, peakRssDeltaMiB: 99_999, aggregate: { n: 40, p3: 0.9, mrr: 0.9 } });
    const { recommendation, notes } = pickRecommendation(fixtureBatch([a, b]));
    expect(recommendation?.fileName).toBe("a.gguf"); // still picks best recall among the fallback pool
    expect(notes.some((n) => n.includes("No model fit"))).toBe(true);
  });

  test("a tighter fixture hardware profile (small host) yields a smaller budget than a large host", () => {
    const smallHost = fixtureHost({ availableRamGiB: 2 });
    const model = fixtureModel({ peakRssDeltaMiB: 1500 }); // 1.5 GiB
    const { recommendation, notes } = pickRecommendation(fixtureBatch([model], smallHost));
    // 2 GiB * 0.5 headroom = 1 GiB budget < 1.5 GiB model -> falls back
    expect(notes.some((n) => n.includes("No model fit"))).toBe(true);
    expect(recommendation?.fileName).toBe(model.model.fileName); // still the only model, just flagged
  });

  test("single-model batch still recommends it, with a note to add more for comparison", () => {
    const only = fixtureModel();
    const { recommendation } = pickRecommendation(fixtureBatch([only]));
    expect(recommendation?.fileName).toBe(only.model.fileName);
    expect(recommendation?.reason).toContain("only model benchmarked");
  });
});
