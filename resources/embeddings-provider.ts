/**
 * In-process embeddings via harper-fabric-embeddings (v0.2.0+).
 *
 * Harper loads this resource module in multiple worker threads/ESM contexts.
 * The native model must load exactly once per process. We use a process-level
 * singleton to coordinate initialization across contexts.
 */

const MAX_CHARS = 500;
const MODELS_DIR = process.env.FLAIR_MODELS_DIR || "/tmp/flair-models";
const SINGLETON_KEY = "__flair_hfe_020__";

interface HfeSingleton {
  hfe: any;
  dims: number;
  mode: "native" | "hash" | "none";
  initPromise: Promise<void> | null;
}

function getSingleton(): HfeSingleton | null {
  return (process as any)[SINGLETON_KEY] ?? null;
}

function setSingleton(s: HfeSingleton): void {
  (process as any)[SINGLETON_KEY] = s;
}

// Local references (populated from singleton)
let hfe: any = null;
let dims = 0;
let mode: "native" | "hash" | "none" = "none";

function syncFromSingleton(): boolean {
  const s = getSingleton();
  if (s && s.mode !== "none") {
    hfe = s.hfe; dims = s.dims; mode = s.mode;
    return true;
  }
  return false;
}

export function getDimensions(): number {
  if (dims === 0) syncFromSingleton();
  return dims;
}
export function getMode(): string {
  if (mode === "none") syncFromSingleton();
  return mode;
}

export async function initEmbeddings(): Promise<void> {
  // Already initialized in this context
  if (mode !== "none") return;
  // Check if another context already did it
  if (syncFromSingleton()) return;

  // Check if init is in progress from another context
  const existing = getSingleton();
  if (existing?.initPromise) {
    await existing.initPromise;
    syncFromSingleton();
    return;
  }

  // We're the first — claim the init
  const sentinel: HfeSingleton = { hfe: null, dims: 0, mode: "none", initPromise: null };
  setSingleton(sentinel);
  sentinel.initPromise = doInit(sentinel);
  await sentinel.initPromise;
  syncFromSingleton();
}

async function doInit(singleton: HfeSingleton): Promise<void> {
  // file:// URL bypass for Harper's VM sandbox ESM resolver
  try {
    const { resolve: resolvePath, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const mainPath = resolvePath(
      moduleDir, "..", "..", "node_modules", "harper-fabric-embeddings", "dist", "index.js"
    );
    const mod = await import(`file://${mainPath}`);
    await mod.init({ modelsDir: MODELS_DIR, gpuLayers: 99 });
    singleton.hfe = mod;
    singleton.dims = mod.dimensions();
    singleton.mode = "native";
    console.log(`[embeddings] Native in-process (v0.2.0): ${singleton.dims} dims`);
    return;
  } catch (err: any) {
    console.error(`[embeddings] Native load failed: ${err.message}`);
  }

  // Fallback: hash-based pseudo-embeddings
  try {
    await import("./embeddings.js");
    singleton.dims = 512;
    singleton.mode = "hash";
    console.log(`[embeddings] Fallback: ${singleton.dims} dims (hash-based)`);
  } catch (e: any) {
    console.error(`[embeddings] Hash fallback failed: ${e.message}`);
  }
}

// --- Serial Embedding Queue (process-level) ---
const QUEUE_KEY = "__flair_embed_queue_020__";
if (!(process as any)[QUEUE_KEY]) {
  (process as any)[QUEUE_KEY] = { queue: [], processing: false };
}
const queueState = (process as any)[QUEUE_KEY] as {
  queue: Array<{ text: string; resolve: (v: number[] | null) => void }>;
  processing: boolean;
};

async function processQueue(): Promise<void> {
  if (queueState.processing) return;
  queueState.processing = true;
  while (queueState.queue.length > 0) {
    const job = queueState.queue.shift()!;
    try {
      const result = await doEmbed(job.text);
      job.resolve(result);
    } catch (err: any) {
      console.error(`[embeddings] queue job failed: ${err.message}`);
      job.resolve(null);
    }
  }
  queueState.processing = false;
}

async function doEmbed(text: string): Promise<number[] | null> {
  if (mode === "none") syncFromSingleton();
  const s = getSingleton();
  if (s?.mode === "native" && s.hfe) {
    return await s.hfe.embed(text.slice(0, MAX_CHARS));
  }
  if (s?.mode === "hash" || mode === "hash") {
    const { fallbackEmbed } = await import("./embeddings.js");
    return fallbackEmbed(text.slice(0, MAX_CHARS));
  }
  return null;
}

export async function getEmbedding(text: string): Promise<number[] | null> {
  return new Promise<number[] | null>((resolve) => {
    queueState.queue.push({ text, resolve });
    processQueue();
  });
}

export function getQueueLength(): number { return queueState.queue.length; }
