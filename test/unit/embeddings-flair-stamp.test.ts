import { afterEach, describe, expect, it } from "bun:test";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { resolveEmbeddingsEngine } from "../../resources/embeddings/flag.ts";
import { BUILTIN_EMBEDDING_MODEL } from "../../resources/embeddings/models.ts";
import { prebuiltForPlatform } from "../../resources/embeddings/platforms.ts";
import { readEmbeddingProvenance } from "../../resources/embeddings/provenance.ts";
import { registryEntryDigest } from "../../resources/embeddings/stamp-key.ts";
import { versionFromPackageJson } from "../../resources/embeddings/version.ts";
import { cliEmbeddingProvenance, cliEmbeddingStamp, flairRegistryDigest } from "../../src/lib/embedding-model-stamp.ts";

const SAVED = {
  engine: process.env.FLAIR_EMBEDDINGS_ENGINE,
  model: process.env.FLAIR_EMBEDDING_MODEL,
  prefix: process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX,
};

afterEach(() => {
  restore("FLAIR_EMBEDDINGS_ENGINE", SAVED.engine);
  restore("FLAIR_EMBEDDING_MODEL", SAVED.model);
  restore("FLAIR_RECALL_HARNESS_FORCE_PREFIX", SAVED.prefix);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("embedding stamp (S1 — default unchanged)", () => {
  it("keeps the gguf stamp when the engine flag is unset", () => {
    delete process.env.FLAIR_EMBEDDINGS_ENGINE;
    delete process.env.FLAIR_EMBEDDING_MODEL;
    delete process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX;
    expect(resolveEmbeddingsEngine()).toBe("hfe");
    expect(getModelId()).toBe("gguf:nomic-embed-text-v1.5-Q4_K_M+searchprefix");
    expect(cliEmbeddingStamp().currentModel).toBe(getModelId());
    expect(cliEmbeddingStamp().bareCurrentModel).toBe("nomic-embed-text-v1.5-Q4_K_M+searchprefix");
  });

  it("stamps flair:<digest>+searchprefix only when the flag is flair", () => {
    delete process.env.FLAIR_RECALL_HARNESS_FORCE_PREFIX;
    process.env.FLAIR_EMBEDDING_MODEL = "some-other-id";
    process.env.FLAIR_EMBEDDINGS_ENGINE = "flair";
    const digest = registryEntryDigest(BUILTIN_EMBEDDING_MODEL);
    expect(digest).toBe(flairRegistryDigest());
    const id = getModelId();
    expect(id).toBe(`flair:${digest}+searchprefix`);
    expect(id).not.toContain("some-other-id");
    expect(id).not.toContain("gguf:");
    expect(id).not.toContain("node-llama-cpp@");
    expect(cliEmbeddingStamp().currentModel).toBe(id);
    expect(cliEmbeddingStamp().bareCurrentModel).toBeNull();
    const server = readEmbeddingProvenance();
    const cli = cliEmbeddingProvenance();
    expect(cli).toEqual(server);
    const host = prebuiltForPlatform(process.platform, process.arch);
    if (!host) throw new Error(`unsupported host ${process.platform}/${process.arch}`);
    expect(cli.prebuiltPackage).toBe(host.packageName);
    expect(cli.prebuiltVersion).toBe("3.18.1");
    expect(cli.llamaCppBuild.length).toBeGreaterThan(0);
    expect(cli.pipelineVersion).toBe("1");
  });

  it("refuses an unknown engine instead of stamping gguf", () => {
    process.env.FLAIR_EMBEDDINGS_ENGINE = "nope";
    expect(() => getModelId()).toThrow(/not a known engine/);
    expect(() => cliEmbeddingStamp()).toThrow(/not a known engine/);
  });

  it("refuses an empty or unreadable node-llama-cpp version body", () => {
    expect(() => versionFromPackageJson("")).toThrow(/empty/);
    expect(() => versionFromPackageJson("{")).toThrow(/not JSON/);
    expect(() => versionFromPackageJson("{}")).toThrow(/no exact x\.y\.z/);
    expect(() => versionFromPackageJson('{"version":"^3.22.1"}')).toThrow(/no exact x\.y\.z/);
    expect(() => versionFromPackageJson('{"version":"3.22.1"}')).toThrow(/3\.18\.1/);
    expect(() => versionFromPackageJson('{"version":"3.22.1"}')).toThrow(/was not tested/);
    expect(versionFromPackageJson('{"version":"3.18.1"}')).toBe("3.18.1");
  });

  it("records the built-in nomic blob exactly", () => {
    expect(BUILTIN_EMBEDDING_MODEL.repo).toBe("nomic-ai/nomic-embed-text-v1.5-GGUF");
    expect(BUILTIN_EMBEDDING_MODEL.revision).toBe("0188c9bf409793f810680a5a431e7b899c46104c");
    expect(BUILTIN_EMBEDDING_MODEL.file).toBe("nomic-embed-text-v1.5.Q4_K_M.gguf");
    expect(BUILTIN_EMBEDDING_MODEL.bytes).toBe(84106624);
    expect(BUILTIN_EMBEDDING_MODEL.sha256).toBe(
      "d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac",
    );
    expect(BUILTIN_EMBEDDING_MODEL.dims).toBe(768);
    expect(BUILTIN_EMBEDDING_MODEL.pooling).toBe("mean");
    expect(BUILTIN_EMBEDDING_MODEL.templates.document).toBe("search_document: {text}");
    expect(BUILTIN_EMBEDDING_MODEL.templates.query).toBe("search_query: {text}");
  });
});
