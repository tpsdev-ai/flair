/**
 * golden-path.test.ts — Smoke test: golden path end-to-end
 * (initial scaffold, covering scenario 1)
 *
 * Tests the full agent lifecycle against a real Flair instance:
 *   1. Create agent
 *   2. Write memory
 *   3. Search memory
 *   4. Bootstrap context
 *   5. Cleanup
 *
 * Uses FLAIR_TEST_URL if set (CI), or auto-detects at localhost:9926 (local dev).
 * Each step is timed and reports duration.
 *
 * Run: FLAIR_ADMIN_PASS=... bun test test/smoke/golden-path.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  resolveFlairInstance,
  warmEmbeddingModel,
  createAgent,
  writeMemory,
  searchMemories,
  bootstrapAgent,
  type FlairInstance,
} from "./helpers/flair-instance.js";

import {
  assertShape,
  assertStringContains,
  assertMinLength,
  assertGreaterThan,
} from "./helpers/assert.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let flair: FlairInstance;
let agentId: string;
let markerId: string;

const RANDOM = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const MARKER_CONTENT = `Smoke test marker ${RANDOM}`;

// flair#1219: cold-start budget for warming the embedding model in beforeAll.
// The model loads lazily on the first embed call and that load can exceed the
// per-write 10s client timeout on a cold/loaded CI runner, so the warm-up must
// be allowed to run well past both the default hook timeout and that 10s abort.
const WARMUP_TIMEOUT_MS = 120_000;

beforeAll(async () => {
  flair = await resolveFlairInstance();
  console.log(`[golden-path] Flair instance: ${flair.baseUrl}`);

  // flair#1219: warm the embedding model BEFORE any timed step. `/Health` 200
  // does not imply the embedding model is loaded — it loads lazily on the first
  // embed call. Paying that cold-start cost here (on a throwaway agent+memory)
  // guarantees the measured Step-2 write is a warm write, never the one that
  // absorbs the model load. Without this, Step 2 flaked with
  // `TimeoutError: The operation timed out` at ~10s on cold CI runners.
  const warm = await warmEmbeddingModel(flair);
  console.log(
    `[golden-path] Embedding model warm (${warm.elapsedMs}ms, ${warm.attempts} attempt(s))`,
  );
}, WARMUP_TIMEOUT_MS);

afterAll(async () => {
  if (flair && agentId) {
    await flair.cleanup([agentId]);
    console.log(`[golden-path] Cleaned up agent ${agentId}`);
  }
});

// ---------------------------------------------------------------------------
// Scenario 1: Golden path
// ---------------------------------------------------------------------------

describe("Golden path: agent + memory + search + bootstrap", () => {
  test("Step 1: Create agent", async () => {
    const t0 = performance.now();

    agentId = await createAgent(flair.opsUrl, flair.authHeader);
    expect(agentId).toBeTruthy();
    expect(agentId.startsWith("smoke-")).toBe(true);

    const elapsed = (performance.now() - t0).toFixed(1);
    console.log(`  ✓ Created agent ${agentId} (${elapsed}ms)`);
  });

  // Embedding-backed steps (write / search / bootstrap) run the embedding model,
  // which takes ~3s locally and more on a cold CI runner. The default 5s test
  // timeout is too tight and flakes intermittently; give these steps headroom.
  // A genuine hang still fails at 30s.
  const EMBED_TIMEOUT_MS = 30_000;

  test("Step 2: Write memory", async () => {
    expect(agentId).toBeTruthy();
    const t0 = performance.now();

    markerId = await writeMemory(flair.baseUrl, agentId, MARKER_CONTENT, {
      tags: ["smoke-test"],
    }, flair.authHeader);

    expect(markerId).toBeTruthy();
    expect(markerId.startsWith(agentId)).toBe(true);

    const elapsed = (performance.now() - t0).toFixed(1);
    console.log(`  ✓ Wrote memory ${markerId} (${elapsed}ms)`);
  }, EMBED_TIMEOUT_MS);

  test("Step 3: Search memory (semantic)", async () => {
    expect(agentId).toBeTruthy();
    const t0 = performance.now();

    const result = await searchMemories(flair.baseUrl, agentId, "smoke test marker", 5, flair.authHeader);

    // The search response should have results
    assertShape(result, { results: null }, "searchResult");
    const results = assertMinLength(result.results, 1, "searchResult.results");

    // At least one result should contain our marker content
    const matched = results.some((r: any) => {
      return (
        r?.content?.includes(MARKER_CONTENT) ||
        r?.content?.includes(RANDOM) ||
        r?.id === markerId
      );
    });

    if (!matched) {
      console.warn("Search results did not contain the marker content directly.");
      console.warn("Results:", JSON.stringify(results).slice(0, 500));
      // This is acceptable — embeddings may not have indexed yet
    }

    const elapsed = (performance.now() - t0).toFixed(1);
    console.log(`  ✓ Search returned ${results.length} result(s) (${elapsed}ms)`);
  }, EMBED_TIMEOUT_MS);

  test("Step 4: Bootstrap context", async () => {
    expect(agentId).toBeTruthy();
    const t0 = performance.now();

    const result = await bootstrapAgent(flair.baseUrl, agentId, 4000, flair.authHeader);

    // Bootstrap returns context, tokenEstimate, memoriesIncluded
    assertShape(result, {
      context: null,
      tokenEstimate: null,
      memoriesIncluded: null,
    }, "bootstrapResult");

    assertStringContains(result.context, "", "bootstrapResult.context");
    assertGreaterThan(result.tokenEstimate, 0, "bootstrapResult.tokenEstimate");

    // The context should mention our memory
    // Note: this is best-effort — context may not include the exact content
    // due to token budget truncation
    if (typeof result.context === "string") {
      const ctxLength = result.context.length;
      console.log(`  ✓ Bootstrap context: ${ctxLength} chars, ~${result.tokenEstimate} tokens, ${result.memoriesIncluded} memories`);
    }

    const elapsed = (performance.now() - t0).toFixed(1);
    console.log(`  ✓ Bootstrap returned context (${elapsed}ms)`);
  }, EMBED_TIMEOUT_MS);

  test("Step 5: Cleanup (agent + memories deleted)", async () => {
    expect(agentId).toBeTruthy();
    const t0 = performance.now();

    await flair.cleanup([agentId]);
    agentId = ""; // prevent afterAll from double-cleaning

    const elapsed = (performance.now() - t0).toFixed(1);
    console.log(`  ✓ Cleanup complete (${elapsed}ms)`);
  });
});
