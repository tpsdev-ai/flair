/**
 * embeddings-provider.ts
 *
 * Wrapper around harper-fabric-embeddings for Flair resources.
 *
 * Harper 5.0.0 loads resources in a VM sandbox that can't statically link
 * npm packages during module resolution (async race in getOrCreateModule).
 * Using dynamic import() defers the module load to first use, bypassing
 * the VM linker entirely.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

type InitState = "uninitialized" | "ready" | "failed";
type HFE = typeof import("harper-fabric-embeddings");

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

let _state: InitState = "uninitialized";
let _initError: string | undefined;
let _warnedOnce = false;
let _hfe: HFE | null = null;

async function ensureInit(): Promise<void> {
  if (_state === "ready") return;
  if (_state === "failed") return; // Don't retry — already logged warning

  try {
    // Dynamic import — deferred to avoid Harper 5.0.0 VM linker race
    if (!_hfe) {
      _hfe = await import("harper-fabric-embeddings");
    }

    // Check if already initialized (e.g. shared context)
    _hfe.dimensions();
    _state = "ready";
    return;
  } catch {
    // Not initialized — init with modelsDir pointing at a USER-WRITABLE
    // location. On a sudo/root-owned global install the Flair package dir
    // (process.cwd()) is root-owned, so a model download into <cwd>/models
    // fails with EACCES and semantic search silently dies (ops-am0v). The
    // model — and everything else Flair writes — must live under ~/.flair.
    //
    // NOTE: import.meta.dirname and __dirname are both undefined in Harper v5's
    // VM sandbox / worker threads, so we resolve from env + process.cwd().
    try {
      if (!_hfe) {
        _hfe = await import("harper-fabric-embeddings");
      }

      const modelsDir = resolveModelsDir();

      // Find the native addon binary explicitly to avoid __dirname-dependent
      // discovery in @node-llama-cpp which fails in Harper's VM sandbox.
      const platforms = ["linux-x64", "mac-arm64-metal", "mac-arm64", "win-x64"];
      let addonPath: string | undefined;
      for (const platform of platforms) {
        const candidate = join(process.cwd(), "node_modules", "@node-llama-cpp", platform, "bins", platform, "llama-addon.node");
        if (existsSync(candidate)) { addonPath = candidate; break; }
      }

      await _hfe.init({ modelsDir, ...(addonPath ? { addonPath } : {}) });
      _state = "ready";
    } catch (err: any) {
      _state = "failed";
      _initError = err.message || String(err);
      if (!_warnedOnce) {
        console.warn(
          `[embeddings] WARN: native embeddings unavailable, falling back to keyword-only search. Error: ${_initError}`
        );
        _warnedOnce = true;
      }
    }
  }
}

/**
 * Generate an embedding vector for the given text.
 * Returns null if the embedding engine isn't available on this platform.
 */
export async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    await ensureInit();
    if (_state !== "ready" || !_hfe) return null;
    return await _hfe.embed(text);
  } catch (err: any) {
    console.error(`[embeddings] embed failed: ${err.message}`);
    return null;
  }
}

/**
 * Check if the embedding engine is currently available.
 * If still uninitialized, attempts initialization first.
 * This ensures worker threads (which don't share the main thread's init)
 * get a chance to initialize before we give up.
 */
let _getModeInitAttempted = false;
export function getMode(): "local" | "none" {
  if (_state === "ready") return "local";
  if (_state === "failed") return "none";
  // Still uninitialized — try direct check first
  if (_hfe) {
    try {
      _hfe.dimensions();
      _state = "ready";
      return "local";
    } catch {
      // fall through
    }
  }
  // Not yet initialized. Trigger async init on first call so subsequent
  // calls (including getEmbedding) will find the engine ready.
  if (!_getModeInitAttempted) {
    _getModeInitAttempted = true;
    ensureInit().catch(() => {}); // fire-and-forget
  }
  return "none";
}

/**
 * Get the current embedding model identifier.
 * Used for stamping memories and detecting stale embeddings.
 */
export function getModelId(): string {
  return process.env.FLAIR_EMBEDDING_MODEL ?? "nomic-embed-text-v1.5-Q4_K_M";
}

/**
 * Get embedding engine status for diagnostics.
 */
export function getStatus(): {
  mode: "local" | "none";
  model?: string;
  dims?: number;
  error?: string;
} {
  const mode = getMode();
  if (mode === "local" && _hfe) {
    try {
      return {
        mode,
        model: "nomic-embed-text-v1.5",
        dims: _hfe.dimensions(),
      };
    } catch {
      return { mode };
    }
  }
  return {
    mode,
    error: _initError,
  };
}
