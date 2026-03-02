/**
 * In-process embeddings via process.dlopen() — no sidecar needed.
 * 
 * Harper blocks node:module, but process.dlopen() is available.
 * We load the native llama-addon.node directly and replicate
 * harper-fabric-embeddings' init/embed logic.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

const MAX_CHARS = 500;
const MODELS_DIR = process.env.FLAIR_MODELS_DIR || "/tmp/flair-models";

let dims = 0;
let mode: "native" | "hash" | "none" = "none";
let addonRef: any = null;
let modelRef: any = null;
let contextRef: any = null;
let bosToken = -1;
let eosToken = -1;

export function getDimensions(): number { return dims; }
export function getMode(): string { return mode; }

function findAddonPath(): string {
  const candidates = [
    "@node-llama-cpp/mac-arm64-metal",
    "@node-llama-cpp/linux-x64",
    "@node-llama-cpp/mac-x64",
    "@node-llama-cpp/linux-arm64",
  ];
  const nmDir = join(process.cwd(), "node_modules");
  for (const pkg of candidates) {
    const binsDir = join(nmDir, pkg, "bins");
    if (!existsSync(binsDir)) continue;
    for (const entry of readdirSync(binsDir)) {
      const addonPath = join(binsDir, entry, "llama-addon.node");
      if (existsSync(addonPath)) return addonPath;
    }
  }
  throw new Error("No llama-addon.node found");
}

function findModelPath(): string {
  if (!existsSync(MODELS_DIR)) throw new Error(`Models dir not found: ${MODELS_DIR}`);
  const files = readdirSync(MODELS_DIR);
  const gguf = files.find(f => f.endsWith(".gguf"));
  if (gguf) return join(MODELS_DIR, gguf);
  throw new Error(`No .gguf model found in ${MODELS_DIR}`);
}

function normalize(vec: Float32Array): number[] {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return Array.from(vec);
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return Array.from(vec);
}

function buildTokenSequence(tokens: Uint32Array): Uint32Array {
  const parts: number[] = [];
  if (bosToken >= 0 && tokens[0] !== bosToken) parts.push(bosToken);
  for (let i = 0; i < tokens.length; i++) parts.push(tokens[i]);
  if (eosToken >= 0 && tokens[tokens.length - 1] !== eosToken) parts.push(eosToken);
  return new Uint32Array(parts);
}

export async function initEmbeddings(): Promise<void> {
  try {
    const addonPath = findAddonPath();
    const modelPath = findModelPath();
    
    // Load native addon via process.dlopen (bypasses node:module block)
    const mod = { exports: {} } as any;
    process.dlopen(mod, addonPath);
    const addon = mod.exports;
    
    // Initialize llama backend
    await addon.init();
    const backendsDir = dirname(addonPath);
    addon.loadBackends();
    addon.loadBackends(backendsDir);
    
    // Load model
    const model = new addon.AddonModel(modelPath, {
      gpuLayers: 99,
      useMmap: true,
      useMlock: false,
      checkTensors: false,
    });
    if (!(await model.init())) throw new Error("Model init failed");
    
    bosToken = model.tokenBos();
    eosToken = model.tokenEos();
    
    // Create embedding context
    const ctx = new addon.AddonContext(model, {
      contextSize: 2048,
      batchSize: 512,
      sequences: 1,
      embeddings: true,
      threads: 6,
    });
    if (!(await ctx.init())) throw new Error("Context init failed");
    
    addonRef = addon;
    modelRef = model;
    contextRef = ctx;
    dims = model.getEmbeddingVectorSize();
    mode = "native";
    console.log(`[embeddings] Native in-process: ${dims} dims (no sidecar)`);
    return;
  } catch (err: any) {
    console.error(`[embeddings] Native load failed: ${err.message}`);
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
  if (mode === "native" && modelRef && contextRef) {
    try {
      const tokens = modelRef.tokenize(text.slice(0, MAX_CHARS), false);
      if (tokens.length === 0) return null;
      
      const input = buildTokenSequence(tokens);
      contextRef.initBatch(input.length);
      
      const logitIndexes = new Uint32Array(input.length);
      for (let i = 0; i < input.length; i++) logitIndexes[i] = i;
      contextRef.addToBatch(0, 0, input, logitIndexes);
      await contextRef.decodeBatch();
      
      const raw = contextRef.getEmbedding(input.length);
      return normalize(raw);
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
