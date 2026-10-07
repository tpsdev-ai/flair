import { existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { tempDir } from "../helpers/temp-dir.ts";
import { EmbeddingModelError } from "../../resources/embeddings/errors.ts";
import { BUILTIN_EMBEDDING_MODEL } from "../../resources/embeddings/models.ts";
import {
  activateFlairBackend,
  bindFlairBackend,
  type EmbedManyEngine,
  type HarperModelsApi,
} from "../../resources/embeddings/register.ts";
import {
  _resetEmbeddingsBackendRegistrationForTests,
  registerEmbeddingsBackend,
} from "../../resources/embeddings-boot.ts";

function fakeModels(): HarperModelsApi & { calls: string[]; lastEmbed?: HarperModelsApi["defineBackend"] extends (s: infer S) => unknown ? S : never } {
  const calls: string[] = [];
  const api: HarperModelsApi & { calls: string[] } = {
    calls,
    defineBackend(spec) {
      calls.push(`define:${spec.name}`);
      return { name: spec.name, embed: spec.embed };
    },
    registerBackend(kind, id, backend) {
      const name = typeof backend === "object" && backend !== null && "name" in backend
        ? String(Reflect.get(backend, "name"))
        : "?";
      calls.push(`register:${kind}:${id}:${name}`);
    },
  };
  return api;
}

const engine: EmbedManyEngine = {
  gpuLayers: 0,
  llama: { gpu: false },
  async embedMany(texts) {
    return {
      vectors: texts.map(() => Float32Array.from([1, 0])),
      tokens: texts.length,
    };
  },
};

describe("flair backend registration", () => {
  const savedEngine = process.env.FLAIR_EMBEDDINGS_ENGINE;
  const savedModels = process.env.FLAIR_MODELS_DIR;
  const savedGpu = process.env.FLAIR_EMBED_GPU_LAYERS;
  const savedGlobal = (globalThis as { models?: unknown }).models;

  afterEach(() => {
    if (savedEngine === undefined) delete process.env.FLAIR_EMBEDDINGS_ENGINE;
    else process.env.FLAIR_EMBEDDINGS_ENGINE = savedEngine;
    if (savedModels === undefined) delete process.env.FLAIR_MODELS_DIR;
    else process.env.FLAIR_MODELS_DIR = savedModels;
    if (savedGpu === undefined) delete process.env.FLAIR_EMBED_GPU_LAYERS;
    else process.env.FLAIR_EMBED_GPU_LAYERS = savedGpu;
    (globalThis as { models?: unknown }).models = savedGlobal;
    _resetEmbeddingsBackendRegistrationForTests();
  });

  it("binds an in-tree backend via defineBackend then registerBackend", async () => {
    const models = fakeModels();
    bindFlairBackend(models, engine);
    expect(models.calls).toEqual([
      "define:flair:nomic-embed-text-v1.5-Q4_K_M",
      "register:embedding:default:flair:nomic-embed-text-v1.5-Q4_K_M",
    ]);
    const defined = models.defineBackend({
      name: "probe",
      embed: async (input) => {
        const texts = Array.isArray(input) ? input : [input];
        const { vectors, tokens } = await engine.embedMany(texts, { inputType: "document" });
        return { status: "completed" as const, output: vectors, usage: { embeddingTokens: tokens, latencyMs: 0 } };
      },
    });
    if (typeof defined !== "object" || defined === null || !("embed" in defined)) {
      throw new Error("defineBackend did not return an embed function");
    }
    const embed = Reflect.get(defined, "embed");
    if (typeof embed !== "function") throw new Error("embed is not a function");
    const result = await embed("hello", { inputType: "document" });
    expect(result.status).toBe("completed");
    expect(result.output).toHaveLength(1);
    expect(result.usage.embeddingTokens).toBe(1);
  });

  it("does not load or register when the model digest does not match", async () => {
    const dir = tempDir("flair-embed-bad-");
    await writeFile(join(dir, BUILTIN_EMBEDDING_MODEL.file), Buffer.from("not-the-model"));
    const models = fakeModels();
    let loaded = false;
    const err = await activateFlairBackend({
      modelsDir: dir,
      models,
      threads: 1,
      gpuLayers: 0,
      load: async () => {
        loaded = true;
        return engine;
      },
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingModelError);
    if (err instanceof EmbeddingModelError) expect(err.code).toBe("digest-mismatch");
    expect(loaded).toBe(false);
    expect(models.calls).toEqual([]);
  }, 10_000);

  it("does not fetch or register when the models directory is missing", async () => {
    const models = fakeModels();
    let loaded = false;
    const missing = join(tmpdir(), `flair-embed-missing-${process.pid}`);
    const err = await activateFlairBackend({
      modelsDir: missing,
      models,
      threads: 1,
      gpuLayers: 0,
      load: async () => {
        loaded = true;
        return engine;
      },
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingModelError);
    if (err instanceof EmbeddingModelError) expect(err.code).toBe("missing-dir");
    expect(loaded).toBe(false);
    expect(models.calls).toEqual([]);
  }, 10_000);

  it("boot refuses an unknown engine and registers nothing", async () => {
    process.env.FLAIR_EMBEDDINGS_ENGINE = "nope";
    process.env.FLAIR_EMBED_GPU_LAYERS = "0";
    const models = fakeModels();
    (globalThis as { models?: unknown }).models = models;
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    _resetEmbeddingsBackendRegistrationForTests();
    try {
      await registerEmbeddingsBackend();
    } finally {
      console.error = orig;
    }
    expect(models.calls).toEqual([]);
    expect(lines.join("\n")).toMatch(/not a known engine/);
    expect(lines.join("\n")).not.toMatch(/registered/);
  }, 10_000);
});

const realFile = join(process.cwd(), "models", BUILTIN_EMBEDDING_MODEL.file);
const hasRealFile = existsSync(realFile) && statSync(realFile).size === BUILTIN_EMBEDDING_MODEL.bytes;
(hasRealFile ? it : it.skip)(
  "verifies the real registry file and only then binds",
  async () => {
    const models = fakeModels();
    const bound = await activateFlairBackend({
      modelsDir: join(process.cwd(), "models"),
      models,
      threads: 1,
      gpuLayers: 0,
      explicitModelPath: realFile,
      load: async (args) => {
        expect(args.modelPath).toBe(realFile);
        return engine;
      },
    });
    expect(bound).toBe(engine);
    expect(models.calls[0]).toBe("define:flair:nomic-embed-text-v1.5-Q4_K_M");
    expect(models.calls[1]).toBe("register:embedding:default:flair:nomic-embed-text-v1.5-Q4_K_M");
  },
  60_000,
);
