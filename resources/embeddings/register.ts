/**
 * Register the in-tree engine on Harper's models singleton the same way
 * harper-fabric-embeddings' register() does: defineBackend, then
 * registerBackend('embedding', 'default', backend). Called only when
 * FLAIR_EMBEDDINGS_ENGINE=flair. A failed verify or load throws before
 * registerBackend.
 */
import { performance } from "node:perf_hooks";
import { EmbeddingModelError } from "./errors.js";
import {
  ensureBuiltinModelFile,
  verifyExistingModelFile,
  type ModelDownloader,
} from "./fetch.js";
import { resolveFlairAddonPath } from "./engine.js";
import { BUILTIN_EMBEDDING_MODEL } from "./models.js";

export const FLAIR_BACKEND_LOGICAL_NAME = "default";

export interface EmbedManyOptions {
  inputType?: string;
  task?: string;
  signal?: AbortSignal;
}

export interface EmbedManyEngine {
  embedMany(
    texts: readonly string[],
    opts?: EmbedManyOptions,
  ): Promise<{ vectors: Float32Array[]; tokens: number }>;
  readonly llama?: { readonly gpu: "metal" | "cuda" | "vulkan" | false };
  readonly gpuLayers?: number;
}

export interface HarperModelsApi {
  registerBackend(kind: "embedding", id: string, backend: unknown): void;
  defineBackend(spec: {
    name: string;
    embed: (
      input: string | string[],
      opts: EmbedManyOptions & { signal?: AbortSignal },
    ) => Promise<{
      status: "completed";
      output: Float32Array[];
      usage: { embeddingTokens: number; latencyMs: number };
    }>;
  }): unknown;
}

export interface ActivateFlairOptions {
  modelsDir: string;
  models: HarperModelsApi;
  threads: number;
  gpuLayers: number;
  /** Bench hatch. Verified against the registry; never downloaded. */
  explicitModelPath?: string;
  /** Test seam. Production follows redirects and writes the pinned file. */
  download?: ModelDownloader;
  load?: (args: { modelPath: string; threads: number; gpuLayers: number }) => Promise<EmbedManyEngine>;
  /** Test seam. Production resolves the host platform package. */
  platform?: string;
  arch?: string;
  resolvePackage?: (name: string) => string;
}

function isHarperModels(models: unknown): models is HarperModelsApi {
  if (typeof models !== "object" || models === null) return false;
  if (!("registerBackend" in models) || !("defineBackend" in models)) return false;
  return typeof models.registerBackend === "function" && typeof models.defineBackend === "function";
}

export function requireHarperModels(models: unknown): HarperModelsApi {
  if (!isHarperModels(models)) {
    throw new EmbeddingModelError(
      "engine",
      "[embeddings] Harper models.registerBackend/defineBackend is not available.",
      "Boot under Harper with the models API. Refusing to register the flair embedding backend.",
    );
  }
  return models;
}

export function bindFlairBackend(models: HarperModelsApi, engine: EmbedManyEngine): void {
  const entry = BUILTIN_EMBEDDING_MODEL;
  const backend = models.defineBackend({
    name: `flair:${entry.id}`,
    embed: async (input, opts) => {
      const texts = Array.isArray(input) ? input : [input];
      const started = performance.now();
      const { vectors, tokens } = await engine.embedMany(texts, {
        inputType: opts?.inputType,
        task: typeof opts?.task === "string" ? opts.task : undefined,
        signal: opts?.signal,
      });
      return {
        status: "completed" as const,
        output: vectors,
        usage: {
          embeddingTokens: tokens,
          latencyMs: Math.round(performance.now() - started),
        },
      };
    },
  });
  models.registerBackend("embedding", FLAIR_BACKEND_LOGICAL_NAME, backend);
}

export async function activateFlairBackend(opts: ActivateFlairOptions): Promise<EmbedManyEngine> {
  // The platform package is resolved before any model fetch so a missing
  // prebuilt is not reported as a download failure, and a download failure
  // is not reported as a prebuilt that did not load.
  resolveFlairAddonPath(opts.resolvePackage, opts.platform, opts.arch);
  const modelPath = opts.explicitModelPath
    ? await verifyExistingModelFile(BUILTIN_EMBEDDING_MODEL, opts.explicitModelPath, { download: opts.download })
    : await ensureBuiltinModelFile(opts.modelsDir, { download: opts.download });
  const load = opts.load ?? loadFlairEngine;
  const engine = await load({
    modelPath,
    threads: opts.threads,
    gpuLayers: opts.gpuLayers,
  });
  bindFlairBackend(opts.models, engine);
  return engine;
}

async function loadFlairEngine(args: {
  modelPath: string;
  threads: number;
  gpuLayers: number;
}): Promise<EmbedManyEngine> {
  const { createFlairEmbeddingEngine } = await import("./engine.js");
  const engine = createFlairEmbeddingEngine({
    modelPath: args.modelPath,
    threads: args.threads,
    gpuLayers: args.gpuLayers,
  });
  await engine.ensureReady();
  return engine;
}
