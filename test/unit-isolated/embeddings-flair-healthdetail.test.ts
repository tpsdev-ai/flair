/**
 * HealthDetail warnings for the flair engine. Missing platform packages and
 * a fetch failure are different warnings (flair#2300).
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

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
  setEmbeddingDegrade,
} = await import("../../resources/embeddings/degrade.ts");
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

afterEach(() => {
  _resetEmbeddingDegradeForTests();
  if (savedEngine === undefined) delete process.env.FLAIR_EMBEDDINGS_ENGINE;
  else process.env.FLAIR_EMBEDDINGS_ENGINE = savedEngine;
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
});
