import { describe, test, expect } from "bun:test";
import {
  assertPortableConfig,
  canonicalJson,
  configManifest,
  contentHash,
  hashConfig,
  sha256hex,
} from "../bench/longmemeval/config";

/**
 * flair#1365 — `configHash` is THE ANCHOR, and it is only re-derivable outside
 * JavaScript if every value folded into it is language-portable. The manifest
 * happened to contain only strings and safe integers, so the anchor was
 * portable — but BY ACCIDENT: nothing stopped a float entering it and silently
 * breaking cross-language re-derivation. These tests convert that accident into
 * an enforced invariant.
 *
 * `canonicalJson` inherits `JSON.stringify` number formatting (ECMAScript
 * `Number::toString`), so a non-integer number serialises differently from
 * Python/Go/Rust and the recomputed sha256 mismatches on content that is
 * byte-identical in meaning. The failure mode is the bad one: our harness stays
 * self-consistent, every existing test stays green, and the only symptom is an
 * outside verifier's mismatch — which reads as tampering.
 *
 * The guard is enforced at BOTH boundaries:
 *   - `configManifest()` — at construction, so a future pinned float fails at
 *     its source with the field named (the `hashConfig` test below exercises the
 *     end-to-end hashed path; the guard itself is unit-tested here because the
 *     pinned constants are not injectable without editing source).
 *   - `hashConfig()` — at the anchor boundary, so a manifest assembled or
 *     mutated after `configManifest()` (e.g. the overrides in run.ts /
 *     payload-ab.ts) cannot slip a float into the anchor unnoticed.
 *
 * The guard deliberately does NOT sit on `contentHash()`, the seal helper: a
 * results/artifact seal legitimately covers floats (accuracies, p-values,
 * latencies) and is tamper-evidence, not a re-derivable anchor. Keeping the two
 * separate is the point — the anchor is portable, the seal is not claimed to be.
 *
 * POWERED CHECK (run when changing the guard): temporarily add a float to
 * `configManifest()`'s returned object, run this file, confirm the failure names
 * the field and the remedy, then remove it. A guard that has never been seen
 * failing is not a guard.
 */

const SLICE = { n: 2, seed: 0, runs: 1, questionIds: ["q-b", "q-a"] };

describe("longmemeval configHash portability is enforced (flair#1365)", () => {
  test("the real config manifest is portable and hashes to a 64-hex anchor", () => {
    const manifest = configManifest(SLICE);
    expect(() => assertPortableConfig(manifest, "test")).not.toThrow();
    expect(hashConfig(manifest)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a float entering the hashed config is rejected, not silently hashed", () => {
    // This is the test that FAILS on the old code: before the guard,
    // `hashConfig` happily content-addressed the float and returned a hash, so
    // the anchor silently stopped being re-derivable outside JS.
    const withFloat = { ...configManifest(SLICE), similarityThreshold: 0.95 };
    expect(() => hashConfig(withFloat)).toThrow(/similarityThreshold/);
  });

  test("the rejection names the actor, the offending field path, and the remedy", () => {
    let message = "";
    try {
      assertPortableConfig({ retrieval: { rrfK: 0.5 } }, "configManifest");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("configManifest"); // actor: who let it in
    expect(message).toContain("$.retrieval.rrfK"); // field: where
    expect(message).toContain('"0.95"'); // remedy: pin as a string
    expect(message).toContain("1365"); // issue: why, with context
  });

  test("NaN and Infinity are rejected (JSON.stringify would silently emit null)", () => {
    expect(() => assertPortableConfig({ x: NaN }, "t")).toThrow(/x/);
    expect(() => assertPortableConfig({ x: Infinity }, "t")).toThrow(/x/);
    expect(() => assertPortableConfig({ x: -Infinity }, "t")).toThrow(/x/);
    // Prove the hazard the guard closes: the canonical form is lossy for these.
    expect(JSON.parse(JSON.stringify({ x: NaN }))).toEqual({ x: null });
  });

  test("integers past the safe range are rejected (exponential formatting)", () => {
    // Number.isInteger(1e20) is true, so the issue's literal predicate
    // (`!Number.isInteger`) would let this through — but Number::toString may
    // render it in a form no other language reproduces. isSafeInteger is the
    // correct portability predicate.
    expect(Number.isInteger(1e20)).toBe(true);
    expect(() => assertPortableConfig({ budget: 1e20 }, "t")).toThrow(/budget/);
  });

  test("floats nested in arrays are caught with an indexed path", () => {
    expect(() => assertPortableConfig({ arms: [1, 0.5] }, "configManifest")).toThrow(/arms\[1\]/);
  });

  test("a seal (contentHash) still covers floats — only the anchor is guarded", () => {
    // The boundary is deliberate: `resultsHash`/`artifactHash` are seals over
    // accuracies, p-values and latencies, which are floats by nature. Guarding
    // them would break the seal path for no portability gain. Only the anchor
    // (configHash) must stay language-portable.
    const results = { overallAccuracy: 0.66, mcnemar: { p: 1.5497207641601533e-6 } };
    expect(() => contentHash(results)).not.toThrow();
    expect(contentHash(results)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("strings, booleans, null, safe integers and nesting are accepted", () => {
    expect(() =>
      assertPortableConfig(
        {
          s: "0.95",
          b: true,
          z: null,
          i: 42,
          neg: -7,
          zero: 0,
          arr: [1, "x", false, null],
          nested: { k: 0, deep: { list: [1, 2, 3] } },
        },
        "t",
      ),
    ).not.toThrow();
  });

  test("the guard is a predicate, not a transform", () => {
    // The anchor must be byte-for-byte what it was before the guard existed: if
    // the guard ever normalised a value instead of rejecting it, the hash would
    // change silently — the very trust-anchor trap the reject-not-normalise
    // choice avoids. Compare the guarded path against the raw canonical form.
    // (Not a pinned literal: the manifest legitimately grows, and pinning a
    // whole-manifest hash is the treadmill the #1366 test exists to avoid.)
    const manifest = configManifest(SLICE);
    expect(hashConfig(manifest)).toBe(sha256hex(canonicalJson(manifest)));
  });
});
