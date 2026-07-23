/**
 * rerank-provider.ts
 *
 * In-process cross-encoder reranker for Flair's recall path. Mirrors the
 * embeddings-provider.ts shape: dynamic import of node-llama-cpp (deferred to
 * first use to dodge Harper 5.x's VM-sandbox linker race), lazy singleton init,
 * and graceful passthrough on ANY failure — the reranker is best-effort and must
 * NEVER block or break recall.
 *
 * Two inference modes (selected by FLAIR_RERANK_MODEL):
 *
 *  1. "jina-reranker-v2" (DEFAULT, working) — jina-reranker-v2 IS a rank-pooling
 *     cross-encoder; its gpustack GGUF loads via createRankingContext()/rankAll
 *     (supportsRanking=true). ~145ms / 16 docs in the offline pilot (7/8,
 *     leaves the hardest consensus case negative — weaker than qwen3's
 *     generative path in that pilot, but it's the path that actually PRODUCES
 *     a score inside Harper's process — see #811 / point 2 below).
 *
 *  2. "qwen3-reranker-0.6b-q8" (EXPERIMENTAL, quality-if-it-worked) —
 *     Qwen3-Reranker-0.6B is a causal-LM reranker, NOT a rank-pooling
 *     cross-encoder. Its GGUF reports supportsRanking=false, so
 *     createRankingContext() rejects it; the intended path is generative:
 *     format query+doc into the official instruction prompt ending at the
 *     assistant turn, evaluate, and read the next-token probability of "yes"
 *     vs "no": score = P(yes) / (P(yes) + P(no)), via seq.controlledEvaluate
 *     with generateNext probabilities. Validated OFFLINE, standalone, in
 *     RERANK-PILOT-RESULTS.md (4/4 target cases flipped positive, p@1
 *     6/8→8/8, mean margin 0.028→0.688, ~1.2s / 16 docs on rockit) — but
 *     flair#811 found that INSIDE Harper's resource runtime,
 *     controlledEvaluate reliably returns empty logits (no decoded output),
 *     so every generative call throws "generative reranker produced no
 *     logits" and falls open. Root cause per docs/rerank-provisioning.md's
 *     "Known limitation": HFE's embedding engine has already initialized a
 *     separate native llama backend in the same process before this
 *     provider's own dynamic import runs, and the low-level
 *     controlledEvaluate + custom-sampler logit readout the generative path
 *     needs doesn't survive that dual-backend residency (ordinary model
 *     loading and the jina rank-pooling call both work fine across it — only
 *     this specific low-level readout is affected). Kept available and
 *     documented for whoever revisits dual-backend isolation; NOT the
 *     default until that's fixed.
 *
 * Context-budget truncation (flair#811 point 1): real memory content is
 * routinely far longer than either model's small context window. Every
 * (query, doc) pair is bounded BEFORE it reaches the engine — a cheap char
 * pre-cut (`truncateChars`, avoids tokenizing pathological multi-MB content)
 * followed by an exact token-level cut (`truncateForModel`, uses the loaded
 * model's own tokenizer — the real guarantee, since char/token ratio varies
 * a lot across prose/code/CJK/emoji). Budgets are derived from the context
 * size each mode actually requests (both NUMERIC, not "auto" — node-llama-cpp
 * grants a numeric contextSize exactly as asked, see GENERATIVE_CONTEXT_SIZE/
 * RANK_CONTEXT_SIZE below) minus reserved template + query overhead. This
 * makes the `rankAll`/context-overflow throw effectively unreachable in
 * normal operation instead of guaranteed on any real-length memory.
 *
 * Config re-validated on every use (flair#811 point 3): `ensureInit()` used
 * to cache `_modelKey`/`_state` permanently on first call — a later change to
 * FLAIR_RERANK_MODEL (or a transient first-call failure) had NO effect for
 * the lifetime of the process, since `_state === "ready"` (or `"failed"`)
 * short-circuited every subsequent call without re-reading env. `needsReinit()`
 * now compares the currently-resolved model key against what's actually
 * loaded and re-initializes (disposing old handles first) whenever they
 * differ, so "configured model X, served model Y" can no longer persist
 * silently across calls. This is the most likely, directly-fixable
 * code-level cause of the model-mismatch symptom reported in #811; without a
 * live process repro we can't rule out an additional contributing factor,
 * but this closes the gap regardless of the exact prior trigger.
 *
 * Serving path = the same in-process node-llama-cpp the embedding engine ships.
 * No Ollama (no logprobs, no rerank endpoint — verified), no network hop, no
 * new auth boundary.
 *
 * GGUF files are NOT committed; they are provisioned into models/ alongside the
 * embedding GGUF. See docs/rerank-provisioning.md for download sources.
 */

import { join } from "node:path";

type InitState = "uninitialized" | "ready" | "failed";

// Generative (Qwen3) vs rank-pooling (jina) inference mode.
type RerankMode = "generative" | "rank";

interface ModelSpec {
  /** GGUF filename expected under models/ */
  file: string;
  mode: RerankMode;
}

// Known reranker models → GGUF filename + inference mode. jina is the DEFAULT
// (working — see file header, flair#811): its rank-pooling path completes
// inside Harper. qwen3 is EXPERIMENTAL: its generative path is validated
// offline but reliably fails open inside Harper today (empty logits).
const MODELS: Record<string, ModelSpec> = {
  "jina-reranker-v2": { file: "jina-reranker-v2-base.Q8_0.gguf", mode: "rank" },
  "qwen3-reranker-0.6b-q8": { file: "Qwen3-Reranker-0.6B-q8_0.gguf", mode: "generative" },
};

const DEFAULT_MODEL = "jina-reranker-v2";

// Official Qwen3-Reranker prompt scaffold (generative yes/no judgement).
const QWEN_PREFIX =
  '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n';
const QWEN_SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n";
const QWEN_INSTRUCT = "Given a web search query, retrieve relevant passages that answer the query";

function buildQwenPrompt(q: string, doc: string): string {
  return `${QWEN_PREFIX}<Instruct>: ${QWEN_INSTRUCT}\n<Query>: ${q}\n<Document>: ${doc}${QWEN_SUFFIX}`;
}

// ── Context-budget truncation (flair#811 point 1) ──────────────────────────
// See the file header for the two-layer rationale. Budgets are derived from
// the context size each mode actually requests, minus reserved overhead —
// not a flat guess detached from either number.

/** Context size requested for the generative (Qwen3) context. NUMERIC (not
 * "auto"), so node-llama-cpp grants exactly this many tokens — verified
 * against node-llama-cpp 3.18.1's resolveContextContextSizeOption: a numeric
 * contextSize is granted as-is (or context creation throws
 * InsufficientMemoryError); only "auto"/object requests get VRAM-adaptive
 * shrinking. */
const GENERATIVE_CONTEXT_SIZE = 1024;
/** Context size requested for the rank (jina) context — see
 * createRankingContext() below. Also numeric, same guarantee. */
const RANK_CONTEXT_SIZE = 2048;

/** Reserved tokens for the Qwen3 prompt scaffold (QWEN_PREFIX + INSTRUCT +
 * SUFFIX + <|im_start|>/<|im_end|> special tokens). Rough estimate from the
 * literal scaffold text is ~130-140 tokens; 180 leaves real headroom above
 * that estimate rather than sitting right on top of it — we don't have the
 * actual Qwen3-Reranker tokenizer available to measure exactly (no GGUF in
 * this worktree), so this errs generous. Belt-and-suspenders: scoreGenerative
 * also hard-checks the FINAL built prompt against GENERATIVE_CONTEXT_SIZE
 * and throws (fail-open) rather than proceeding if this margin ever isn't
 * enough — see there. */
const GENERATIVE_TEMPLATE_OVERHEAD_TOKENS = 180;
/** Rank mode's DEFAULT template (no GGUF `chat_template.rerank` metadata) is
 * just BOS + EOS + SEP + EOS — ~4 tokens. But if the loaded GGUF DOES carry
 * a custom rerank template (LlamaRankingContext prefers it when present),
 * that template's literal text adds more; we can't inspect the actual jina
 * GGUF's metadata from this worktree (no model files here), so this reserves
 * well above the no-template case. If the real template needs more than
 * this, `rankAll()` still throws its own clean, caught error (existing
 * fail-open path) rather than corrupting anything. */
const RANK_TEMPLATE_OVERHEAD_TOKENS = 64;
/** Queries are normally a handful of words. Bounding them caps the worst
 * case so a pathologically long query can never eat the whole doc budget or
 * overflow the context on its own. */
const MAX_QUERY_TOKENS = 128;

/** Per-mode doc token budgets: context size minus template overhead minus
 * the reserved query budget. This is the number `truncateForModel()` enforces
 * exactly (via the model's own tokenizer) for candidate document text. */
const GENERATIVE_DOC_BUDGET_TOKENS =
  GENERATIVE_CONTEXT_SIZE - GENERATIVE_TEMPLATE_OVERHEAD_TOKENS - MAX_QUERY_TOKENS;
const RANK_DOC_BUDGET_TOKENS = RANK_CONTEXT_SIZE - RANK_TEMPLATE_OVERHEAD_TOKENS - MAX_QUERY_TOKENS;

// Cheap CHAR pre-cuts — layer 1 (see file header). Deliberately generous
// (not a tight token-accurate estimate): their only job is keeping us from
// ever tokenizing a pathological multi-MB memory blob before layer 2
// (`truncateForModel`'s exact token-level cut) does the real enforcement.
const GENERATIVE_DOC_CHAR_PRECUT = 2000;
const RANK_DOC_CHAR_PRECUT = 5000;
const QUERY_CHAR_PRECUT = 800;

/** Pure, trivial char-length cap — layer 1 of truncation. Returns `text`
 * UNCHANGED (same reference) when already within budget, so callers can
 * skip unnecessary work; otherwise returns the first `maxChars` characters.
 * Exported for unit testing (see test/unit/rerank-provider.test.ts). */
export function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars));
}

/** Pure, trivial token-array cap — layer 2's core slice. Exported for unit
 * testing independent of a real tokenizer. */
export function truncateTokenBudget(tokens: readonly number[], maxTokens: number): number[] {
  if (tokens.length <= maxTokens) return tokens as number[];
  return tokens.slice(0, Math.max(0, maxTokens));
}

let _state: InitState = "uninitialized";
let _initError: string | undefined;
let _warnedOnce = false;
let _modelKey = "";
let _mode: RerankMode | undefined;

// node-llama-cpp handles (kept alive as a singleton like the embedding engine).
let _nlc: any = null;
let _llama: any = null;
let _model: any = null;
// generative mode handles
let _ctx: any = null;
let _seq: any = null;
let _yesToks: number[] = [];
let _noToks: number[] = [];
// rank mode handle
let _rankCtx: any = null;

// Diagnostics surfaced via getRerankStatus() / health.ts.
let _lastLatencyMs: number | null = null;
let _fallbackCount = 0;
let _rerankCount = 0;

function resolveModelKey(): string {
  const requested = process.env.FLAIR_RERANK_MODEL?.trim();
  if (requested && MODELS[requested]) return requested;
  return DEFAULT_MODEL;
}

/**
 * Decide whether `ensureInit()` needs to (re)run the engine init sequence —
 * the flair#811 point-3 fix. Pure so the decision matrix is directly
 * unit-testable without touching the native engine.
 *
 * - Never initialized → always init.
 * - Currently loaded model differs from what's now configured → always
 *   (re)init, regardless of whether the PREVIOUS attempt was "ready" or
 *   "failed" — a config change deserves a fresh attempt under the new
 *   config. This is the fix: the old code short-circuited on `_state ===
 *   "ready"`/`"failed"` unconditionally, so a later FLAIR_RERANK_MODEL
 *   change (or a transient first-call failure under a config that was since
 *   corrected) had NO effect for the life of the process.
 * - Same model, already "ready" → no-op (don't reload a loaded GGUF).
 * - Same model, already "failed" → no-op (don't retry-storm a config that's
 *   still broken; avoids hammering a persistently-unavailable engine on
 *   every search).
 */
export function needsReinit(state: InitState, cachedModelKey: string, requestedModelKey: string): boolean {
  if (state === "uninitialized") return true;
  if (cachedModelKey !== requestedModelKey) return true;
  return false;
}

/** Discover the platform addon binary the same way embeddings-provider.ts does. */
async function findAddonPath(): Promise<string | undefined> {
  const { existsSync } = await import("node:fs");
  const platforms = ["linux-x64", "mac-arm64-metal", "mac-arm64", "win-x64", "linux-arm64", "mac-x64"];
  for (const platform of platforms) {
    const candidate = join(
      process.cwd(),
      "node_modules",
      "@node-llama-cpp",
      platform,
      "bins",
      platform,
      "llama-addon.node",
    );
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function ensureInit(): Promise<void> {
  const requested = resolveModelKey();
  if (!needsReinit(_state, _modelKey, requested)) return;

  // Reinitializing under a new config (or first-ever init) — drop any
  // previously loaded engine handles and let a fresh init attempt warn again
  // if IT fails too (a new config's failure is a new fact, not a repeat of
  // the old one).
  if (_state === "ready") await disposeHandles().catch(() => {});
  _state = "uninitialized";
  _warnedOnce = false;

  try {
    _modelKey = requested;
    const spec = MODELS[_modelKey];
    _mode = spec.mode;

    const { existsSync } = await import("node:fs");
    const modelPath = join(process.cwd(), "models", spec.file);
    if (!existsSync(modelPath)) {
      throw new Error(
        `reranker GGUF not found: models/${spec.file} (provision per docs/rerank-provisioning.md)`,
      );
    }

    // Dynamic import — deferred to avoid Harper 5.x VM linker race (same reason
    // embeddings-provider.ts defers harper-fabric-embeddings).
    if (!_nlc) _nlc = await import("node-llama-cpp");

    // node-llama-cpp finds its prebuilt binary from process.cwd()/node_modules
    // when run inside the Flair app dir (Harper's runtime cwd). We don't need to
    // pass the addon path explicitly to getLlama() — but we surface it for
    // diagnostics and as a guard that a binary exists at all.
    const addonPath = await findAddonPath();
    if (!addonPath) {
      throw new Error("no @node-llama-cpp platform addon found under node_modules");
    }

    _llama = await _nlc.getLlama();
    _model = await _llama.loadModel({ modelPath });

    if (_mode === "generative") {
      _ctx = await _model.createContext({ contextSize: GENERATIVE_CONTEXT_SIZE });
      _seq = _ctx.getSequence();
      // Resolve yes/no token ids (both case variants — the post-</think>
      // position puts mass on "yes"/"Yes").
      _yesToks = [_model.tokenize("yes", false)[0], _model.tokenize("Yes", false)[0]].filter(
        (t: number) => t != null,
      );
      _noToks = [_model.tokenize("no", false)[0], _model.tokenize("No", false)[0]].filter(
        (t: number) => t != null,
      );
      if (_yesToks.length === 0 || _noToks.length === 0) {
        throw new Error("failed to resolve yes/no token ids for generative reranker");
      }
    } else {
      // rank-pooling cross-encoder (jina). Reject if the GGUF isn't a ranking model.
      if (!_model.fileInsights?.supportsRanking) {
        throw new Error(`model ${spec.file} does not support ranking (not a rank-pooling cross-encoder)`);
      }
      // Context must fit query + the longest document (jina concatenates
      // them). 512 is too small for real memories; RANK_CONTEXT_SIZE (2048)
      // is what RANK_DOC_BUDGET_TOKENS/truncateForModel() are derived from —
      // see the file header.
      _rankCtx = await _model.createRankingContext({ contextSize: RANK_CONTEXT_SIZE });
    }

    _state = "ready";
  } catch (err: any) {
    _state = "failed";
    _initError = err?.message || String(err);
    if (!_warnedOnce) {
      console.warn(
        `[rerank] WARN: reranker unavailable, recall falls back to vector order. Error: ${_initError}`,
      );
      _warnedOnce = true;
    }
    // Best-effort cleanup of any partial handles.
    await disposeHandles().catch(() => {});
  }
}

async function disposeHandles(): Promise<void> {
  try {
    if (_rankCtx) { await _rankCtx.dispose(); _rankCtx = null; }
    if (_ctx) { await _ctx.dispose(); _ctx = null; _seq = null; }
    if (_model) { await _model.dispose(); _model = null; }
  } catch { /* ignore */ }
}

/** Reset (or recreate) the shared generative sequence to a clean KV state. */
async function resetSequence(): Promise<void> {
  try {
    if (_seq && typeof _seq.clearHistory === "function") {
      await _seq.clearHistory();
      return;
    }
  } catch { /* fall through to recreate */ }
  // clearHistory unavailable or threw — recreate the sequence from the context.
  try { _seq?.dispose?.(); } catch { /* ignore */ }
  _seq = _ctx.getSequence();
}

/**
 * Bound `text` to at most `maxTokens` tokens using the loaded model's own
 * tokenizer — layer 2 of the truncation scheme (see file header). Layer 1's
 * cheap char pre-cut runs first (`truncateChars`, avoids tokenizing
 * pathological multi-MB content); if the pre-cut string still tokenizes over
 * budget (dense code/CJK/emoji content packs more tokens per char than the
 * pre-cut assumes), the token array itself is cut and detokenized back to
 * text. This is the actual guarantee: whatever this returns tokenizes to
 * AT MOST `maxTokens` tokens (specialTokens=false — plain content text, no
 * markup interpretation), full stop. Not exported/pure (needs `_model`); its
 * two building blocks (`truncateChars`, `truncateTokenBudget`) are each unit
 * tested directly.
 */
function truncateForModel(text: string, maxChars: number, maxTokens: number): string {
  const precut = truncateChars(text, maxChars);
  const tokens = _model.tokenize(precut, false);
  if (tokens.length <= maxTokens) return precut;
  const bounded = truncateTokenBudget(Array.from(tokens), maxTokens);
  return _model.detokenize(bounded, false);
}

/** Generative yes/no score for one (query, doc) pair. */
async function scoreGenerative(q: string, doc: string): Promise<number> {
  // Bound query + doc BEFORE building the prompt (flair#811 point 1) — see
  // truncateForModel's doc and the file header for the two-layer rationale.
  // Each is tokenized/bounded independently, then concatenated into the
  // template; GENERATIVE_TEMPLATE_OVERHEAD_TOKENS' margin absorbs the small
  // boundary-tokenization variance a separate-then-concatenate cut can
  // introduce (BPE isn't always compositional across a splice point).
  const boundedQuery = truncateForModel(q, QUERY_CHAR_PRECUT, MAX_QUERY_TOKENS);
  const boundedDoc = truncateForModel(doc, GENERATIVE_DOC_CHAR_PRECUT, GENERATIVE_DOC_BUDGET_TOKENS);
  const tokens = _model.tokenize(buildQwenPrompt(boundedQuery, boundedDoc), true);
  // Belt-and-suspenders: the per-field bounding above reserves
  // GENERATIVE_TEMPLATE_OVERHEAD_TOKENS of margin for the template, but a
  // splice-boundary tokenization surprise is still conceivable. We can't
  // truncate the COMBINED prompt itself (it would cut the required
  // assistant-turn suffix the model needs to answer at the right position),
  // so if it's still over budget here, throw cleanly and let the caller fall
  // open — better than handing an oversized prompt to controlledEvaluate,
  // which doesn't throw on overflow the way rankAll does and could silently
  // context-shift/corrupt instead (a plausible contributor to the "empty
  // logits" symptom in #811, alongside the documented dual-backend issue).
  if (tokens.length > GENERATIVE_CONTEXT_SIZE) {
    throw new Error(
      `generative reranker prompt (${tokens.length} tokens) exceeds context size (${GENERATIVE_CONTEXT_SIZE}) after truncation`,
    );
  }
  // Reset the sequence so each pair is scored independently (deterministic) and
  // a prior eval can't poison this one ("Eval has failed" after a bad state).
  await resetSequence();
  const input = tokens.map((t: number, i: number) =>
    i === tokens.length - 1 ? [t, { generateNext: { probabilities: true } }] : t,
  );
  const out = await _seq.controlledEvaluate(input);
  const lastDefined = [...out].reverse().find((x: any) => x !== undefined);
  const probs = lastDefined?.next?.probabilities;
  // Defensive: under some runtimes (observed in Harper's resource worker with a
  // second native llama backend already resident — HFE's raw-addon embedding
  // engine) controlledEvaluate returns an empty result array (no decoded
  // logits). Treat that as "can't score" and signal the caller to fall open,
  // rather than silently returning 0 (which would corrupt the ranking).
  if (out.length === 0 || !probs) {
    throw new Error("generative reranker produced no logits (empty controlledEvaluate result)");
  }
  const pYes = _yesToks.reduce((s, t) => s + (probs.get(t) ?? 0), 0);
  const pNo = _noToks.reduce((s, t) => s + (probs.get(t) ?? 0), 0);
  return pYes + pNo > 0 ? pYes / (pYes + pNo) : 0;
}

// Serialize all engine work. node-llama-cpp's context/sequence is single-use:
// concurrent controlledEvaluate calls on the shared sequence corrupt the KV
// cache ("Eval has failed"). Harper calls SemanticSearch.post() concurrently,
// so we funnel every rerank through one in-process queue. Each search still
// gets the full engine; they just don't overlap on the hardware. The latency
// budget in rerankCandidates bounds how long any one search waits.
let _engineChain: Promise<unknown> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = _engineChain.then(fn, fn);
  // Keep the chain alive regardless of this task's outcome.
  _engineChain = next.then(() => undefined, () => undefined);
  return next;
}

/**
 * Score query against a batch of documents. Returns an array of scores in the
 * same order as `docs`, in [0,1]. Higher = more relevant. Throws on engine
 * error (caller catches and falls back to vector order). Engine access is
 * serialized — see runExclusive.
 */
export async function rerankScores(query: string, docs: string[]): Promise<number[]> {
  await ensureInit();
  if (_state !== "ready") throw new Error("reranker not ready");

  if (_mode === "rank") {
    // Bound query + every doc BEFORE rankAll (flair#811 point 1) — rankAll
    // computes ALL documents' token lengths up front and throws "The input
    // lengths of some of the given documents exceed the context size" if
    // ANY one exceeds RANK_CONTEXT_SIZE (verified against node-llama-cpp
    // 3.18.1's LlamaRankingContext.rankAll). truncateForModel makes that
    // effectively unreachable instead of routine on real memory content.
    const boundedQuery = truncateForModel(query, QUERY_CHAR_PRECUT, MAX_QUERY_TOKENS);
    const trimmed = docs.map((d) => truncateForModel(String(d ?? ""), RANK_DOC_CHAR_PRECUT, RANK_DOC_BUDGET_TOKENS));
    return runExclusive(() => _rankCtx.rankAll(boundedQuery, trimmed));
  }
  // generative — score sequentially under the engine lock (single shared
  // sequence; deterministic). The whole batch holds the lock for one search so
  // its sequence resets aren't interleaved with another search's.
  return runExclusive(async () => {
    const scores: number[] = [];
    for (const d of docs) {
      scores.push(await scoreGenerative(query, String(d ?? "")));
    }
    return scores;
  });
}

export interface RerankOptions {
  topN: number;
  budgetMs: number;
}

/**
 * Rerank `candidates` (each must carry `content`) against `query`. Reorders in
 * place by rerank score and overwrites `_score` with it (so downstream margin
 * measurement reads the rerank score); preserves the original semantic score as
 * `_semScore`. `_rawScore` is intentionally NOT touched (recall-bench's raw mode
 * must stay reproducible).
 *
 * FAIL-OPEN: on init failure, timeout, or any throw, returns the input array
 * UNCHANGED (caller then applies the existing vector-order sort). Never throws.
 */
export async function rerankCandidates<T extends { content?: any; _score?: number }>(
  query: string,
  candidates: T[],
  opts: RerankOptions,
): Promise<T[]> {
  const top = candidates.slice(0, Math.max(0, opts.topN));
  if (top.length < 2) return candidates;

  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const docs = top.map((c) => String(c.content ?? ""));
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(1, opts.budgetMs));
    });
    // Swallow a LATE rejection: if the budget wins the race, the scoring promise
    // is still pending and may reject afterwards — attach a no-op catch so it
    // doesn't surface as an unhandled rejection.
    const scoring = rerankScores(query, docs);
    scoring.catch(() => {});
    const scores = await Promise.race([scoring, timeout]);
    if (timer) clearTimeout(timer);

    if (scores === null) {
      // Budget exceeded — abandon rerank, keep vector order. No partial reorder.
      _fallbackCount++;
      return candidates;
    }

    // Attach rerank score, preserve the semantic score for diagnostics.
    const reranked = top.map((c, i) => {
      const sem = c._score;
      (c as any)._semScore = sem;
      (c as any)._score = Math.round((scores[i] ?? 0) * 1000) / 1000;
      return c;
    });
    reranked.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));

    // Candidates beyond topN (not reranked) keep their vector position AFTER the
    // reranked block — they were already the tail of the vector-ordered pool.
    const tail = candidates.slice(top.length);
    _lastLatencyMs = Date.now() - t0;
    _rerankCount++;
    return [...reranked, ...tail];
  } catch (err: any) {
    if (timer) clearTimeout(timer);
    _fallbackCount++;
    if (!_warnedOnce) {
      console.warn(`[rerank] WARN: rerank threw, falling back to vector order. Error: ${err?.message || err}`);
      _warnedOnce = true;
    }
    return candidates;
  }
}

/** Is the master flag on? (Default OFF.) */
export function isRerankEnabled(): boolean {
  return process.env.FLAIR_RERANK_ENABLED === "true";
}

/** Candidate count fed to the reranker. Caps the HNSW fetch. */
export function getRerankTopN(): number {
  const v = Number(process.env.FLAIR_RERANK_TOPN);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 50;
}

/** Hard latency budget for the whole rerank stage (ms). */
export function getRerankBudgetMs(): number {
  const v = Number(process.env.FLAIR_RERANK_BUDGET_MS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 2500;
}

/** Skip rerank below this many candidates (nothing to reorder). */
export function getRerankMinCandidates(): number {
  const v = Number(process.env.FLAIR_RERANK_MIN_CANDIDATES);
  return Number.isFinite(v) && v >= 2 ? Math.floor(v) : 2;
}

/** Status surface for health.ts. */
export function getRerankStatus(): {
  enabled: boolean;
  model: string;
  mode: RerankMode | "uninitialized";
  state: InitState;
  topN: number;
  budgetMs: number;
  lastLatencyMs: number | null;
  rerankCount: number;
  fallbackCount: number;
  error?: string;
} {
  return {
    enabled: isRerankEnabled(),
    model: _modelKey || resolveModelKey(),
    mode: _mode ?? "uninitialized",
    state: _state,
    topN: getRerankTopN(),
    budgetMs: getRerankBudgetMs(),
    lastLatencyMs: _lastLatencyMs,
    rerankCount: _rerankCount,
    fallbackCount: _fallbackCount,
    error: _initError,
  };
}

// ── Test seam ────────────────────────────────────────────────────────────────
// Exported pure helpers so the deterministic scoring path can be unit-tested
// without loading a 600MB GGUF (mirrors the pilot's deterministic approach:
// given fixed yes/no probabilities, the score + reorder math is exact).

/** P(yes)/(P(yes)+P(no)) — the generative reranker's scoring function. */
export function yesNoScore(pYes: number, pNo: number): number {
  return pYes + pNo > 0 ? pYes / (pYes + pNo) : 0;
}

/**
 * Pure reorder used by rerankCandidates: attach scores, overwrite `_score`,
 * preserve `_semScore`, leave `_rawScore` untouched, sort desc, append the
 * non-reranked tail. Exported for deterministic unit tests.
 */
export function applyRerank<T extends { content?: any; _score?: number; _rawScore?: number }>(
  candidates: T[],
  scores: number[],
  topN: number,
): T[] {
  const top = candidates.slice(0, Math.max(0, topN));
  const reranked = top.map((c, i) => {
    (c as any)._semScore = c._score;
    (c as any)._score = Math.round((scores[i] ?? 0) * 1000) / 1000;
    return c;
  });
  reranked.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
  return [...reranked, ...candidates.slice(top.length)];
}
