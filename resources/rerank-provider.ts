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
 *  1. "qwen3-reranker-0.6b-q8" (DEFAULT, quality) — Qwen3-Reranker-0.6B is a
 *     causal-LM reranker, NOT a rank-pooling cross-encoder. Its GGUF reports
 *     supportsRanking=false, so node-llama-cpp's createRankingContext() rejects
 *     it. The correct path is generative: format query+doc into the official
 *     instruction prompt ending at the assistant turn, evaluate, and read the
 *     next-token probability of "yes" vs "no":
 *         score = P(yes) / (P(yes) + P(no))
 *     Implemented via seq.controlledEvaluate with generateNext probabilities.
 *     (Validated offline in RERANK-PILOT-RESULTS.md: 4/4 target cases flipped
 *     positive, p@1 6/8→8/8, mean margin 0.028→0.688, ~1.2s / 16 docs on rockit.)
 *
 *  2. "jina-reranker-v2" (latency fallback) — jina-reranker-v2 IS a rank-pooling
 *     cross-encoder; its gpustack GGUF loads via createRankingContext()/rankAll
 *     (supportsRanking=true). ~145ms / 16 docs but weaker (7/8, leaves the
 *     hardest consensus case negative). Selectable where latency is tight.
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

// Known reranker models → GGUF filename + inference mode. The default is the
// quality model (Qwen3 generative). jina is the latency model (rank API).
const MODELS: Record<string, ModelSpec> = {
  "qwen3-reranker-0.6b-q8": { file: "Qwen3-Reranker-0.6B-q8_0.gguf", mode: "generative" },
  "jina-reranker-v2": { file: "jina-reranker-v2-base.Q8_0.gguf", mode: "rank" },
};

const DEFAULT_MODEL = "qwen3-reranker-0.6b-q8";

// Official Qwen3-Reranker prompt scaffold (generative yes/no judgement).
const QWEN_PREFIX =
  '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n';
const QWEN_SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n";
const QWEN_INSTRUCT = "Given a web search query, retrieve relevant passages that answer the query";

function buildQwenPrompt(q: string, doc: string): string {
  return `${QWEN_PREFIX}<Instruct>: ${QWEN_INSTRUCT}\n<Query>: ${q}\n<Document>: ${doc}${QWEN_SUFFIX}`;
}

// Cap per-document content fed to the reranker. Short atomic notes are the norm;
// this bounds context blow-up + latency on the occasional huge memory.
const MAX_DOC_CHARS = 2000;

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
  if (_state === "ready") return;
  if (_state === "failed") return; // already logged once — don't thrash

  try {
    _modelKey = resolveModelKey();
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
      _ctx = await _model.createContext({ contextSize: 1024 });
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
      // Context must fit query + the longest document (jina concatenates them).
      // 512 is too small for real memories; 2048 covers MAX_DOC_CHARS + query.
      _rankCtx = await _model.createRankingContext({ contextSize: 2048 });
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

/** Generative yes/no score for one (query, doc) pair. */
async function scoreGenerative(q: string, doc: string): Promise<number> {
  const tokens = _model.tokenize(buildQwenPrompt(q, doc.slice(0, MAX_DOC_CHARS)), true);
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
    const trimmed = docs.map((d) => String(d ?? "").slice(0, MAX_DOC_CHARS));
    return runExclusive(() => _rankCtx.rankAll(query, trimmed));
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
