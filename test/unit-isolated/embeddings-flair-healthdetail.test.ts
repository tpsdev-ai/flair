/**
 * HealthDetail warnings for the flair engine. Missing platform packages and
 * a fetch failure are different warnings (flair#2300).
 */
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { tempDir } from "../helpers/temp-dir.ts";

mock.module("harper", () => {
  const noop = () => {};
  const base: Record<string, unknown> = {
    server: { http: noop, getUser: async () => null },
    databases: { flair: {} },
    Resource: class {},
    logger: { info: noop, warn: noop, error: noop, debug: noop, trace: noop },
  };
  return new Proxy(base, {
    get: (target, prop: string) => (prop in target ? target[prop] : noop),
  });
});

const { HealthDetail } = await import("../../resources/health.ts");
const { resolveFlairAddonPath } = await import("../../resources/embeddings/engine.ts");
const {
  _resetEmbeddingDegradeForTests,
  degradeForActivationFailure,
  getEmbeddingDegrade,
  setEmbeddingDegrade,
} = await import("../../resources/embeddings/degrade.ts");
const {
  _resetEmbeddingsBackendRegistrationForTests,
  registerEmbeddingsBackend,
} = await import("../../resources/embeddings-boot.ts");
const { EmbeddingModelError } = await import("../../resources/embeddings/errors.ts");
const { SUPPORTED_PREBUILTS } = await import("../../resources/embeddings/platforms.ts");

const savedEngine = process.env.FLAIR_EMBEDDINGS_ENGINE;

function detail(): { get: () => Promise<Record<string, unknown>> } {
  const resource = new HealthDetail() as { get: () => Promise<Record<string, unknown>>; getContext?: () => unknown };
  resource.getContext = () => ({ request: { tpsAgent: "agent-x", tpsAgentIsAdmin: false } });
  return resource;
}

function warningsOf(stats: Record<string, unknown>): Array<{ level: string; message: string }> {
  const warnings = stats.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((item): item is { level: string; message: string } => {
    return typeof item === "object" && item !== null && "message" in item && typeof Reflect.get(item, "message") === "string";
  });
}

const savedModels = process.env.FLAIR_MODELS_DIR;
const savedGpu = process.env.FLAIR_EMBED_GPU_LAYERS;
const savedGlobal = (globalThis as { models?: unknown }).models;

afterEach(() => {
  _resetEmbeddingDegradeForTests();
  _resetEmbeddingsBackendRegistrationForTests();
  if (savedEngine === undefined) delete process.env.FLAIR_EMBEDDINGS_ENGINE;
  else process.env.FLAIR_EMBEDDINGS_ENGINE = savedEngine;
  if (savedModels === undefined) delete process.env.FLAIR_MODELS_DIR;
  else process.env.FLAIR_MODELS_DIR = savedModels;
  if (savedGpu === undefined) delete process.env.FLAIR_EMBED_GPU_LAYERS;
  else process.env.FLAIR_EMBED_GPU_LAYERS = savedGpu;
  (globalThis as { models?: unknown }).models = savedGlobal;
});

describe("HealthDetail embedding degrade (flair#2300)", () => {
  test("a missing package on each supported platform is a prebuilt warning", async () => {
    process.env.FLAIR_EMBEDDINGS_ENGINE = "flair";
    for (const prebuilt of SUPPORTED_PREBUILTS) {
      let caught: unknown;
      try {
        resolveFlairAddonPath(() => {
          throw new Error("cannot find module");
        }, prebuilt.platform, prebuilt.arch);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EmbeddingModelError);
      const recorded = degradeForActivationFailure(caught, prebuilt.platform, prebuilt.arch);
      setEmbeddingDegrade(recorded);
      const stats = await detail().get();
      const embedding = stats.embedding as { degrade?: string };
      expect(embedding.degrade).toBe(recorded.message);
      expect(warningsOf(stats)).toContainEqual({ level: "warn", message: recorded.message });
      expect(recorded.message).toContain(prebuilt.packageName);
      expect(recorded.message).toContain("did not load");
      expect(recorded.message).not.toContain("could not be verified or fetched");
    }
  });

  test("a fetch failure is a model-file warning, not a prebuilt load failure", async () => {
    process.env.FLAIR_EMBEDDINGS_ENGINE = "flair";
    const err = new EmbeddingModelError(
      "truncated",
      "[embeddings] download of https://example.invalid/model failed with HTTP 503 unavailable.",
      "Retry when the pinned revision is served. The partial file was removed. Refusing to load.",
    );
    const recorded = degradeForActivationFailure(err, "linux", "x64");
    setEmbeddingDegrade(recorded);
    const stats = await detail().get();
    const embedding = stats.embedding as { degrade?: string };
    expect(embedding.degrade).toBe(recorded.message);
    expect(warningsOf(stats)).toContainEqual({ level: "warn", message: recorded.message });
    expect(recorded.message).toContain("could not be verified or fetched");
    expect(recorded.message).toContain("HTTP 503");
    expect(recorded.message).not.toContain("did not load");
    expect(recorded.packageName).toBe("@node-llama-cpp/linux-x64");
  });

  test("boot surfaces a rejecting downloader on HealthDetail", async () => {
    process.env.FLAIR_EMBEDDINGS_ENGINE = "flair";
    process.env.FLAIR_EMBED_GPU_LAYERS = "0";
    process.env.FLAIR_MODELS_DIR = tempDir("flair-health-fetch-");
    (globalThis as { models?: unknown }).models = {
      defineBackend() { return {}; },
      registerBackend() {},
    };
    _resetEmbeddingsBackendRegistrationForTests();
    _resetEmbeddingDegradeForTests();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))) as unknown as typeof fetch;
    try {
      await registerEmbeddingsBackend();
    } finally {
      globalThis.fetch = origFetch;
    }
    const recorded = getEmbeddingDegrade();
    const message = recorded?.message ?? "";
    expect(message.length).toBeGreaterThan(0);
    const stats = await detail().get();
    const embedding = stats.embedding as { degrade?: string };
    expect(embedding.degrade).toBe(message);
    expect(warningsOf(stats)).toContainEqual({ level: "warn", message });
    expect(recorded?.message).toContain("could not be verified or fetched");
    expect(recorded?.message).toContain("ECONNREFUSED");
    expect(recorded?.message).not.toContain("embeddings did not start");
    expect(recorded?.message).not.toContain("did not load");
  }, 15_000);

  test("boot surfaces a models-directory mkdir failure on HealthDetail", async () => {
    process.env.FLAIR_EMBEDDINGS_ENGINE = "flair";
    process.env.FLAIR_EMBED_GPU_LAYERS = "0";
    const root = tempDir("flair-health-mkdir-");
    const parent = join(root, "locked");
    await mkdir(parent, { mode: 0o500 });
    process.env.FLAIR_MODELS_DIR = join(parent, "models");
    (globalThis as { models?: unknown }).models = {
      defineBackend() { return {}; },
      registerBackend() {},
    };
    _resetEmbeddingsBackendRegistrationForTests();
    _resetEmbeddingDegradeForTests();
    try {
      await registerEmbeddingsBackend();
    } finally {
      await chmod(parent, 0o700);
    }
    const recorded = getEmbeddingDegrade();
    const message = recorded?.message ?? "";
    expect(message.length).toBeGreaterThan(0);
    const stats = await detail().get();
    const embedding = stats.embedding as { degrade?: string };
    expect(embedding.degrade).toBe(message);
    expect(warningsOf(stats)).toContainEqual({ level: "warn", message });
    expect(message).toContain("could not be verified or fetched");
    expect(message).toContain("could not create");
    expect(message).toContain("EACCES");
    expect(recorded?.message).not.toContain("embeddings did not start");
    expect(recorded?.message).not.toContain("did not load");
  }, 15_000);
});
