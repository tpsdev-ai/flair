/**
 * embeddings-provider.ts
 *
 * Wrapper around harper-fabric-embeddings for Flair resources.
 *
 * Harper loads resources in a VM sandbox with a separate module cache from
 * the main thread. This means our import of harper-fabric-embeddings gets
 * a different (uninitialized) instance from the one Harper initialized via
 * handleApplication in config.yaml.
 *
 * Solution: we call hfe.init() ourselves on first use. The model is already
 * on disk (downloaded by Harper's plugin loader), so init just loads the
 * native binary and model file — no download needed.
 */

import * as hfe from "harper-fabric-embeddings";
import { join } from "node:path";

type InitState = "uninitialized" | "ready" | "failed";

let _state: InitState = "uninitialized";
let _initError: string | undefined;
let _warnedOnce = false;

async function ensureInit(): Promise<void> {
  if (_state === "ready") return;
  if (_state === "failed") return; // Don't retry — already logged warning

  try {
    // Check if already initialized (e.g. shared context)
    hfe.dimensions();
    _state = "ready";
    return;
  } catch {
    // Not initialized — init with modelsDir pointing to where Harper's
    // plugin loader downloaded the model (process.cwd() is the app dir)
    try {
      const modelsDir = join(process.cwd(), "models");
      await hfe.init({ modelsDir });
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
    if (_state !== "ready") return null;
    return await hfe.embed(text);
  } catch (err: any) {
    console.error(`[embeddings] embed failed: ${err.message}`);
    return null;
  }
}

/**
 * Check if the embedding engine is currently available.
 */
export function getMode(): "local" | "none" {
  if (_state === "ready") return "local";
  if (_state === "failed") return "none";
  // Still uninitialized — check directly
  try {
    hfe.dimensions();
    return "local";
  } catch {
    return "none";
  }
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
  if (mode === "local") {
    try {
      return {
        mode,
        model: "nomic-embed-text-v1.5",
        dims: hfe.dimensions(),
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
