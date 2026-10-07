import { existsSync, statSync } from "node:fs";
import { chmod, readdir, writeFile } from "node:fs/promises";
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

interface HarperModelsModule {
  Models: new (
    writer: { write: (record: unknown) => void },
    emit: () => void,
  ) => HarperModelsApi & { embed: (input: string | string[]) => Promise<Float32Array[]> };
  ModelCallAnalyticsWriter: new (opts: {
    flushIntervalMs: number;
    cleanupIntervalMs: number;
    getTable: () => { put: () => Promise<void> };
  }) => { write: (record: unknown) => void };
  clearRegistry: () => void;
  clearRouting: () => void;
}

async function loadHarperModels(): Promise<HarperModelsModule> {
  // A variable specifier so the test typecheck does not follow Harper's own
  // sources. Runtime still loads the production Models facade.
  const base = new URL("../../node_modules/harper/dist/resources/models/", import.meta.url);
  const modelsMod: { Models: HarperModelsModule["Models"] } = await import(new URL("Models.js", base).href);
  const registryMod: { clearRegistry: () => void } = await import(new URL("backendRegistry.js", base).href);
  const analyticsMod: { ModelCallAnalyticsWriter: HarperModelsModule["ModelCallAnalyticsWriter"] } = await import(new URL("analyticsTable.js", base).href);
  const routingMod: { clearRouting: () => void } = await import(new URL("routing.js", base).href);
  return {
    Models: modelsMod.Models,
    ModelCallAnalyticsWriter: analyticsMod.ModelCallAnalyticsWriter,
    clearRegistry: registryMod.clearRegistry,
    clearRouting: routingMod.clearRouting,
  };
}

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

  it("quarantines a mismatched file and does not register when the refetch fails", async () => {
    const dir = tempDir("flair-embed-bad-");
    await writeFile(join(dir, BUILTIN_EMBEDDING_MODEL.file), Buffer.from("not-the-model"));
    const models = fakeModels();
    let loaded = false;
    let fetched = false;
    const err = await activateFlairBackend({
      modelsDir: dir,
      models,
      threads: 1,
      gpuLayers: 0,
      download: async () => {
        fetched = true;
        return { ok: false, status: 500, statusText: "no", body: null };
      },
      load: async () => {
        loaded = true;
        return engine;
      },
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingModelError);
    expect(fetched).toBe(true);
    expect(loaded).toBe(false);
    expect(models.calls).toEqual([]);
    const names = await readdir(dir);
    expect(names.some((name) => name.startsWith(`${BUILTIN_EMBEDDING_MODEL.file}.quarantine-`))).toBe(true);
    expect(names).not.toContain(BUILTIN_EMBEDDING_MODEL.file);
  }, 10_000);

  it("does not register when the models directory is group-writable", async () => {
    const dir = tempDir("flair-embed-open-");
    await chmod(dir, 0o777);
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
    if (err instanceof EmbeddingModelError) expect(err.message).toMatch(/group or other writable/);
    expect(loaded).toBe(false);
    expect(models.calls).toEqual([]);
  }, 10_000);

  it("registers the production callback on Harper models.embed and surfaces a failure", async () => {
    const loaded = await loadHarperModels();
    loaded.clearRegistry();
    loaded.clearRouting();
    try {
      const writer = new loaded.ModelCallAnalyticsWriter({
        flushIntervalMs: 3_600_000,
        cleanupIntervalMs: 3_600_000,
        getTable: () => ({ put: async () => undefined }),
      });
      const models = new loaded.Models(writer, () => undefined);
      let calls = 0;
      bindFlairBackend(models, {
        async embedMany(texts) {
          calls += 1;
          const first = texts[0];
          if (first === "fail") throw new Error("embed failed");
          return { vectors: texts.map(() => Float32Array.from([1, 0, 0])), tokens: 1 };
        },
      });
      const vectors = await models.embed("hello");
      expect(vectors).toHaveLength(1);
      expect(vectors[0]?.length).toBe(3);
      expect(calls).toBe(1);
      await expect(models.embed("fail")).rejects.toThrow(/embed failed/);
      expect(calls).toBe(2);
    } finally {
      loaded.clearRegistry();
      loaded.clearRouting();
    }
  }, 15_000);

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
