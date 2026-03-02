/**
 * In-process embeddings via harper-fabric-embeddings.
 * Works directly inside Harper's sandbox after the v5 compatibility fix.
 */

const MAX_CHARS = 500;
const MODELS_DIR = process.env.FLAIR_MODELS_DIR || "/tmp/flair-models";

let dims = 0;
let mode: "native" | "hash" | "none" = "none";
let hfe: any = null;

export function getDimensions(): number { return dims; }
export function getMode(): string { return mode; }

export async function initEmbeddings(): Promise<void> {
  try {
    hfe = await import("harper-fabric-embeddings");
    await hfe.init({ modelsDir: MODELS_DIR, gpuLayers: 99 });
    dims = hfe.dimensions();
    mode = "native";
    console.log(`[embeddings] Native in-process: ${dims} dims`);
    return;
  } catch (err: any) {
    console.error(`[embeddings] Native load failed: ${err.message}`);
    hfe = null;
  }

  // Fallback: hash-based
  try {
    const { fallbackEmbed } = await import("./embeddings.js");
    dims = 512;
    mode = "hash";
    console.log(`[embeddings] Fallback: ${dims} dims (hash-based)`);
  } catch (e: any) {
    console.error(`[embeddings] Hash fallback failed: ${e.message}`);
  }
}

export async function getEmbedding(text: string): Promise<number[] | null> {
  if (mode === "native" && hfe) {
    try {
      return await hfe.embed(text.slice(0, MAX_CHARS));
    } catch (err: any) {
      console.error(`[embeddings] embed failed: ${err.message}`);
      return null;
    }
  }
  if (mode === "hash") {
    const { fallbackEmbed } = await import("./embeddings.js");
    return fallbackEmbed(text.slice(0, MAX_CHARS));
  }
  return null;
}
