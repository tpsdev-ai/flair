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

let _ready = false;

async function ensureInit(): Promise<void> {
  if (_ready) return;
  try {
    // Check if already initialized (e.g. shared context)
    hfe.dimensions();
    _ready = true;
    return;
  } catch {
    // Not initialized — init with modelsDir pointing to where Harper's
    // plugin loader downloaded the model (process.cwd() is the app dir)
    const modelsDir = join(process.cwd(), "models");
    await hfe.init({ modelsDir });
    _ready = true;
  }
}

/**
 * Generate an embedding vector for the given text.
 * Returns null if the embedding engine isn't available on this platform.
 */
export async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    await ensureInit();
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
  try {
    hfe.dimensions();
    return "local";
  } catch {
    return "none";
  }
}
