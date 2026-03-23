/**
 * embeddings-provider.ts
 *
 * Thin wrapper around harper-fabric-embeddings for Flair resources.
 * harper-fabric-embeddings is loaded by Harper as a sub-component
 * (declared in config.yaml). It downloads the model and initializes
 * in the background. We just call embed() — if it's not ready yet,
 * we return null and the caller handles it gracefully.
 */

import * as hfe from "harper-fabric-embeddings";

/**
 * Generate an embedding vector for the given text.
 * Returns null if the embedding engine isn't ready yet (model still loading)
 * or not available on this platform. Never gives up permanently — each call
 * checks independently.
 */
export async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    return await hfe.embed(text);
  } catch {
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
