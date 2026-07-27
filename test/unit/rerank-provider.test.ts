import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  resolveRerankModelPath,
  resolveModelKey,
  isKnownRerankModel,
  rerankModelFile,
  assertRerankAvailable,
  RerankUnavailableError,
  KNOWN_RERANK_MODELS,
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
  test("unknown FLAIR_RERANK_MODEL is reported VERBATIM, not swapped for the default (flair#888)", () => {
    // Regression: this used to return "jina-reranker-v2" — a typo'd model
    // name served the default and the status surface agreed with the swap, so
    // "configured model X, served model Y" left no trace anywhere. The status
    // block must show what was ASKED for; ensureInit() is what turns the
    // unknown key into a loud failure (see the assertRerankAvailable tests).
    process.env.FLAIR_RERANK_MODEL = "does-not-exist";
    expect(resolveModelKey()).toBe("does-not-exist");
    expect(getRerankStatus().model).toBe("does-not-exist");
  });
  test("blank/whitespace FLAIR_RERANK_MODEL still means 'the default'", () => {
    process.env.FLAIR_RERANK_MODEL = "   ";
    expect(resolveModelKey()).toBe("jina-reranker-v2");
  });
  test("KNOWN_RERANK_MODELS / isKnownRerankModel agree with what can be served", () => {
    expect([...KNOWN_RERANK_MODELS].sort()).toEqual(["jina-reranker-v2", "qwen3-reranker-0.6b-q8"]);
    expect(isKnownRerankModel("jina-reranker-v2")).toBe(true);
    expect(isKnownRerankModel("does-not-exist")).toBe(false);
    // The bench derives the GGUF filename from here rather than hardcoding a
    // second copy that could drift from the provider's own map.
    expect(rerankModelFile("jina-reranker-v2")).toBe("jina-reranker-v2-base.Q8_0.gguf");
    expect(rerankModelFile("does-not-exist")).toBeUndefined();
  });
  test("qwen3 is still selectable explicitly (kept available, EXPERIMENTAL)", () => {
    process.env.FLAIR_RERANK_MODEL = "qwen3-reranker-0.6b-q8";
    expect(getRerankStatus().model).toBe("qwen3-reranker-0.6b-q8");
  });
});

describe("resolveRerankModelPath (models-dir resolution, flair#815)", () => {
  // The bug: ensureInit() hardcoded join(process.cwd(), "models", file),
  // ignoring FLAIR_MODELS_DIR — so any deployment whose cwd wasn't the models
  // location (e.g. the recall harness's ephemeral Harpers) failed init and
  // silently fell open to vector order. The fix routes through the shared
  // resolveModelsDir() (resources/models-dir.ts — the same resolution the
  // embedding engine uses; its full 4-step priority chain is covered by
  // test/unit/embeddings-models-dir.test.ts; these tests pin the two ends
  // the reranker cares about).
  const SAVED = {
    FLAIR_MODELS_DIR: process.env.FLAIR_MODELS_DIR,
    ROOTPATH: process.env.ROOTPATH,
  };
  let originalCwd: string;
  let scratch: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    // realpath so comparisons against process.cwd() hold on macOS, where
    // /var and /tmp are symlinks to /private/* (cwd reports the resolved path).
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "flair-rerank-models-dir-")));
    delete process.env.FLAIR_MODELS_DIR;
    delete process.env.ROOTPATH;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (SAVED.FLAIR_MODELS_DIR === undefined) delete process.env.FLAIR_MODELS_DIR;
    else process.env.FLAIR_MODELS_DIR = SAVED.FLAIR_MODELS_DIR;
    if (SAVED.ROOTPATH === undefined) delete process.env.ROOTPATH;
    else process.env.ROOTPATH = SAVED.ROOTPATH;
    rmSync(scratch, { recursive: true, force: true });
  });

  test("FLAIR_MODELS_DIR set → GGUF path resolves under it (not cwd)", () => {
    process.env.FLAIR_MODELS_DIR = "/opt/flair-models";
    expect(resolveRerankModelPath("jina-reranker-v2-base.Q8_0.gguf")).toBe(
      join("/opt/flair-models", "jina-reranker-v2-base.Q8_0.gguf"),
    );
  });

  test("unset, cwd has a models/ dir → falls back to <cwd>/models (backward compat)", () => {
    process.chdir(scratch);
    mkdirSync(join(scratch, "models"), { recursive: true });
    expect(resolveRerankModelPath("jina-reranker-v2-base.Q8_0.gguf")).toBe(
      join(scratch, "models", "jina-reranker-v2-base.Q8_0.gguf"),
    );
  });

  test("resolves the SAME dir as the embedding engine (alongside guarantee)", () => {
    // docs/rerank-provisioning.md: the reranker GGUF lives alongside the
    // embedding GGUF. That only holds if both read the same resolution —
    // ROOTPATH (Harper's data dir) beats a cwd models/ dir, same as embeddings.
    process.env.ROOTPATH = join(scratch, "data");
    process.chdir(scratch);
    mkdirSync(join(scratch, "models"), { recursive: true });
    expect(resolveRerankModelPath("jina-reranker-v2-base.Q8_0.gguf")).toBe(
      join(scratch, "data", "models", "jina-reranker-v2-base.Q8_0.gguf"),
    );
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

// ── flair#888: unavailability must be LOUD, ACTIONABLE and OBSERVABLE ────────
//
// Every case here reaches ensureInit() but returns BEFORE the dynamic
// `import("node-llama-cpp")` — either the model key is unknown (rejected
// first) or the GGUF is absent (existsSync check, also first). So these stay
// hermetic: no 600MB load, no native teardown crash, no dependence on whether
// a reranker is provisioned on the machine running the suite.
//
// IMPORTANT for anyone extending this block: the provider is a module
// singleton and `needsReinit()` short-circuits on an unchanged model key, so
// each test that needs a FRESH init attempt uses a DISTINCT
// FLAIR_RERANK_MODEL. Reusing a key deliberately exercises the
// don't-retry-storm path instead.
describe("reranker unavailability is never silent (flair#888)", () => {
  const SAVED: Record<string, string | undefined> = {};
  const KEYS = ["FLAIR_RERANK_MODEL", "FLAIR_MODELS_DIR", "ROOTPATH", "FLAIR_RERANK_ENABLED"];
  let emptyModelsDir: string;
  let warnings: string[];
  let realWarn: typeof console.warn;

  beforeEach(() => {
    for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
    // A models dir that provably contains no GGUF — so "the model is missing"
    // is a property of the test, not of the machine.
    emptyModelsDir = mkdtempSync(join(tmpdir(), "flair-rerank-empty-models-"));
    process.env.FLAIR_MODELS_DIR = emptyModelsDir;
    warnings = [];
    realWarn = console.warn;
    console.warn = (...args: any[]) => { warnings.push(args.join(" ")); };
  });

  afterEach(() => {
    console.warn = realWarn;
    for (const k of KEYS) {
      if (SAVED[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED[k];
    }
    rmSync(emptyModelsDir, { recursive: true, force: true });
  });

  const mkCandidates = () => [
    { id: "a", content: "alpha", _score: 0.9, _rawScore: 0.9 },
    { id: "b", content: "bravo", _score: 0.8, _rawScore: 0.8 },
    { id: "c", content: "charlie", _score: 0.7, _rawScore: 0.7 },
  ];

  test("assertRerankAvailable THROWS when the GGUF is missing, naming the path and the fixes", async () => {
    process.env.FLAIR_RERANK_MODEL = "jina-reranker-v2";
    let err: any;
    try { await assertRerankAvailable(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RerankUnavailableError);
    const msg = String(err.message);
    // Errors must enable a response: what's wrong, where it looked, how to fix.
    expect(msg).toContain("UNAVAILABLE");
    expect(msg).toContain(join(emptyModelsDir, "jina-reranker-v2-base.Q8_0.gguf"));
    expect(msg).toContain("docs/rerank-provisioning.md");
    expect(msg).toContain("FLAIR_MODELS_DIR");
    expect(msg).toContain("FLAIR_RERANK_ENABLED");
  });

  test("assertRerankAvailable THROWS on an unknown model key, listing the known ones", async () => {
    process.env.FLAIR_RERANK_MODEL = "totally-bogus-model";
    let err: any;
    try { await assertRerankAvailable(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RerankUnavailableError);
    const msg = String(err.message);
    expect(msg).toContain("totally-bogus-model");
    for (const known of KNOWN_RERANK_MODELS) expect(msg).toContain(known);
    // Pin the DIAGNOSIS, not merely the failure. Without the explicit
    // unknown-key check, init still fails — but on a TypeError from reading
    // `.mode` off undefined, and an operator handed "Cannot read properties
    // of undefined" has to go read our source to learn they typo'd an env
    // var. Mutation-checked: removing that check leaves every other
    // assertion here passing.
    expect(msg).toContain("unknown reranker model");
    expect(msg).not.toContain("Cannot read properties");
  });

  test("assertRerankAvailable resolves (does NOT throw) when reranking is simply off — availability is about the engine, not the flag", async () => {
    // Guard against a lazier implementation that keys off
    // FLAIR_RERANK_ENABLED: the bench sets that flag on the SPAWNED Harper,
    // not necessarily in its own process, so conflating the two would make
    // the gate silently vacuous — the exact class of bug being fixed.
    process.env.FLAIR_RERANK_MODEL = "qwen3-reranker-0.6b-q8";
    delete process.env.FLAIR_RERANK_ENABLED;
    await expect(assertRerankAvailable()).rejects.toThrow(/UNAVAILABLE/);
  });

  test("rerankCandidates DEGRADES (returns vector order) rather than throwing", async () => {
    process.env.FLAIR_RERANK_MODEL = "jina-reranker-v2";
    const cands = mkCandidates();
    const out = await rerankCandidates("some query", cands, { topN: 50, budgetMs: 2500 });
    // Same array, untouched order, untouched scores: no partial reorder, and
    // crucially no `_semScore` stamped on records that were never reranked.
    expect(out).toBe(cands);
    expect(out.map(r => r.id)).toEqual(["a", "b", "c"]);
    expect(out.map(r => r._score)).toEqual([0.9, 0.8, 0.7]);
    expect((out[0] as any)._semScore).toBeUndefined();
  });

  test("...but the degradation is RECORDED: classified reason, detail, timestamp, counter", async () => {
    // THE REGRESSION. Before this fix the only trace of "reranking was asked
    // for and did not happen" was fallbackCount going up with no reason
    // attached, plus one console line that a long-running process emitted at
    // most once, ever. rerankCount pinned at 0 with no other signal is
    // precisely the production symptom flair#888 was filed about.
    process.env.FLAIR_RERANK_MODEL = "qwen3-reranker-0.6b-q8";
    const before = getRerankStatus().fallbackCount;
    await rerankCandidates("some query", mkCandidates(), { topN: 50, budgetMs: 2500 });
    const s = getRerankStatus();
    expect(s.fallbackCount).toBe(before + 1);
    expect(s.rerankCount).toBe(0);
    expect(s.lastFallbackReason).toBe("unavailable");
    expect(s.lastFallbackDetail).toContain("UNAVAILABLE");
    expect(s.lastFallbackDetail).toContain("Qwen3-Reranker-0.6B-q8_0.gguf");
    expect(s.lastFallbackAt).not.toBeNull();
    expect(Date.parse(s.lastFallbackAt!)).not.toBeNaN();
    // And the status block must not claim a model nobody configured.
    expect(s.model).toBe("qwen3-reranker-0.6b-q8");
  });

  test("the fallback is LOGGED, at ERROR level, with the remedy in the line", async () => {
    process.env.FLAIR_RERANK_MODEL = "jina-reranker-v2";
    await rerankCandidates("some query", mkCandidates(), { topN: 50, budgetMs: 2500 });
    const text = warnings.join("\n");
    expect(text).toContain("[rerank] ERROR:");
    expect(text).toContain("docs/rerank-provisioning.md");
    // The consequence, stated — not just the cause.
    expect(text).toContain("vector order");
  });

  test("repeat failures dedupe the LOG but never the COUNTER", async () => {
    // A search-per-second install must not spew a log line per search; it
    // must also not lose count. The counter is the signal channel, the log is
    // a convenience — so they dedupe differently, on purpose.
    process.env.FLAIR_RERANK_MODEL = "jina-reranker-v2";
    const before = getRerankStatus().fallbackCount;
    await rerankCandidates("q1", mkCandidates(), { topN: 50, budgetMs: 2500 });
    const afterFirst = warnings.length;
    await rerankCandidates("q2", mkCandidates(), { topN: 50, budgetMs: 2500 });
    await rerankCandidates("q3", mkCandidates(), { topN: 50, budgetMs: 2500 });
    expect(warnings.length).toBe(afterFirst);
    expect(getRerankStatus().fallbackCount).toBe(before + 3);
  });
});

// ── Structural tripwire: the BENCH must gate BEFORE it measures ─────────────
// flair#888's second half. A benchmark that measures a different
// configuration than the one it reports is worse than no benchmark, and the
// harness previously checked engagement only AFTER a full measurement pass —
// it caught the lie, but only once a number already existed. This pins the
// ordering in source, because no unit test can spawn the harness's ephemeral
// Harper to observe it at runtime.
describe("recall-harness --rerank gates before measuring (flair#888)", () => {
  const runTs = readFileSync(join(import.meta.dir, "../bench/recall-harness/run.ts"), "utf8");

  test("a pre-measure engagement check exists and precedes the first runQueries() call", () => {
    const preMeasure = runTs.indexOf("[pre-measure]");
    const firstMeasure = runTs.indexOf("await runQueries(");
    expect(preMeasure).toBeGreaterThan(-1);
    expect(firstMeasure).toBeGreaterThan(-1);
    expect(preMeasure).toBeLessThan(firstMeasure);
  });

  test("a post-measure check is still there too (engaged on query 1 ≠ engaged on query 126)", () => {
    expect(runTs).toContain("[post-measure]");
  });

  test("preflight refuses to start when the GGUF is absent, rather than measuring", () => {
    expect(runTs).toContain("function preflightRerank()");
    expect(runTs).toContain("REFUSING TO MEASURE");
    // Called from main() before the sweep, not merely defined.
    expect(runTs).toContain("if (WITH_RERANK) preflightRerank();");
  });

  test("the harness README no longer advertises the fail-open it just closed", () => {
    const readme = readFileSync(join(import.meta.dir, "../bench/recall-harness/README.md"), "utf8");
    expect(readme).not.toContain("silently measures the *non-reranked* config");
    expect(readme).toContain("A null result from this arm therefore means");
  });
});
