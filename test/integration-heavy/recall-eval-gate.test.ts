/**
 * recall-eval-gate.test.ts — the deterministic recall-quality CI GATE (#1216-a,
 * closes the #17 noisy-metric defect).
 *
 * Spawns a fresh ephemeral Harper, ingests the curated corpus via the shared
 * plumbing, retrieves every labelled query through Flair's real BM25+RRF at
 * documented defaults, and asserts every metric clears its floor. The floors
 * sit a margin ≥2 whole queries below the measured value — orders of magnitude
 * above the 0.000 run-to-run noise band (see labels.ts) — so a breach here is a
 * real recall regression, not sampling wobble.
 *
 * Also carries the self-pollution MUTATION-CHECK against real retrieval: the
 * same deterministic ranking scored under the curated labels vs the
 * corpus-derived (lexical-overlap) labels must give DIFFERENT numbers — proof
 * the curated labels are real and not the overlap artefact the old spot-check
 * scored on.
 *
 * MODEL-GATED: the embedding model must be present (FLAIR_MODELS_DIR or
 * <cwd>/models, where CI pre-downloads it). Without it, this skips VISIBLY
 * rather than triggering a HuggingFace pull mid-suite — the same
 * graceful-skip posture the other model-dependent lanes use. In the integration
 * lane the model IS present, so the gate fires.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { mkAgent, registerAgent, type BenchClient } from "../../packages/flair-bench/lib/index";
import { runRecallEval } from "../bench/recall-eval/eval";
import { AGENT_ID, FLOORS, deriveLexicalOverlapLabels } from "../bench/recall-eval/labels";

const MODEL_FILE = "nomic-embed-text-v1.5.Q4_K_M.gguf";
function modelPresent(): boolean {
  const dirs = [process.env.FLAIR_MODELS_DIR, path.join(process.cwd(), "models")].filter(Boolean) as string[];
  return dirs.some((d) => existsSync(path.join(d, MODEL_FILE)));
}

const HAS_MODEL = modelPresent();
const gate = HAS_MODEL ? describe : describe.skip;
if (!HAS_MODEL) {
  console.warn(`[recall-eval-gate] SKIPPING: embedding model ${MODEL_FILE} not found in FLAIR_MODELS_DIR or <cwd>/models. This gate needs it; a runner with the model runs it.`);
}

gate("deterministic recall-quality gate (#1216-a / #17)", () => {
  let harper: HarperInstance;
  let client: BenchClient;
  let curated: Awaited<ReturnType<typeof runRecallEval>>;

  beforeAll(async () => {
    const prev = process.env.FLAIR_HYBRID_RETRIEVAL;
    process.env.FLAIR_HYBRID_RETRIEVAL = "true"; // documented default
    try {
      harper = await startHarper();
    } finally {
      if (prev === undefined) delete process.env.FLAIR_HYBRID_RETRIEVAL;
      else process.env.FLAIR_HYBRID_RETRIEVAL = prev;
    }
    const agent = mkAgent(AGENT_ID);
    await registerAgent(harper, agent);
    client = { harper, agent };
    curated = await runRecallEval(client);
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper, { keepInstallDir: false });
  });

  test("ingest wrote the whole corpus with real timestamps", () => {
    expect(curated.ingest.written).toBeGreaterThan(0);
    expect(curated.ingest.syntheticTimestamps).toBe(false);
  });

  test("recall@1 clears its floor", () => {
    expect(curated.aggregate.recallAt1).toBeGreaterThanOrEqual(FLOORS.recallAt1);
  });
  test("recall@5 clears its floor", () => {
    expect(curated.aggregate.recallAt5).toBeGreaterThanOrEqual(FLOORS.recallAt5);
  });
  test("recall@10 clears its floor", () => {
    expect(curated.aggregate.recallAt10).toBeGreaterThanOrEqual(FLOORS.recallAt10);
  });
  test("nDCG@10 clears its floor", () => {
    expect(curated.aggregate.ndcgAt10).toBeGreaterThanOrEqual(FLOORS.ndcgAt10);
  });
  test("MRR clears its floor", () => {
    expect(curated.aggregate.mrr).toBeGreaterThanOrEqual(FLOORS.mrr);
  });

  test("mutation-check: corpus-derived labels score DIFFERENTLY than curated (self-pollution absent)", async () => {
    // Same deterministic retrieval, scored under the self-polluting
    // lexical-overlap labels. If the curated labels were just corpus overlap,
    // these would match. They must not: the lexical labels mislabel the
    // trap/hard queries, so scoring against them is strictly worse.
    const polluted = await runRecallEval(client, deriveLexicalOverlapLabels());
    expect(polluted.aggregate.mrr).not.toBe(curated.aggregate.mrr);
    expect(polluted.aggregate.mrr).toBeLessThan(curated.aggregate.mrr);
    expect(polluted.aggregate.recallAt1).toBeLessThan(curated.aggregate.recallAt1);
  }, 120_000);
});
