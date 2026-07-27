import { describe, test, expect } from "bun:test";

import { rerankWarnings } from "../../resources/rerank-provider";
import type { getRerankStatus } from "../../resources/rerank-provider";

// flair#888 — /HealthDetail's rerank warnings.
//
// THE BUG THESE PIN: the previous inline version of this logic guarded its
// degradation warning on `rerankCount > 0`:
//
//     if (rr.enabled && rr.rerankCount > 0 && rr.fallbackCount > rr.rerankCount)
//
// so the single WORST state — reranking enabled, every search falling back,
// zero successful reranks — was the one state that produced no warning at
// all. "rerankCount sat at 0 while every surface looked healthy" was the
// production symptom; the health surface was structurally incapable of
// reporting it. The `neverEngaged` case below fails against that old guard.

type RerankStatus = ReturnType<typeof getRerankStatus>;

/** A status block with everything nominal; each test overrides what it means. */
function status(over: Partial<RerankStatus> = {}): RerankStatus {
  return {
    enabled: true,
    model: "jina-reranker-v2",
    mode: "rank",
    state: "ready",
    topN: 50,
    budgetMs: 2500,
    lastLatencyMs: 120,
    rerankCount: 10,
    fallbackCount: 0,
    lastFallbackReason: null,
    lastFallbackDetail: null,
    lastFallbackAt: null,
    ...over,
  };
}

const joined = (ws: { message: string }[]) => ws.map(w => w.message).join("\n");

describe("rerankWarnings — total failure must never be silent (flair#888)", () => {
  test("enabled + 0 reranks + N fallbacks WARNS (the regression: this was the silent case)", () => {
    const ws = rerankWarnings(status({ rerankCount: 0, fallbackCount: 1247, lastFallbackReason: "unavailable", lastFallbackDetail: "reranker ENABLED but UNAVAILABLE (model=\"jina-reranker-v2\"): GGUF not found" }));
    expect(ws.length).toBeGreaterThan(0);
    const text = joined(ws);
    expect(text).toContain("NEVER successfully reranked");
    // The operator needs the counts, the class of failure, and the detail —
    // "technically accurate" is not the bar; actionable is.
    expect(text).toContain("1247");
    expect(text).toContain("unavailable");
    expect(text).toContain("GGUF not found");
  });

  test("the never-engaged warning fires even when state is 'ready' (loaded, then every call threw)", () => {
    // This is the nastiest shape: init succeeded, so the state==='failed'
    // warning stays quiet, and rerankCount===0 kept the ratio warning quiet
    // too. Nothing at all was reported.
    const ws = rerankWarnings(status({ state: "ready", rerankCount: 0, fallbackCount: 300, lastFallbackReason: "error", lastFallbackDetail: "rerank threw during scoring: Eval has failed" }));
    expect(joined(ws)).toContain("NEVER successfully reranked");
  });

  test("timeouts with zero successes are reported as never-engaged too", () => {
    const ws = rerankWarnings(status({ rerankCount: 0, fallbackCount: 42, lastFallbackReason: "timeout", lastFallbackDetail: "rerank exceeded its 2500ms budget" }));
    expect(joined(ws)).toContain("NEVER successfully reranked");
    expect(joined(ws)).toContain("timeout");
  });
});

describe("rerankWarnings — the other states", () => {
  test("healthy: enabled, reranking, no fallbacks → no warnings", () => {
    expect(rerankWarnings(status())).toEqual([]);
  });

  test("disabled → no warnings regardless of counters", () => {
    expect(rerankWarnings(status({ enabled: false, rerankCount: 0, fallbackCount: 999 }))).toEqual([]);
  });

  test("enabled + never called at all (0/0) → no warning (nothing has gone wrong yet)", () => {
    expect(rerankWarnings(status({ state: "uninitialized", rerankCount: 0, fallbackCount: 0 }))).toEqual([]);
  });

  test("init failed → the unavailable warning, carrying the init error", () => {
    const ws = rerankWarnings(status({ state: "failed", rerankCount: 0, fallbackCount: 0, error: "reranker GGUF not found: /models/x.gguf" }));
    expect(joined(ws)).toContain("reranker enabled but unavailable");
    expect(joined(ws)).toContain("/models/x.gguf");
  });

  test("degrading (some successes, more fallbacks) → the ratio warning, with the reason", () => {
    const ws = rerankWarnings(status({ rerankCount: 10, fallbackCount: 40, lastFallbackReason: "timeout" }));
    const text = joined(ws);
    expect(text).toContain("falling back more than reranking");
    expect(text).toContain("timeout");
    expect(text).not.toContain("NEVER successfully reranked");
  });

  test("mostly working (more successes than fallbacks) → no warning", () => {
    expect(rerankWarnings(status({ rerankCount: 100, fallbackCount: 3 }))).toEqual([]);
  });
});
