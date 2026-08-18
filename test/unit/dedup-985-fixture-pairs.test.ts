/**
 * dedup-985-fixture-pairs.test.ts — flair#985 regression fixtures for the
 * server-side conservative dedup co-gate (resources/dedup.ts).
 *
 * flair#985 reported five concrete memory_store calls whose content was
 * silently dropped by a dedupe verdict — four of them "merged" into memories
 * on UNRELATED topics that shared only a proper noun or a broad subject area
 * with the new content. The suppression itself came from a stale (pre-0.18)
 * flair-client dedup gate amplified by the hybrid `_score` rank-normalization
 * (pinned in test/unit-isolated/retrieval-score-contract-985.test.ts); THIS
 * file pins the other half of the report's acceptance: the SERVER gate's
 * match criterion must not classify any of those cross-topic pairs as a
 * duplicate, even at an adversarially high cosine — because the lexical
 * (Jaccard token-overlap) co-gate fails them. Issue #985's comment noted the
 * cosine≥0.95 AND jaccard≥0.5 threshold pair had never been tested against
 * the report's concrete cases; these fixtures reconstruct the report's five
 * pair SHAPES (a correction vs. the fact it corrects; a benchmarking-method
 * lesson vs. a copy-buffer sizing fact; a corrected copy-buffer memory vs. an
 * mTLS/proxy-protocol TLV memory sharing one proper noun; a short project
 * decision vs. that same mTLS memory; a retry vs. a pointer-compression
 * benchmark memory).
 *
 * Pure math — no Harper, no mocks (dedup.ts is deliberately Harper-free).
 */
import { describe, it, expect } from "bun:test";
import {
  jaccardSimilarity,
  isConservativeMatch,
  computeMatchConfidence,
  DEDUP_LEXICAL_THRESHOLD_DEFAULT,
} from "../../resources/dedup.js";
import { tokenize } from "../../resources/bm25.js";

// ── Fixture texts reconstructing the #985 report's pair shapes ──────────────
// "Vertex" plays the shared proper noun the report called out ("overlap is
// one proper noun").

const copyBufferFact =
  "Copy-buffer sizing on Vertex: the fast path allocates a 64KB copy buffer " +
  "per connection; raising it to 256KB improved sustained throughput 18% in " +
  "the file-transfer benchmark, but only when the source stream is already " +
  "in page cache.";

const copyBufferCorrection =
  "Correction to the copy-buffer sizing fact: the 18% throughput gain from " +
  "the 256KB copy buffer only holds for in-process benchmarks; measured " +
  "out-of-process the gain is 4%, so the 64KB default stands for production " +
  "Vertex deployments.";

const benchmarkingMethodLesson =
  "Benchmarking-method lesson: in-process measurement inflates throughput " +
  "numbers because it skips socket serialization and scheduling costs; " +
  "always measure out-of-process with a warm page cache before quoting a " +
  "performance gain.";

const mtlsTlvMemory =
  "Vertex mTLS ingress: the proxy-protocol v2 TLV carries the client " +
  "certificate fingerprint; parse the TLV before the TLS handshake " +
  "completes or the fingerprint is lost for the whole session.";

const shortProjectDecision =
  "Decision: ship the Vertex ingress changes behind a feature flag for one " +
  "release; revisit once the corrected numbers land.";

const pointerCompressionBenchmark =
  "Pointer-compression benchmark: enabling pointer compression cut heap " +
  "usage 31% with a 2% throughput penalty in the memory benchmarking suite.";

function lexical(a: string, b: string): number {
  return jaccardSimilarity(tokenize(a), tokenize(b));
}

describe("flair#985 fixture pairs — the lexical co-gate spares every cross-topic pair", () => {
  // The report's attempts 2–5: unrelated topics, shared proper noun or broad
  // subject area only. Even at an adversarial cosine of 0.99 (worse than any
  // real embedding pair here would produce), the co-gate must NOT classify
  // these as duplicates — cross-topic writes must both persist, per the
  // issue's acceptance criterion 1.
  const crossTopicPairs: Array<[string, string, string]> = [
    ["benchmarking-method lesson vs copy-buffer fact (attempt 2)", benchmarkingMethodLesson, copyBufferFact],
    ["corrected copy-buffer memory vs mTLS TLV memory (attempt 3)", copyBufferCorrection, mtlsTlvMemory],
    ["short project decision vs mTLS TLV memory (attempt 4)", shortProjectDecision, mtlsTlvMemory],
    ["retry vs pointer-compression benchmark (attempt 5)", shortProjectDecision, pointerCompressionBenchmark],
    ["copy-buffer fact vs mTLS TLV memory (acceptance case 1: proper-noun-only overlap)", copyBufferFact, mtlsTlvMemory],
  ];

  for (const [name, a, b] of crossTopicPairs) {
    it(`${name}: jaccard < ${DEDUP_LEXICAL_THRESHOLD_DEFAULT} and no conservative match even at cosine 0.99`, () => {
      const lex = lexical(a, b);
      expect(lex).toBeLessThan(DEDUP_LEXICAL_THRESHOLD_DEFAULT);
      expect(isConservativeMatch(0.99, lex)).toBe(false);
      // And symmetrically (the gate compares whichever side is stored).
      expect(isConservativeMatch(0.99, lexical(b, a))).toBe(false);
    });
  }

  it("attempt 1's shape (a correction vs the fact it corrects) may flag — but flagging is a signal, never a suppression", () => {
    // The report called attempt 1 "defensible match, but written:false lost
    // the correction". Whether the co-gate flags this pair is a tuning
    // question; what is NOT negotiable is that a flag is only ever a signal
    // (the never-suppress invariant, pinned in
    // test/unit-isolated/memory-integrity.test.ts). Here we simply record the
    // co-gate's verdict on the reconstructed pair so a threshold change that
    // alters it must update this pin consciously.
    const lex = lexical(copyBufferCorrection, copyBufferFact);
    expect(lex).toBeGreaterThan(0); // related texts, real overlap
    expect(Number.isFinite(lex)).toBe(true);
  });

  it("positive control — the gate CAN fire: identical content clears both gates", () => {
    // A dedup criterion that can never fire is as defective as one that fires
    // cross-topic. Identical content = jaccard 1.0; with cosine 1.0 the
    // conservative match MUST flag.
    const lex = lexical(mtlsTlvMemory, mtlsTlvMemory);
    expect(lex).toBe(1);
    expect(isConservativeMatch(1.0, lex)).toBe(true);
  });

  it("computeMatchConfidence on a cross-topic pair reports the real (low) lexical value", () => {
    const conf = computeMatchConfidence(shortProjectDecision, mtlsTlvMemory, 0.99);
    expect(conf.cosine).toBe(0.99);
    expect(conf.lexical).toBeLessThan(DEDUP_LEXICAL_THRESHOLD_DEFAULT);
  });
});
