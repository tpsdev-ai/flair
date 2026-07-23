import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  yesNoScore,
  applyRerank,
  isRerankEnabled,
  getRerankTopN,
  getRerankBudgetMs,
  getRerankMinCandidates,
  getRerankStatus,
  rerankCandidates,
  truncateChars,
  truncateTokenBudget,
  needsReinit,
} from "../../resources/rerank-provider";

// These tests exercise the DETERMINISTIC scoring + reorder + config paths
// without loading a 600MB GGUF. Given fixed yes/no probabilities the generative
// reranker's score is exact, and the reorder/field-preservation contract is the
// load-bearing piece the recall-bench reads (mirrors the pilot's deterministic
// measurement approach).

describe("yesNoScore (generative P(yes)/(P(yes)+P(no)))", () => {
  test("all yes mass → 1.0", () => {
    expect(yesNoScore(1, 0)).toBe(1);
  });
  test("all no mass → 0.0", () => {
    expect(yesNoScore(0, 1)).toBe(0);
  });
  test("equal mass → 0.5", () => {
    expect(yesNoScore(0.4, 0.4)).toBeCloseTo(0.5, 6);
  });
  test("renormalizes when yes/no don't sum to 1 (other tokens carry mass)", () => {
    // P(yes)=0.3, P(no)=0.1, remaining 0.6 on other tokens → 0.3/0.4 = 0.75
    expect(yesNoScore(0.3, 0.1)).toBeCloseTo(0.75, 6);
  });
  test("zero mass on both → 0 (no division by zero)", () => {
    expect(yesNoScore(0, 0)).toBe(0);
  });
  test("matches the pilot's A::1 flip (low yes vs higher distractor → still discriminates)", () => {
    // Pilot: A::1 correct score 0.7409. A score this high beats a distractor at
    // 0.42 (the documented +0.321 margin). Sanity that the formula reproduces it.
    const correct = yesNoScore(0.74, 0.26);
    const distractor = yesNoScore(0.42, 0.58);
    expect(correct - distractor).toBeGreaterThan(0.3);
  });
});

describe("applyRerank (reorder + _score overwrite + _semScore preserve)", () => {
  const mk = () => [
    { id: "a", content: "alpha", _score: 0.9, _rawScore: 0.95 },
    { id: "b", content: "bravo", _score: 0.8, _rawScore: 0.8 },
    { id: "c", content: "charlie", _score: 0.7, _rawScore: 0.7 },
  ];

  test("reorders by rerank score (not vector order)", () => {
    // Vector order is a>b>c. Rerank says c is best, then a, then b.
    const out = applyRerank(mk(), [0.2, 0.1, 0.99], 3);
    expect(out.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  test("overwrites _score with the rerank score (the field recall-bench reads)", () => {
    const out = applyRerank(mk(), [0.2, 0.1, 0.99], 3);
    const c = out.find((r) => r.id === "c")!;
    expect(c._score).toBe(0.99);
  });

  test("preserves original semantic score as _semScore", () => {
    const out = applyRerank(mk(), [0.2, 0.1, 0.99], 3);
    const a = out.find((r) => r.id === "a")! as any;
    expect(a._semScore).toBe(0.9); // its original vector _score
  });

  test("does NOT mutate _rawScore (recall-bench scoring:raw must stay reproducible)", () => {
    const out = applyRerank(mk(), [0.2, 0.1, 0.99], 3);
    expect(out.find((r) => r.id === "a")!._rawScore).toBe(0.95);
    expect(out.find((r) => r.id === "b")!._rawScore).toBe(0.8);
    expect(out.find((r) => r.id === "c")!._rawScore).toBe(0.7);
  });

  test("rounds rerank score to 3 decimals (matches _score convention)", () => {
    const out = applyRerank(mk(), [0.123456, 0.2, 0.3], 3);
    const a = out.find((r) => r.id === "a")!;
    expect(a._score).toBe(0.123);
  });

  test("topN caps which candidates get reranked; tail keeps vector order after the block", () => {
    // Only the first 2 are reranked; c stays as the untouched tail.
    const out = applyRerank(mk(), [0.1, 0.99], 2);
    // b (0.99) and a (0.1) reranked → b, a; then untouched tail c.
    expect(out.map((r) => r.id)).toEqual(["b", "a", "c"]);
    // c untouched: no _semScore stamped, _score unchanged.
    const c = out.find((r) => r.id === "c")! as any;
    expect(c._semScore).toBeUndefined();
    expect(c._score).toBe(0.7);
  });

  test("missing scores default to 0 (defensive)", () => {
    const out = applyRerank(mk(), [], 3);
    expect(out.every((r) => r._score === 0)).toBe(true);
  });
});

describe("config readers (FLAIR_RERANK_* env, default OFF)", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    "FLAIR_RERANK_ENABLED",
    "FLAIR_RERANK_TOPN",
    "FLAIR_RERANK_BUDGET_MS",
    "FLAIR_RERANK_MIN_CANDIDATES",
    "FLAIR_RERANK_MODEL",
  ];
  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("disabled by default (unset)", () => {
    expect(isRerankEnabled()).toBe(false);
  });
  test("enabled only by the literal 'true'", () => {
    process.env.FLAIR_RERANK_ENABLED = "true";
    expect(isRerankEnabled()).toBe(true);
    process.env.FLAIR_RERANK_ENABLED = "1";
    expect(isRerankEnabled()).toBe(false);
    process.env.FLAIR_RERANK_ENABLED = "TRUE";
    expect(isRerankEnabled()).toBe(false);
  });
  test("topN defaults to 50", () => {
    expect(getRerankTopN()).toBe(50);
  });
  test("topN honors a valid override", () => {
    process.env.FLAIR_RERANK_TOPN = "20";
    expect(getRerankTopN()).toBe(20);
  });
  test("topN ignores garbage / non-positive", () => {
    process.env.FLAIR_RERANK_TOPN = "nope";
    expect(getRerankTopN()).toBe(50);
    process.env.FLAIR_RERANK_TOPN = "0";
    expect(getRerankTopN()).toBe(50);
    process.env.FLAIR_RERANK_TOPN = "-5";
    expect(getRerankTopN()).toBe(50);
  });
  test("budget defaults to 2500ms", () => {
    expect(getRerankBudgetMs()).toBe(2500);
  });
  test("budget honors a valid override", () => {
    process.env.FLAIR_RERANK_BUDGET_MS = "1000";
    expect(getRerankBudgetMs()).toBe(1000);
  });
  test("minCandidates defaults to 2 and floors at 2", () => {
    expect(getRerankMinCandidates()).toBe(2);
    process.env.FLAIR_RERANK_MIN_CANDIDATES = "1";
    expect(getRerankMinCandidates()).toBe(2); // can't go below 2 (nothing to reorder)
    process.env.FLAIR_RERANK_MIN_CANDIDATES = "5";
    expect(getRerankMinCandidates()).toBe(5);
  });
  test("status reflects config + starts uninitialized", () => {
    const s = getRerankStatus();
    expect(s.enabled).toBe(false);
    expect(s.topN).toBe(50);
    expect(s.budgetMs).toBe(2500);
    // model resolves to the WORKING default (flair#811: jina's rank path
    // completes inside Harper; qwen3's generative path doesn't — see
    // resources/rerank-provider.ts's file header).
    expect(s.model).toBe("jina-reranker-v2");
  });
  test("unknown FLAIR_RERANK_MODEL falls back to the working default", () => {
    process.env.FLAIR_RERANK_MODEL = "does-not-exist";
    expect(getRerankStatus().model).toBe("jina-reranker-v2");
  });
  test("qwen3 is still selectable explicitly (kept available, EXPERIMENTAL)", () => {
    process.env.FLAIR_RERANK_MODEL = "qwen3-reranker-0.6b-q8";
    expect(getRerankStatus().model).toBe("qwen3-reranker-0.6b-q8");
  });
});

describe("truncateChars (context-budget truncation, flair#811 layer 1)", () => {
  test("long text is truncated to the char budget", () => {
    const long = "x".repeat(5000);
    const out = truncateChars(long, 2000);
    expect(out.length).toBe(2000);
    expect(out).toBe("x".repeat(2000));
  });

  test("short text is returned UNCHANGED (same reference, no copy)", () => {
    const short = "a short memory note";
    const out = truncateChars(short, 2000);
    expect(out).toBe(short);
  });

  test("text exactly at the budget is unchanged", () => {
    const exact = "y".repeat(2000);
    expect(truncateChars(exact, 2000)).toBe(exact);
  });

  test("negative/zero budget never throws, clamps to empty", () => {
    expect(truncateChars("hello", 0)).toBe("");
    expect(truncateChars("hello", -5)).toBe("");
  });
});

describe("truncateTokenBudget (context-budget truncation, flair#811 layer 2 core)", () => {
  test("long token array is truncated to the budget", () => {
    const tokens = Array.from({ length: 500 }, (_, i) => i);
    const out = truncateTokenBudget(tokens, 100);
    expect(out.length).toBe(100);
    expect(out).toEqual(tokens.slice(0, 100));
  });

  test("short token array is returned UNCHANGED (same reference)", () => {
    const tokens = [1, 2, 3];
    expect(truncateTokenBudget(tokens, 100)).toBe(tokens);
  });

  test("token array exactly at the budget is unchanged", () => {
    const tokens = [1, 2, 3];
    expect(truncateTokenBudget(tokens, 3)).toBe(tokens);
  });

  test("negative/zero budget never throws, clamps to empty", () => {
    expect(truncateTokenBudget([1, 2, 3], 0)).toEqual([]);
    expect(truncateTokenBudget([1, 2, 3], -5)).toEqual([]);
  });
});

describe("needsReinit (config-change reinit decision, flair#811 point 3)", () => {
  // The bug: ensureInit() used to short-circuit on _state === "ready" or
  // "failed" UNCONDITIONALLY, so a later FLAIR_RERANK_MODEL change had no
  // effect for the life of the process ("configured model X, served model
  // Y" could persist silently). needsReinit() is the fix's decision core.
  test("never initialized -> always reinit, regardless of cached/requested keys", () => {
    expect(needsReinit("uninitialized", "", "jina-reranker-v2")).toBe(true);
    expect(needsReinit("uninitialized", "jina-reranker-v2", "jina-reranker-v2")).toBe(true);
  });

  test("same model, ready -> no-op (don't reload a loaded GGUF)", () => {
    expect(needsReinit("ready", "jina-reranker-v2", "jina-reranker-v2")).toBe(false);
  });

  test("same model, failed -> no-op (don't retry-storm a config that's still broken)", () => {
    expect(needsReinit("failed", "jina-reranker-v2", "jina-reranker-v2")).toBe(false);
  });

  test("different model, ready -> reinit (config changed away from a working model)", () => {
    expect(needsReinit("ready", "jina-reranker-v2", "qwen3-reranker-0.6b-q8")).toBe(true);
  });

  test("different model, failed -> reinit (config changed; give the new config its own attempt)", () => {
    expect(needsReinit("failed", "qwen3-reranker-0.6b-q8", "jina-reranker-v2")).toBe(true);
  });
});

describe("rerankCandidates fail-open contract (engine-free paths only)", () => {
  // These cases return BEFORE ensureInit() touches the native engine, so they
  // are hermetic — they don't depend on whether a reranker GGUF is provisioned
  // (and never load llama.cpp, which would crash bun's native teardown).
  test("returns input unchanged when < 2 candidates (nothing to reorder)", async () => {
    const one = [{ id: "x", content: "solo", _score: 0.5 }];
    const out = await rerankCandidates("q", one, { topN: 50, budgetMs: 2500 });
    expect(out).toBe(one);
  });

  test("returns input unchanged when topN clamps the pool below 2", async () => {
    const cands = [
      { id: "a", content: "alpha", _score: 0.9 },
      { id: "b", content: "bravo", _score: 0.8 },
    ];
    // topN=1 → only 1 candidate would be reranked → skip (nothing to reorder).
    const out = await rerankCandidates("q", cands, { topN: 1, budgetMs: 2500 });
    expect(out).toBe(cands);
    expect(out.map((r) => r._score)).toEqual([0.9, 0.8]);
  });
});
