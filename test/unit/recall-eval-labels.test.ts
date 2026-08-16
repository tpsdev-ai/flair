/**
 * recall-eval-labels.test.ts — the #17 self-pollution proof, hermetic.
 *
 * The defect the deterministic recall eval (#1216-a) fixes: the old recall
 * QUALITY signal (`flair quality` recall spot-check) derived its relevance
 * label from the target memory's OWN text — relevance == query/corpus overlap,
 * so a corpus of near-duplicates scores a false "recall collapse" (flair#967 /
 * #857 / #996). This test proves the Layer 1 labels are FIXED and curated, NOT
 * reproducible from corpus-query text overlap, and that scoring against the
 * two labellings gives DIFFERENT metrics (so the curated labels are real, not
 * an overlap artefact). No Harper — pure label + metric math.
 */
import { describe, expect, test } from "bun:test";
import {
  RELEVANCE_LABELS,
  deriveLexicalOverlapLabels,
  LABELLED_QUERIES,
  idFor,
} from "../bench/recall-eval/labels";
import { CORPUS } from "../bench/recall-harness/corpus";
import { recallAtK } from "../../packages/flair-bench/lib/index";

describe("Layer 1 recall labels are curated, not corpus-derived (#17)", () => {
  test("every curated label resolves to a real corpus record", () => {
    const realIds = new Set(CORPUS.map((r) => idFor(r.marker)));
    for (const lq of LABELLED_QUERIES) {
      expect(lq.relevantIds.length).toBeGreaterThan(0);
      for (const id of lq.relevantIds) expect(realIds.has(id)).toBe(true);
    }
  });

  test("curated labels DIFFER from the self-polluting lexical-overlap labelling", () => {
    // The control: relevance == the corpus record with max token overlap with
    // the query (what a corpus-derived label produces — the spot-check defect).
    const derived = deriveLexicalOverlapLabels();
    let differing = 0;
    for (const lq of LABELLED_QUERIES) {
      const curated = RELEVANCE_LABELS[lq.id]!.join(",");
      const overlap = derived[lq.id]!.join(",");
      if (curated !== overlap) differing++;
    }
    // If the curated labels were just corpus-query overlap, this would be 0.
    // It is not: a meaningful fraction of queries are answered by a record that
    // is NOT the highest-lexical-overlap one (the whole reason the corpus has
    // trap/hard queries). That is the self-pollution being absent.
    expect(differing).toBeGreaterThanOrEqual(3);
    // And the two label MAPS are not identical.
    expect(JSON.stringify(RELEVANCE_LABELS)).not.toBe(JSON.stringify(derived));
  });

  test("mutation-check: swapping to corpus-derived labels CHANGES the metric", () => {
    // Oracle ranking per query: the curated answer first, then the rest of the
    // corpus. Under the CURATED labels this scores recall@1 = 1.0 by
    // construction. Under the corpus-derived labels it must score LOWER,
    // because for the diverging queries the lexical label is a DIFFERENT record
    // that is not at rank 0. A metric that did not move here would mean the two
    // labellings were interchangeable — i.e. the labels were corpus-derived
    // after all. It moves, so they are real.
    const derived = deriveLexicalOverlapLabels();
    const allIds = CORPUS.map((r) => idFor(r.marker));

    let curatedHits = 0;
    let derivedHits = 0;
    for (const lq of LABELLED_QUERIES) {
      const curatedId = lq.relevantIds[0]!;
      const ranking = [curatedId, ...allIds.filter((id) => id !== curatedId)];
      curatedHits += recallAtK(ranking, lq.relevantIds, 1);
      derivedHits += recallAtK(ranking, derived[lq.id]!, 1);
    }
    const curatedRecall1 = curatedHits / LABELLED_QUERIES.length;
    const derivedRecall1 = derivedHits / LABELLED_QUERIES.length;

    expect(curatedRecall1).toBe(1); // oracle + curated labels = perfect by construction
    expect(derivedRecall1).toBeLessThan(curatedRecall1); // reverting to overlap labels changes it
  });
});
