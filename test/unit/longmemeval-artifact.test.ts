import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildArtifact, verifyArtifactHash, writeArtifact, hashRunResults } from "../bench/longmemeval/artifact";
import { configManifest, hashConfig, canonicalJson } from "../bench/longmemeval/config";
import { aggregateArmRun, aggregateArmAcrossRuns } from "../bench/longmemeval/metrics";

// The publish gate is STRUCTURAL (Sherlock #4): the run emits a content-
// addressed artifact, and a human signs off on a specific artifactHash. These
// tests pin that the hash actually addresses the content and self-verifies.

const baseInput = () => ({
  configHash: "deadbeef",
  config: { schema: "test", a: 1 },
  runHashes: ["r1", "r2"],
  aggregate: [] as any[],
  gitCommit: "abc123",
  ollamaHost: "http://host:11434",
  benchHost: "rockit",
  validationSlice: true,
});

describe("artifact — content addressing", () => {
  test("artifactHash self-verifies (hash excludes the hash field)", () => {
    const art = buildArtifact(baseInput());
    expect(art.artifactHash).toBeTruthy();
    expect(verifyArtifactHash(art)).toBe(true);
  });

  test("identical inputs at different wall-times → identical artifactHash (reproducibility)", async () => {
    const a = buildArtifact(baseInput());
    await new Promise((r) => setTimeout(r, 5)); // force a different wall-clock ms
    const b = buildArtifact(baseInput());
    // The wall clock DID differ — but it is provenance, not content, so the
    // hash must be identical. This is the whole reproducibility claim.
    expect(a.generatedAt).not.toBe(b.generatedAt);
    expect(a.artifactHash).toBe(b.artifactHash);
  });

  test("mutating one aggregate number changes the artifactHash (tamper-evident)", () => {
    const a = buildArtifact(baseInput());
    const b = buildArtifact({
      ...baseInput(),
      aggregate: [{
        arm: "flair", runs: 1, varianceMeasured: false,
        overallAccuracy: { mean: 0.42, std: null, runs: [0.42] },
      }] as any,
    });
    expect(b.artifactHash).not.toBe(a.artifactHash);
  });

  test("verifyArtifactHash round-trips a written artifact", () => {
    const art = buildArtifact(baseInput());
    const path = writeArtifact(art, join(tmpdir(), "lme-artifact-test"));
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(verifyArtifactHash(written)).toBe(true);
  });

  test("a changed number changes the artifactHash (tamper-evident)", () => {
    const a = buildArtifact(baseInput());
    const tampered = { ...a } as any;
    delete tampered.artifactHash;
    tampered.runHashes = ["r1", "CHANGED"];
    const reAdded = buildArtifact({ ...baseInput(), runHashes: ["r1", "CHANGED"] });
    expect(reAdded.artifactHash).not.toBe(a.artifactHash);
  });

  test("carries the NOT-FOR-PUBLICATION notice", () => {
    const art = buildArtifact(baseInput());
    expect(art.notice).toContain("NOT FOR PUBLICATION");
    expect(art.notice).toContain("sign-off");
  });

  test("a single-run aggregate lands in the artifact as varianceMeasured: false, std: null (#1376)", () => {
    // The artifact is what a downstream reader consumes without ever seeing the
    // console report. `std: 0` there would let them re-derive the same overclaim
    // the headline used to make, so the absence has to survive serialisation as
    // a distinct fact — asserted through JSON, because a `null` that a
    // serializer drops is an absence that reads as "field not applicable".
    const perRun = [aggregateArmRun("flair", [
      { questionId: "q1", ability: "information-extraction", isAbstention: false, arm: "flair",
        answer: "", verdict: "CORRECT", tokensFed: 10, latencyMs: 1 },
    ])];
    const art = buildArtifact({ ...baseInput(), aggregate: [aggregateArmAcrossRuns("flair", perRun)] });
    const roundTripped = JSON.parse(JSON.stringify(art));
    expect(roundTripped.aggregate[0].varianceMeasured).toBe(false);
    expect(roundTripped.aggregate[0].overallAccuracy).toHaveProperty("std");
    expect(roundTripped.aggregate[0].overallAccuracy.std).toBeNull();
    expect(roundTripped.aggregate[0].overallAccuracy.std).not.toBe(0);
  });

  test("there is no publish function exported", async () => {
    const mod = await import("../bench/longmemeval/artifact");
    expect((mod as any).publish).toBeUndefined();
    expect((mod as any).publishArtifact).toBeUndefined();
  });
});

describe("config hash — pre-registration", () => {
  const slice = { n: 3, seed: 0, runs: 2, questionIds: ["qb", "qa", "qc"] };

  test("is deterministic and order-independent for questionIds", () => {
    const h1 = hashConfig(configManifest(slice));
    const h2 = hashConfig(configManifest({ ...slice, questionIds: ["qc", "qa", "qb"] }));
    expect(h1).toBe(h2); // manifest sorts questionIds
  });

  test("changes when the slice changes (config-shopping leaves a trace)", () => {
    const h1 = hashConfig(configManifest(slice));
    const h2 = hashConfig(configManifest({ ...slice, questionIds: ["qa", "qb", "qd"] }));
    expect(h1).not.toBe(h2);
  });

  test("canonicalJson sorts keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("hashRunResults is stable for equal decision sets", () => {
    const set = [{ arm: "flair", questionId: "q1", verdict: "CORRECT" }];
    expect(hashRunResults(set)).toBe(hashRunResults(set));
  });
});
