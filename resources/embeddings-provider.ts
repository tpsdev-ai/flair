/**
 * In-process embeddings via harper-fabric-embeddings (v0.2.1+).
 *
 * Uses process-level singleton for cross-thread model sharing.
 * Avoids dynamic imports inside Harper's VM sandbox by using
 * globalThis.__hfe_resolve__ set during module load.
 */

const MAX_CHARS = 500;
const MODELS_DIR = process.env.FLAIR_MODELS_DIR || "/tmp/flair-models";
const SINGLETON_KEY = "__flair_hfe_021__";
const QUEUE_KEY = "__flair_embed_queue_021__";

interface HfeSingleton {
  hfe: any;
  dims: number;
  mode: "native" | "hash" | "none";
  initPromise: Promise<void> | null;
}

function getSingleton(): HfeSingleton {
  if (!(process as any)[SINGLETON_KEY]) {
    (process as any)[SINGLETON_KEY] = { hfe: null, dims: 0, mode: "none", initPromise: null };
  }
  return (process as any)[SINGLETON_KEY];
}

interface QueueState {
  queue: Array<{ text: string; resolve: (v: number[] | null) => void }>;
  processing: boolean;
}

function getQueue(): QueueState {
  if (!(process as any)[QUEUE_KEY]) {
    (process as any)[QUEUE_KEY] = { queue: [], processing: false };
  }
  return (process as any)[QUEUE_KEY];
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function initEmbeddings(): Promise<void> {
  const s = getSingleton();
  if (s.mode !== "none") return;
  if (s.initPromise) { await s.initPromise; return; }
  s.initPromise = doInit(s);
  await s.initPromise;
}

async function doInit(s: HfeSingleton): Promise<void> {
  // Resolve path at build time relative to this file's location
  const hfePath = new URL(
    "../../node_modules/harper-fabric-embeddings/dist/index.js",
    import.meta.url
  ).href;

  try {
    // Use globalThis.process to do a native dynamic import outside the
    // VM sandbox's importModuleDynamically interception. The Function
    // constructor creates code in the global scope, not the VM context.
    const importFn = new Function("url", "return import(url)") as (url: string) => Promise<any>;
    const mod = await importFn(hfePath);

    if (typeof mod.init !== "function") {
      throw new Error(`Module has no init(). Keys: ${Object.keys(mod)}`);
    }
    const result = mod.init({ modelsDir: MODELS_DIR, gpuLayers: 99 });
    if (result?.then) await result;

    s.hfe = mod;
    s.dims = mod.dimensions();
    s.mode = "native";
    console.log(`[embeddings] Native in-process (v0.2.1): ${s.dims} dims`);
  } catch (err: any) {
    console.error(`[embeddings] Native load failed: ${err.message}`);
    // Fallback to hash-based embeddings
    try {
      s.dims = 512; s.mode = "hash";
      console.log(`[embeddings] Fallback: 512 dims (hash-based)`);
    } catch (e2: any) {
      console.error(`[embeddings] All embedding modes failed: ${e2.message}`);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getDimensions(): number { return getSingleton().dims; }
export function getMode(): string { return getSingleton().mode; }

export async function getEmbedding(text: string): Promise<number[] | null> {
  const s = getSingleton();
  if (s.mode === "none") await initEmbeddings();

  return new Promise<number[] | null>((resolve) => {
    const q = getQueue();
    q.queue.push({ text, resolve });
    processQueue(q);
  });
}

export function getQueueLength(): number { return getQueue().queue.length; }

async function processQueue(q: QueueState): Promise<void> {
  if (q.processing) return;
  q.processing = true;
  while (q.queue.length > 0) {
    const job = q.queue.shift()!;
    try {
      const s = getSingleton();
      if (s.mode === "native" && s.hfe) {
        job.resolve(await s.hfe.embed(job.text.slice(0, MAX_CHARS)));
      } else if (s.mode === "hash") {
        // Hash fallback doesn't need the module
        const text = job.text.slice(0, MAX_CHARS);
        job.resolve(fallbackEmbed(text));
      } else {
        job.resolve(null);
      }
    } catch (err: any) {
      console.error(`[embeddings] embed failed: ${err.message}`);
      job.resolve(null);
    }
  }
  q.processing = false;
}

// ─── Hash Fallback ────────────────────────────────────────────────────────────

function fallbackEmbed(text: string): number[] {
  const dims = 512;
  const vec = new Array(dims).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    vec[i % dims] += code / 128;
    vec[(i * 7 + 3) % dims] += Math.sin(code * 0.1) * 0.5;
  }
  // Normalize
  let mag = 0;
  for (let i = 0; i < dims; i++) mag += vec[i] * vec[i];
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < dims; i++) vec[i] /= mag;
  return vec;
}
