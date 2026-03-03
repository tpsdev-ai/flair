/**
 * In-process embeddings via harper-fabric-embeddings.
 * Uses a file-based lock + process singleton to ensure the native model
 * loads exactly once even when Harper loads this module multiple times.
 */
import { writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";

const MAX_CHARS = 500;
const MODELS_DIR = process.env.FLAIR_MODELS_DIR || "/tmp/flair-models";
const LOCK_FILE = "/tmp/flair-embeddings.lock";
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

export async function initEmbeddings(): Promise<void> {
  // Check if already initialized in this module instance
  if (mode !== "none") return;

  // Check if another module instance in this process already loaded
  if ((process as any)[PID_KEY]) {
    // Grab the shared instance
    const shared = (process as any)[PID_KEY];
    hfe = shared.hfe;
    dims = shared.dims;
    mode = shared.mode;
    return;
  }

  // Use lock file to prevent concurrent init across process restarts
  try {
    if (existsSync(LOCK_FILE)) {
      const lockPid = readFileSync(LOCK_FILE, "utf8").trim();
      // If same PID, another module instance beat us — wait for process singleton
      if (lockPid === String(process.pid)) {
        // Spin-wait for the process singleton
        for (let i = 0; i < 50; i++) {
          await new Promise(r => setTimeout(r, 100));
          if ((process as any)[PID_KEY]) {
            const shared = (process as any)[PID_KEY];
            hfe = shared.hfe; dims = shared.dims; mode = shared.mode;
            return;
          }
        }
        console.error("[embeddings] Timeout waiting for singleton");
        return;
      }
      // Different PID — stale lock, clean up
      try { unlinkSync(LOCK_FILE); } catch {}
    }

    // Claim the lock
    writeFileSync(LOCK_FILE, String(process.pid));
  } catch {}

  try {
    hfe = await import("harper-fabric-embeddings");
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

  // Fallback: hash-based
  try {
    const { fallbackEmbed } = await import("./embeddings.js");
    dims = 512;
    mode = "hash";
    (process as any)[PID_KEY] = { hfe: null, dims, mode };
    console.log(`[embeddings] Fallback: ${dims} dims (hash-based)`);
  } catch (e: any) {
    console.error(`[embeddings] Hash fallback failed: ${e.message}`);
  }
}

// --- Serial Embedding Queue (process-level singleton) ---
// Must be process-level because Harper loads this module in separate contexts.
// Each context gets its own `queue` variable — but we need ONE queue to serialize.
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
  // Ensure we have the singleton
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
