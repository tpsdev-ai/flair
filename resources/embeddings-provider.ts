/**
 * In-process embeddings via harper-fabric-embeddings.
 * Uses a serial queue to prevent concurrent native inference calls
 * (llama.cpp context is not thread-safe — concurrent calls segfault).
 */

const MAX_CHARS = 500;
const MODELS_DIR = process.env.FLAIR_MODELS_DIR || "/tmp/flair-models";

// Process-level singleton: Harper may load this module multiple times
// (once per resource file import). Ensure native model loads exactly once
// AND that the serial queue is shared — otherwise concurrent module instances
// each have their own queue but call the same native hfe.embed() concurrently,
// causing llama.cpp thread-safety crashes.
const GLOBAL_KEY = "__flair_embeddings__";
if (!(process as any)[GLOBAL_KEY]) {
  (process as any)[GLOBAL_KEY] = {
    dims: 0, mode: "none", hfe: null,
    queue: [] as Array<{ text: string; resolve: (v: number[] | null) => void }>,
    processing: false,
  };
}
const _g = (process as any)[GLOBAL_KEY];

let dims: number = _g.dims;
let mode: "native" | "hash" | "none" = _g.mode;
let hfe: any = _g.hfe;

export function getDimensions(): number { return dims; }
export function getMode(): string { return mode; }

export async function initEmbeddings(): Promise<void> {
  if (mode !== "none") return; // Already initialized (singleton guard)
  try {
    hfe = await import("harper-fabric-embeddings");
    await hfe.init({ modelsDir: MODELS_DIR, gpuLayers: 99 });
    dims = hfe.dimensions();
    mode = "native";
    _g.dims = dims; _g.mode = mode; _g.hfe = hfe;
    console.log(`[embeddings] Native in-process: ${dims} dims (caller=${new Error().stack?.split("\n")[2]?.trim()?.slice(0,80)})`);
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

// --- Serial Embedding Queue (process-level, shared across module instances) ---
// Prevents concurrent native inference calls that crash llama.cpp.
// queue and processing live on process[GLOBAL_KEY] so all module instances
// (loaded in different Harper resource sandboxes) share one serialized queue.

async function processQueue(): Promise<void> {
  if (_g.processing) return;
  _g.processing = true;
  while (_g.queue.length > 0) {
    const job = _g.queue.shift()!;
    try {
      const result = await doEmbed(job.text);
      job.resolve(result);
    } catch (err: any) {
      console.error(`[embeddings] queue job failed: ${err.message}`);
      job.resolve(null);
    }
  }
  _g.processing = false;
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
    _g.queue.push({ text, resolve });
    processQueue();
  });
}

export function getQueueLength(): number { return queue.length; }
