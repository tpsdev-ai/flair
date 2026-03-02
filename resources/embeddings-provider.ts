/**
 * In-process embeddings via harper-fabric-embeddings.
 * Uses a serial queue to prevent concurrent native inference calls
 * (llama.cpp context is not thread-safe — concurrent calls segfault).
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

// --- Serial Embedding Queue ---
// Prevents concurrent native inference calls that crash llama.cpp.
// All embedding requests go through this queue, processed one at a time.
const queue: Array<{ text: string; resolve: (v: number[] | null) => void }> = [];
let processing = false;

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    const job = queue.shift()!;
    try {
      const result = await doEmbed(job.text);
      job.resolve(result);
    } catch (err: any) {
      console.error(`[embeddings] queue job failed: ${err.message}`);
      job.resolve(null);
    }
  }
  processing = false;
}

async function doEmbed(text: string): Promise<number[] | null> {
  if (mode === "native" && hfe) {
    return await hfe.embed(text.slice(0, MAX_CHARS));
  }
  if (mode === "hash") {
    const { fallbackEmbed } = await import("./embeddings.js");
    return fallbackEmbed(text.slice(0, MAX_CHARS));
  }
  return null;
}

export async function getEmbedding(text: string): Promise<number[] | null> {
  return new Promise<number[] | null>((resolve) => {
    queue.push({ text, resolve });
    processQueue();
  });
}

export function getQueueLength(): number { return queue.length; }
