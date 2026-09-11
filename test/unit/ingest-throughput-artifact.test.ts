/**
 * ingest-throughput-artifact.test.ts — flair#1436 schema v2.
 *
 * Pins: content-address seal, gitCommit refuse, verbose partition
 * (quietBox is provenance, ranking is content).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildArtifact, verifyArtifactHash, writeArtifact, hashRunResults, hashedContent, PROVENANCE_KEYS,
  aggregate,
} from "../bench/ingest-throughput/artifact";
import { hashConfig, configManifest, ARTIFACT_SCHEMA } from "../bench/ingest-throughput/config";
import type { SettingMetrics } from "../bench/ingest-throughput/measure";
import type { QuietBoxSnapshot } from "../bench/ingest-throughput/quiet-box";

const GIT = "1234567890abcdef1234567890abcdef12345678";

function quiet(over: Partial<QuietBoxSnapshot> = {}): QuietBoxSnapshot {
  return {
    quiet: true,
    passed: true,
    blocked: false,
    caveat: false,
    reason: "quiet",
    load1: 0.1,
    cores: 8,
    competing: [],
    inspectedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function metrics(over: Partial<SettingMetrics> = {}): SettingMetrics {
  return {
    requestedThreads: 7,
    requestedGpuLayers: 0,
    observedThreads: 7,
    availableParallelism: 8,
    hostCores: 8,
    wallClockMs: 10_000,
    modelLoadMs: 1_000,
    documents: 120,
    tokensIngested: 10_000,
    estimateTokens: 9_000,
    tokPerSec: 1000,
    tokPerSecPerCore: 142.8,
    docsPerSec: 12,
    peakRssBytes: 1e9,
    metalEngaged: false,
    metalEvidence: [],
    ...over,
  };
}

function baseInput() {
  const runs = [metrics(), metrics({ tokPerSec: 1010, docsPerSec: 12.2, wallClockMs: 9_800 })];
  const settings = [aggregate(runs)];
  return {
    configHash: "deadbeef",
    config: { schema: "test", a: 1 },
    runHashes: ["r1", "r2"],
    settings,
    negativeControl: {
      low: 1, high: 8, gpuLayers: 0,
      ratio: 0.2, slowdown: 5, passed: true, blocked: false, minSlowdown: 1.3,
    },
    positiveControl: {
      applicable: true, passed: true, blocked: false,
      reason: "ok", expected: 159,
      measured: { min: 150, max: 165, mean: 157 },
    },
    ranking: {
      "threads@gpu=0": {
        winner: null, verdict: "inconclusive" as const, reason: "overlap",
        intervals: {}, overlappingPairs: [],
      },
    },
    gpuSweep: { sweep: [0], skipped: true, reason: "linux" },
    gitCommit: GIT,
    benchHost: "tps-bench",
    platform: "linux",
    arch: "x64",
    metalCapable: false,
    quietBox: quiet(),
  };
}

describe("ingest-throughput artifact v2", () => {
  test(`schema is ${ARTIFACT_SCHEMA}`, () => {
    expect(buildArtifact(baseInput()).schema).toBe(ARTIFACT_SCHEMA);
  });

  test("artifactHash self-verifies", () => {
    const art = buildArtifact(baseInput());
    expect(art.artifactHash).toBeTruthy();
    expect(verifyArtifactHash(art)).toBe(true);
  });

  test("identical content at different wall-times → identical artifactHash", async () => {
    const a = buildArtifact(baseInput());
    await new Promise((r) => setTimeout(r, 5));
    const b = buildArtifact(baseInput());
    expect(a.generatedAt).not.toBe(b.generatedAt);
    expect(a.artifactHash).toBe(b.artifactHash);
  });

  test("quietBox is provenance (does not move the seal)", () => {
    const a = buildArtifact(baseInput());
    const b = buildArtifact({
      ...baseInput(),
      quietBox: quiet({ reason: "different host noise", load1: 0.4 }),
    });
    expect(a.artifactHash).toBe(b.artifactHash);
  });

  test("ranking is content (moves the seal)", () => {
    const a = buildArtifact(baseInput());
    const b = buildArtifact({
      ...baseInput(),
      ranking: {
        "threads@gpu=0": {
          winner: "threads=8 gpu=0", verdict: "winner", reason: "separated",
          intervals: {}, overlappingPairs: [],
        },
      },
    });
    expect(b.artifactHash).not.toBe(a.artifactHash);
  });

  test("null gitCommit refuses (flair#1432)", () => {
    expect(() => buildArtifact({ ...baseInput(), gitCommit: null as unknown as string })).toThrow(/1432/);
    expect(() => buildArtifact({ ...baseInput(), gitCommit: "abc" })).toThrow(/1432/);
  });

  test("write + verify round-trip", () => {
    const art = buildArtifact(baseInput());
    const dir = mkdtempSync(join(tmpdir(), "ingest-art-"));
    const path = writeArtifact(art, dir);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(verifyArtifactHash(written)).toBe(true);
    expect(path).toMatch(/ingest-throughput-artifact-[0-9a-f]{16}\.json$/);
  });

  test("PROVENANCE_KEYS are stripped from the hashed content", () => {
    const art = buildArtifact(baseInput());
    const content = hashedContent(art);
    for (const k of PROVENANCE_KEYS) expect(content).not.toHaveProperty(k);
    expect(content).toHaveProperty("ranking");
    expect(content).toHaveProperty("negativeControl");
    expect(content).toHaveProperty("gitCommit");
  });

  test("aggregate reports doc/s spread", () => {
    const agg = aggregate([
      metrics({ docsPerSec: 10, tokPerSec: 100 }),
      metrics({ docsPerSec: 14, tokPerSec: 140 }),
    ]);
    expect(agg.meanDocsPerSec).toBe(12);
    expect(agg.docsPerSecSpread).toEqual({ min: 10, max: 14, mean: 12 });
    expect(agg.requestedGpuLayers).toBe(0);
  });

  test("hashRunResults is stable", () => {
    const m = metrics();
    expect(hashRunResults(m)).toBe(hashRunResults({ ...m }));
    expect(hashRunResults(m)).not.toBe(hashRunResults({ ...m, tokPerSec: 1 }));
  });

  test("configManifest folds gpu sweep + 1.3× control into configHash", () => {
    const a = hashConfig(configManifest({ n: 500, seed: 0, runs: 3 }, [0]));
    const b = hashConfig(configManifest({ n: 500, seed: 0, runs: 3 }, [0, 99]));
    const c = hashConfig(configManifest({ n: 500, seed: 0, runs: 3 }, [0]));
    expect(a).toBe(c);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
