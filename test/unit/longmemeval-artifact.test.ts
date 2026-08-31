import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildArtifact, verifyArtifactHash, writeArtifact, hashRunResults, hashedContent, PROVENANCE_KEYS,
} from "../bench/longmemeval/artifact";
import { configManifest, hashConfig, canonicalJson } from "../bench/longmemeval/config";
import { aggregateArmRun, aggregateArmAcrossRuns } from "../bench/longmemeval/metrics";
import type { ReaderDeterminism } from "../bench/longmemeval/determinism";

// The publish gate is STRUCTURAL (Sherlock #4): the run emits a content-
// addressed artifact, and a human signs off on a specific artifactHash. These
// tests pin that the hash actually addresses the content and self-verifies.
//
// What that buys, precisely: `artifactHash` is a SEAL, not a proof. It binds a
// sign-off to one exact set of numbers so a later edit is detectable. It is not
// evidence the numbers reproduce — `configHash` is the re-derivable anchor for
// that. The tests below are about tamper-evidence and about the hashed /
// provenance partition, never about reproducing a result.

const baseInput = () => ({
  configHash: "deadbeef",
  config: { schema: "test", a: 1 },
  runHashes: ["r1", "r2"],
  aggregate: [] as any[],
  // A well-formed 40-hex sha: buildArtifact now fail-closes on anything else,
  // so the fixture must supply a real commit shape (flair#1432).
  gitCommit: "1234567890abcdef1234567890abcdef12345678",
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

  test("identical inputs at different wall-times → identical artifactHash (the seal ignores provenance)", async () => {
    const a = buildArtifact(baseInput());
    await new Promise((r) => setTimeout(r, 5)); // force a different wall-clock ms
    const b = buildArtifact(baseInput());
    // The wall clock DID differ — but it is provenance, not content, so the
    // hash must be identical. This says the seal does not fire on WHEN or WHERE
    // an artifact was written; it does not say the numbers inside it reproduce.
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

// ═══════════════════════════════════════════════════════════════════════════
// The reader-determinism probe is UNHASHED PROVENANCE (flair#1368).
//
// The property: a determinism measurement legitimately differs between two
// honest runs of the same config. If it fed `artifactHash`, every faithful
// re-run would look like tampering — the seal would fire on exactly the thing
// it is not meant to detect.
//
// PROVEN ABLE TO FAIL, not assumed: removing "readerDeterminism" from
// PROVENANCE_KEYS turns "leaves artifactHash unchanged" and "two runs differing
// only in measured determinism hash identically" RED. A green-from-the-start
// test proves nothing about a partition it never saw violated.
// ═══════════════════════════════════════════════════════════════════════════

const probeFixture = (overrides: Partial<ReaderDeterminism> = {}): ReaderDeterminism => ({
  schema: "longmemeval-s.reader-determinism/1",
  measuredAt: "2026-08-24T00:00:00.000Z",
  ollamaHost: "https://ollama.com",
  reader: {
    model: "qwen3.5:397b", manifestDigest: "sha256:b909ca2f1b7f", family: "qwen3_5",
    temperature: 0, seed: 0, numCtx: 16384, numPredict: 256,
  },
  promptConstruction: {
    arm: "flair", numCtx: 16384, readerPromptVersion: "1.0.0",
    readerPayloadFormat: "v2-dated", readerTopK: 20, contextSource: "deterministic",
  },
  samples: 10,
  questionIds: ["001be529", "00ca467f"],
  perQuestion: [{
    questionId: "001be529", ability: "information-extraction", promptChars: 4200,
    promptTokens: [1400], samples: 10, distinctCompletions: 3, commonPrefixLength: 68,
    verdictAgreementRate: 1, verdictCounts: { CORRECT: 10 }, judgeErrors: 0,
    completionChars: [120, 131, 118],
  }],
  summary: { maxDistinctCompletions: 3, minCommonPrefixLength: 68, minVerdictAgreementRate: 1 },
  error: null,
  ...overrides,
});

describe("reader-determinism probe — unhashed provenance (#1368)", () => {
  test("PROVENANCE_KEYS names it, so buildArtifact and verify can never drift", () => {
    expect([...PROVENANCE_KEYS]).toContain("readerDeterminism");
  });

  test("adding the probe leaves artifactHash unchanged for otherwise-identical input", () => {
    const without = buildArtifact(baseInput());
    const withProbe = buildArtifact({ ...baseInput(), readerDeterminism: probeFixture() });

    // Positive control on the FIXTURE FIRST. Without it, "the hashes are equal"
    // would also pass if buildArtifact silently dropped the field — i.e. the
    // assertion would hold for the wrong reason and the partition would be
    // untested. Assert the probe actually landed, with its content intact.
    expect(withProbe.readerDeterminism).toBeDefined();
    expect(withProbe.readerDeterminism!.summary!.maxDistinctCompletions).toBe(3);
    expect(withProbe.readerDeterminism!.questionIds).toEqual(["001be529", "00ca467f"]);
    // And that it is genuinely OUTSIDE the hashed partition, not merely equal
    // by luck of canonicalisation.
    expect(Object.keys(hashedContent(withProbe))).not.toContain("readerDeterminism");

    expect(withProbe.artifactHash).toBe(without.artifactHash);
  });

  test("two runs differing ONLY in measured determinism hash identically", () => {
    // This is the property that matters operationally: an honest re-run whose
    // reader diverged more (or less) than ours must not look like tampering.
    const a = buildArtifact({ ...baseInput(), readerDeterminism: probeFixture() });
    const b = buildArtifact({
      ...baseInput(),
      readerDeterminism: probeFixture({
        measuredAt: "2027-01-01T00:00:00.000Z",
        summary: { maxDistinctCompletions: 9, minCommonPrefixLength: 3, minVerdictAgreementRate: 0.6 },
        perQuestion: [],
      }),
    });
    expect(a.readerDeterminism!.summary).not.toEqual(b.readerDeterminism!.summary);
    expect(a.artifactHash).toBe(b.artifactHash);
  });

  test("an artifact carrying the probe still self-verifies", () => {
    const art = buildArtifact({ ...baseInput(), readerDeterminism: probeFixture() });
    expect(verifyArtifactHash(art)).toBe(true);
  });

  test("a FAILED probe is recorded, not omitted — the two must be distinguishable", () => {
    // "we did not probe" and "we probed and it broke" are different facts. A
    // consumer must be able to tell them apart, so the failure path carries the
    // same shape with `error` set rather than dropping the key.
    const failed = buildArtifact({
      ...baseInput(),
      readerDeterminism: probeFixture({ error: "connect ECONNREFUSED", perQuestion: [], summary: null }),
    });
    const absent = buildArtifact(baseInput());
    expect(failed.readerDeterminism!.error).toBe("connect ECONNREFUSED");
    expect(absent.readerDeterminism).toBeUndefined();
    // Still provenance in both cases: neither moves the seal.
    expect(failed.artifactHash).toBe(absent.artifactHash);
  });

  test("a written artifact carrying the probe still verifies after a JSON round trip", () => {
    // The artifact is consumed as a FILE. An in-memory-only assertion would miss
    // a field that does not survive serialisation, and the probe record is the
    // newest thing in the file.
    const art = buildArtifact({ ...baseInput(), readerDeterminism: probeFixture() });
    const path = writeArtifact(art, join(tmpdir(), "lme-artifact-test-1368"));
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.readerDeterminism.questionIds).toEqual(["001be529", "00ca467f"]);
    expect(written.readerDeterminism.perQuestion[0].distinctCompletions).toBe(3);
    expect(verifyArtifactHash(written)).toBe(true);
  });

  test("a CONTENT change still moves the hash — the seal has not been blunted", () => {
    // Negative control for the whole block above: if adding provenance keys had
    // accidentally disabled hashing, every test here would pass vacuously.
    const a = buildArtifact({ ...baseInput(), readerDeterminism: probeFixture() });
    const b = buildArtifact({
      ...baseInput(), readerDeterminism: probeFixture(), configHash: "cafebabe",
    });
    expect(b.artifactHash).not.toBe(a.artifactHash);
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
