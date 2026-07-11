/**
 * embeddings-provider.ts
 *
 * Wrapper around Harper's native `models.embed()` facade for Flair resources.
 *
 * Phase 1 (flair#504) — infra swap, DEAD-FLAT WASH. Embeddings now resolve
 * through Harper's process-wide `models` singleton instead of this file
 * dynamic-importing `harper-fabric-embeddings` and initializing it itself.
 * The engine is the SAME one, registered as the `embedding`/`default`
 * backend by harper-fabric-embeddings@0.3.0's own `register()` factory
 * (invoked by Harper's `bootstrapModels` off the Harper INSTANCE-ROOT
 * config's `models.embedding.default` block — NOT this package's own
 * config.yaml, which is loaded as a non-root application and never reaches
 * bootstrapModels; see config.yaml's own comment, and src/cli.ts's
 * `buildEmbeddingsHarperConfigEnv` / `buildModelsConfig`, which write that
 * root-config block via HARPER_CONFIG — Harper's merge-layer env that reasserts
 * only the keys it names and yields to Fabric-managed config, never
 * HARPER_SET_CONFIG's force-override). No `inputType` is passed here, so no
 * `search_document:`/`search_query:` prefix is applied —
 * output is byte-identical to the pre-migration direct-import path. That's
 * what makes this swap a dead-flat wash: same model, same weights, same
 * input, same output — only the plumbing changed. Phase 2 (a separate,
 * deliberate follow-on) turns `inputType` on and re-embeds the corpus.
 *
 * This retires the `@node-llama-cpp/<platform>` addon-path discovery and
 * the VM-sandbox manual-init block that used to live here: Harper 5.0.0's VM
 * sandbox can't statically link npm packages during module resolution (an
 * async race in getOrCreateModule), which is why the OLD code deferred to a
 * dynamic import() on first call. That fragility — a runtime bump silently
 * breaking embeddings on next restart (the node-26 near-miss) — is exactly
 * what this migration removes: `models.embed` is a process-wide singleton
 * Harper initializes at boot, off the first-call dynamic-import race.
 *
 * `@harperfast/harper` is dynamic-imported here (deferred to first actual
 * getEmbedding()/getMode()/getStatus() call), NOT statically imported like
 * every other resource's `Resource`/`databases`/`server` — those work
 * unmocked-import-free only because every test that (transitively) imports
 * them already mocks `@harperfast/harper` first. Statically importing
 * `models` here would make *any* test that imports this file for
 * `resolveModelsDir()` alone (test/unit/embeddings-models-dir.test.ts, which
 * has no reason to know about Harper at all) also eagerly load Harper's real
 * `dist/index.js` — which `require()`s `server/threads/threadServer.js` at
 * module scope and throws ("Unable to determine database storage path...")
 * outside an actual Harper boot (verified: this broke 4 unit-test files
 * before this file switched to a deferred import). Deferring avoids that
 * entirely: the dynamic import only fires when an embedding is actually
 * requested, exactly mirroring this file's own pre-existing pattern for
 * harper-fabric-embeddings.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

type HarperModelsApi = typeof import("@harperfast/harper")["models"];

let _modelsApi: HarperModelsApi | undefined;

/**
 * Resolve (and cache) Harper's `models` facade via a deferred import — see file header.
 *
 * NOTE for anyone using this as a reference: `models` (the `@harperfast/harper`
 * package export) and a component's `scope.models` are the SAME boot-time
 * singleton — Harper's jsLoader hands components `scope.models = <the global
 * models>` (two accessors, one object; the model registry lives on that singleton).
 * A Harper *component* (one with a `handleApplication(scope)` hook) reaches it
 * idiomatically as `scope.models`; this file is a Resource *helper* with no
 * `scope`, so it imports the global export. Same registry, same backends — the
 * global import here is the correct accessor for this context, not a workaround.
 */
async function getModelsApi(): Promise<HarperModelsApi> {
  if (_modelsApi) return _modelsApi;
  const harper = await import("@harperfast/harper");
  _modelsApi = harper.models;
  return _modelsApi;
}

/**
 * Resolve the directory the embeddings model lives in / downloads into.
 *
 * Resolution order (everything writable, never the read-only package dir):
 *   1. FLAIR_MODELS_DIR        — explicit operator/docker override.
 *   2. <ROOTPATH>/models       — Harper's data dir (Flair passes ROOTPATH =
 *                                ~/.flair/data when it spawns Harper). User-
 *                                owned and writable even on sudo-global installs.
 *   3. <cwd>/models            — ONLY if a model already lives there. Backward
 *                                compat for existing writable installs that
 *                                downloaded into the package dir before this fix;
 *                                never used as a download target on fresh installs.
 *   4. ~/.flair/data/models    — last-resort default when ROOTPATH is unset.
 *
 * The chosen dir is always writable, so the embeddings engine can download the
 * model on first use without hitting EACCES on a root-owned package dir.
 *
 * Not called by this file anymore (Phase 1 moved model-directory resolution
 * to src/cli.ts, which computes the SAME <ROOTPATH>/models default and bakes
 * it directly into the `models.embedding.default.modelsDir` value it writes
 * via HARPER_CONFIG — a plain env-var default, not this function, since
 * cli.ts runs in a separate process from the one that would import this
 * file). Kept — and still exported and tested
 * (test/unit/embeddings-models-dir.test.ts) — as the single documented
 * source of truth for that default, and for any external caller that still
 * depends on it.
 */
export function resolveModelsDir(): string {
  const override = process.env.FLAIR_MODELS_DIR;
  if (override) return override;

  const rootPath = process.env.ROOTPATH;
  if (rootPath) return join(rootPath, "models");

  // Backward compat: a prior (writable) install may have the model cached in
  // the package dir. Reuse it rather than re-downloading — but only if present.
  const cwdModels = join(process.cwd(), "models");
  if (existsSync(cwdModels)) return cwdModels;

  return join(homedir(), ".flair", "data", "models");
}

// ─── Health translation (Design §3 / Kern's hardening) ──────────────────────
// `models.embed()` THROWS (ModelBackendNotFoundError / ModelCapabilityError)
// on failure — it does not return null, and there's no backend-agnostic
// health API. getMode()/getStatus() gate SemanticSearch's keyword-only
// fallback (SemanticSearch.ts:558) and must preserve that exact
// degrade-gracefully contract. Both are called SYNCHRONOUSLY by consumers,
// so a cached flag — kept current by a boot probe and by every real
// getEmbedding() call's outcome — stands in for a live await.

type Mode = "local" | "none";

// Kern: "Boot probe MUST have a 5-10s timeout ... on timeout set mode='none'
// + log a warning. A hung probe ... must never block Harper boot."
const PROBE_TIMEOUT_MS = 8_000;

let _mode: Mode = "none"; // pessimistic until the probe (or a real call) proves otherwise
let _dims: number | undefined;
let _lastError: string | undefined;
let _probeStarted = false;
let _warnedOnce = false;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    // Never let a pending probe keep the process alive on its own.
    (timer as unknown as { unref?: () => void }).unref?.();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Boot-time health probe. Does NOT gate getEmbedding() (which always
 * attempts the real call and lets its own try/catch decide the return
 * value) — this exists purely to populate the synchronous getMode() /
 * getStatus() contract those two functions must preserve.
 *
 * `dims` is sourced from an actual embed call's output, never from a raw
 * `dimensions()` accessor — the facade has no dims-metadata accessor (HFE
 * PR #3 confirmed this), and a backend's own `dimensions()` would reflect
 * ITS default engine, not necessarily the config-registered `default`
 * backend `models.embed` actually calls. A mismatch here would be a silent
 * regression in the embedding-stamp / stale-detection logic (Kern's Q3).
 */
async function probe(): Promise<void> {
  try {
    const models = await getModelsApi();
    const [vec] = await withTimeout(
      models.embed("x", { model: "default" }),
      PROBE_TIMEOUT_MS,
      "embedding boot-probe",
    );
    _dims = vec?.length;
    _mode = "local";
    _lastError = undefined;
  } catch (err: any) {
    _mode = "none";
    _lastError = err?.message ?? String(err);
    if (!_warnedOnce) {
      console.warn(
        `[embeddings] WARN: native embeddings unavailable, falling back to keyword-only search. Error: ${_lastError}`
      );
      _warnedOnce = true;
    }
  }
}

function ensureProbeStarted(): void {
  if (_probeStarted) return;
  _probeStarted = true;
  probe().catch(() => {}); // probe() already catches internally; belt-and-suspenders
}

/**
 * Generate an embedding vector for the given text via Harper's `models.embed()`
 * facade. Returns null if the embedding backend isn't available — preserves
 * the pre-migration null-on-failure contract.
 *
 * Phase 1: no `inputType` is passed. Omitted means no `search_document:`/
 * `search_query:` prefix is applied — that's what makes this swap byte-
 * identical to the pre-migration output (the dead-flat-wash gate this
 * change's recall-eval validates). Phase 2 turns `inputType` on as a
 * separate, deliberate step (and re-embeds the corpus to match).
 */
export async function getEmbedding(text: string): Promise<number[] | null> {
  ensureProbeStarted();
  try {
    const models = await getModelsApi();
    const [vec] = await models.embed(text, { model: "default" });
    if (!vec) return null;
    // Self-heal on a live success — harper-fabric-embeddings' register() loads
    // the model in the background and retries readiness on the next call, so
    // a transient failure the boot probe caught needn't stay sticky forever.
    _mode = "local";
    _dims = vec.length;
    _lastError = undefined;
    return Array.from(vec);
  } catch (err: any) {
    _mode = "none";
    _lastError = err?.message ?? String(err);
    console.error(`[embeddings] embed failed: ${_lastError}`);
    return null;
  }
}

/**
 * Check if the embedding engine is currently believed available.
 * Called synchronously (SemanticSearch.ts gates its keyword-only fallback on
 * this), so it reads the cached flag the boot probe and getEmbedding() keep
 * current rather than awaiting a live call.
 */
export function getMode(): Mode {
  ensureProbeStarted();
  return _mode;
}

/**
 * Get the current embedding model identifier.
 * Used for stamping memories and detecting stale embeddings. Unchanged by
 * this migration — same model, same identifier; Phase 1 is a dead-flat wash.
 */
export function getModelId(): string {
  return process.env.FLAIR_EMBEDDING_MODEL ?? "nomic-embed-text-v1.5-Q4_K_M";
}

/**
 * Get embedding engine status for diagnostics.
 * `dims`/`model` are sourced from what `models.embed()` actually produced
 * (the boot probe or the last real call) — never from a backend's raw
 * `dimensions()` accessor (Kern's Q3 hardening).
 */
export function getStatus(): {
  mode: Mode;
  model?: string;
  dims?: number;
  error?: string;
} {
  ensureProbeStarted();
  if (_mode === "local") {
    return {
      mode: _mode,
      model: "nomic-embed-text-v1.5",
      dims: _dims,
    };
  }
  return {
    mode: _mode,
    error: _lastError,
  };
}
