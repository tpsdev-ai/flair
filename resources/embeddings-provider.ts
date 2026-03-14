/**
 * In-process embeddings via harper-fabric-embeddings.
 * Uses Harper's native tryLock/unlock on the Memory table primaryStore
 * to ensure the native model loads exactly once, even when Harper loads
 * this module in multiple ESM contexts within the same process.
 */
import { tables } from "@harperfast/harper";

const MAX_CHARS = 500;
const MODELS_DIR = process.env.FLAIR_MODELS_DIR || "/tmp/flair-models";
const LOCK_KEY = "flair-embeddings-init";
const PID_KEY = "__flair_embed_pid__";

let dims = 0;
let mode: "native" | "hash" | "none" = "none";
let hfe: any = null;

export function getDimensions(): number {
  if (dims === 0 && (process as any)[PID_KEY]) dims = (process as any)[PID_KEY].dims;
  return dims;
}
export function getMode(): string {
  if (mode === "none" && (process as any)[PID_KEY]) {
    const shared = (process as any)[PID_KEY];
    hfe = shared.hfe; dims = shared.dims; mode = shared.mode;
  }
  return mode;
}

/**
 * Returns the Memory table primaryStore when Harper has initialized it.
 * Polls briefly since Harper lazy-initializes tables.
 */
async function getStore(): Promise<{ tryLock: (k: any, cb?: () => void) => boolean; unlock: (k: any) => void } | null> {
  for (let i = 0; i < 50; i++) {
    try {
      const store = (tables as any).Memory?.primaryStore;
      if (store?.tryLock) return store;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

export async function initEmbeddings(): Promise<void> {
  // Check if already initialized in this module instance
  if (mode !== "none") return;

  // Check if another module instance in this process already loaded
  if ((process as any)[PID_KEY]) {
    const shared = (process as any)[PID_KEY];
    hfe = shared.hfe;
    dims = shared.dims;
    mode = shared.mode;
    return;
  }

  const store = await getStore();

  if (store) {
    // Use Harper's native lock — tryLock returns true if acquired immediately,
    // or registers callback to be called when unlocked.
    await new Promise<void>((resolve) => {
      const attempt = () => {
        const acquired = store.tryLock(LOCK_KEY, attempt);
        if (!acquired) return; // will retry via callback

        // Lock acquired — re-check if another instance finished while we waited
        if ((process as any)[PID_KEY]) {
          store.unlock(LOCK_KEY);
          const shared = (process as any)[PID_KEY];
          hfe = shared.hfe; dims = shared.dims; mode = shared.mode;
          resolve();
          return;
        }

        // We hold the lock and no one else initialized — do the work
        doInit().finally(() => {
          store.unlock(LOCK_KEY);
          resolve();
        });
      };
      attempt();
    });
  } else {
    // Harper store unavailable (early startup) — check singleton again then init directly
    if ((process as any)[PID_KEY]) {
      const shared = (process as any)[PID_KEY];
      hfe = shared.hfe; dims = shared.dims; mode = shared.mode;
      return;
    }
    await doInit();
  }
}

async function doInit(): Promise<void> {
  try {
    // Use file:// URL to bypass Node's strict "exports" map enforcement.
    // Harper's VM sandbox module resolver doesn't handle the "exports" field
    // in harper-fabric-embeddings' package.json. Importing via file:// URL
    // skips package resolution entirely and loads the file directly.
    // Resolve from module location (not cwd) to prevent path manipulation.
    const { resolve: resolvePath, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const mainPath = resolvePath(
      moduleDir, "..", "..", "node_modules", "harper-fabric-embeddings", "dist", "index.js"
    );
    hfe = await import(`file://${mainPath}`);
    await hfe.init({ modelsDir: MODELS_DIR, gpuLayers: 99 });
    dims = hfe.dimensions();
    mode = "native";
    (process as any)[PID_KEY] = { hfe, dims, mode };
    console.log(`[embeddings] Native in-process: ${dims} dims`);
    return;
  } catch (err: any) {
    console.error(`[embeddings] Native load failed: ${err.message}`);
    hfe = null;
  }

  // Fallback: hash-based pseudo-embeddings
  try {
    const { fallbackEmbed } = await import("./embeddings.js");
    dims = 512;
    mode = "hash";
    (process as any)[PID_KEY] = { hfe: null, dims, mode };
    console.log(`[embeddings] Fallback: ${dims} dims (hash-based)`);
  } catch (e: any) {
    console.error(`[embeddings] Hash fallback failed: ${e.message}`);
    mode = "none";
    (process as any)[PID_KEY] = { hfe: null, dims: 0, mode: "none" };
  }
}

// --- Serial Embedding Queue (process-level singleton) ---
// Harper loads this module in separate ESM contexts; each gets its own local
// variables. The queue must live on `process` to be shared across contexts.
const QUEUE_KEY = "__flair_embed_queue__";
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
  if (mode === "none" && (process as any)[PID_KEY]) {
    const shared = (process as any)[PID_KEY];
    hfe = shared.hfe; dims = shared.dims; mode = shared.mode;
  }
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
    queueState.queue.push({ text, resolve });
    processQueue();
  });
}

export function getQueueLength(): number { return queueState.queue.length; }
