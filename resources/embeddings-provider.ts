/**
 * embeddings-provider.ts
 *
 * Provides a singleton embedding context for Flair using node-llama-cpp
 * with the nomic-embed-text model (768-dim, Metal-accelerated on macOS).
 *
 * node-llama-cpp is an OPTIONAL dependency — on Linux or platforms without
 * Metal/CUDA support, this gracefully returns null and semantic search
 * falls back to keyword matching.
 *
 * Uses process-level global to ensure only one llama instance exists,
 * surviving Harper's VM sandbox and hot-reload cycles.
 */

const SINGLETON_KEY = "__flair_hfe_021__";
const MODEL_FILE = "nomic-embed-text-v1.5.Q4_K_M.gguf";

interface EmbeddingContext {
  getEmbeddingFor(text: string): Promise<{ vector: number[] }>;
}

async function initEmbeddings(): Promise<EmbeddingContext | null> {
  // Return existing singleton if available
  const existing = (globalThis as any)[SINGLETON_KEY];
  if (existing) return existing;

  try {
    // node-llama-cpp is optional — may not be installed on Linux
    let getLlama: any;
    try {
      const dynamicImport = new Function("url", "return import(url)");
      ({ getLlama } = await dynamicImport("node-llama-cpp"));
    } catch {
      console.log("[embeddings] node-llama-cpp not available on this platform — local embeddings disabled");
      return null;
    }

    const llama = await getLlama();

    // Find model file in the package directory
    const { resolve, dirname, join } = await import("node:path");
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");

    let modelDir: string;
    try {
      modelDir = dirname(fileURLToPath(import.meta.url));
    } catch {
      modelDir = __dirname;
    }

    // Search common locations for the model file
    const candidates = [
      join(modelDir, MODEL_FILE),
      join(modelDir, "..", MODEL_FILE),
      join(modelDir, "..", "models", MODEL_FILE),
    ];
    const modelPath = candidates.find(existsSync);
    if (!modelPath) {
      console.log(`[embeddings] model file ${MODEL_FILE} not found — local embeddings disabled`);
      return null;
    }

    const model = await llama.loadModel({ modelPath });
    const ctx = await model.createEmbeddingContext();

    // Cache as process-level singleton
    (globalThis as any)[SINGLETON_KEY] = ctx;
    console.log(`[embeddings] loaded ${MODEL_FILE} (768-dim)`);
    return ctx;
  } catch (err: any) {
    console.log(`[embeddings] init failed: ${err.message} — local embeddings disabled`);
    return null;
  }
}

export async function embed(text: string): Promise<number[] | null> {
  const ctx = await initEmbeddings();
  if (!ctx) return null;
  try {
    const result = await ctx.getEmbeddingFor(text);
    return result.vector;
  } catch (err: any) {
    console.log(`[embeddings] embed failed: ${err.message}`);
    return null;
  }
}
