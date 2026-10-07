import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { tempDir } from "../helpers/temp-dir.ts";
import { EmbeddingModelError } from "../../resources/embeddings/errors.ts";
import {
  _resetFlairEmbeddingEngineForTests,
  createFlairEmbeddingEngine,
  flairAddonLoadCount,
  resolveFlairAddonPath,
} from "../../resources/embeddings/engine.ts";
import { degradeForPrebuiltFailure } from "../../resources/embeddings/degrade.ts";
import { BUILTIN_EMBEDDING_MODEL } from "../../resources/embeddings/models.ts";
import { applyEmbeddingTemplate } from "../../resources/embeddings/template.ts";

const requireFromHere = createRequire(import.meta.url);

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function ggufStr(s: string): Buffer {
  return Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
}

/** Minimal GGUF v3 header with mean pooling, so ensureReady can pass the pooling check. */
function meanGguf(): Buffer {
  return Buffer.concat([
    u32(0x46554747),
    u32(3),
    u64(0),
    u64(2),
    ggufStr("general.architecture"),
    u32(8),
    ggufStr("nomic-bert"),
    ggufStr("nomic-bert.pooling_type"),
    u32(4),
    u32(1),
  ]);
}

afterEach(() => {
  _resetFlairEmbeddingEngineForTests();
});

function plantAddon(root: string, name: string, version = "3.18.1"): string {
  const entry = join(root, name, "dist", "index.js");
  const addon = join(root, name, "bins", "cpu", "llama-addon.node");
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(dirname(addon), { recursive: true });
  writeFileSync(entry, "");
  writeFileSync(addon, "");
  writeFileSync(join(root, name, "package.json"), JSON.stringify({
    name: "@node-llama-cpp/linux-x64",
    version,
  }));
  return entry;
}

function fakeBinding(): {
  init: () => Promise<void>;
  loadBackends: () => void;
  getGpuType: () => false;
  AddonModel: new (modelPath: string, opts: { gpuLayers: number }) => {
    init: () => Promise<boolean>;
    dispose: () => Promise<void>;
    tokenBos: () => number;
    tokenEos: () => number;
    tokenize: (text: string, addBos: boolean) => number[];
    getEmbeddingVectorSize: () => number;
  };
  AddonContext: new (model: unknown, opts: { threads: number }) => {
    init: () => Promise<boolean>;
    dispose: () => Promise<void>;
    disposeSequence: (seqId: number) => void;
    initBatch: (size: number) => void;
    addToBatch: (seqId: number, pos: number, tokens: Uint32Array, logitIndexes: Uint32Array) => void;
    decodeBatch: () => Promise<void>;
    getEmbedding: (length: number) => Float32Array;
  };
} {
  return {
    async init() {},
    loadBackends() {},
    getGpuType: () => false,
    AddonModel: class {
      constructor(_modelPath: string, _opts: { gpuLayers: number }) {}
      async init(): Promise<boolean> { return true; }
      async dispose(): Promise<void> {}
      tokenBos(): number { return 1; }
      tokenEos(): number { return 2; }
      tokenize(_text: string, _addBos: boolean): number[] { return [3]; }
      getEmbeddingVectorSize(): number { return BUILTIN_EMBEDDING_MODEL.dims; }
    },
    AddonContext: class {
      constructor(_model: unknown, _opts: { threads: number }) {}
      async init(): Promise<boolean> { return true; }
      async dispose(): Promise<void> {}
      disposeSequence(_seqId: number): void {}
      initBatch(_size: number): void {}
      addToBatch(_seqId: number, _pos: number, _tokens: Uint32Array, _logitIndexes: Uint32Array): void {}
      async decodeBatch(): Promise<void> {}
      getEmbedding(length: number): Float32Array { return new Float32Array(length); }
    },
  };
}

describe("flair template and degrade", () => {
  it("passes omitted and unrecognized inputType through unchanged", () => {
    const text = "plain text";
    expect(applyEmbeddingTemplate(BUILTIN_EMBEDDING_MODEL, text, undefined, undefined)).toBe(text);
    expect(applyEmbeddingTemplate(BUILTIN_EMBEDDING_MODEL, text, "passage", undefined)).toBe(text);
    expect(applyEmbeddingTemplate(BUILTIN_EMBEDDING_MODEL, text, "document", undefined)).toBe("search_document: plain text");
    expect(applyEmbeddingTemplate(BUILTIN_EMBEDDING_MODEL, text, "query", undefined)).toBe("search_query: plain text");
  });

  it("names the platform and package when embeddings degrade", () => {
    const missing = degradeForPrebuiltFailure(new Error("cannot find module"), "darwin", "arm64");
    expect(missing.platform).toBe("darwin/arm64");
    expect(missing.packageName).toBe("@node-llama-cpp/mac-arm64-metal");
    expect(missing.message).toContain("degraded to keyword search");
    expect(missing.message).toContain("@node-llama-cpp/mac-arm64-metal");
    const unsupported = degradeForPrebuiltFailure(new Error("no"), "win32", "x64");
    expect(unsupported.packageName).toBe("unsupported");
    expect(unsupported.message).toContain("win32/x64");
    expect(unsupported.message).toContain("@node-llama-cpp/linux-x64");
  });
});

describe("flair addon resolution", () => {
  it("resolves llama-addon.node from the host platform package only", () => {
    const seen: string[] = [];
    const addon = resolveFlairAddonPath((name) => {
      seen.push(name);
      return requireFromHere.resolve(name);
    }, "linux", "x64");
    expect(seen).toEqual(["@node-llama-cpp/linux-x64"]);
    expect(addon.endsWith("llama-addon.node")).toBe(true);
    expect(addon.includes("@node-llama-cpp/linux-x64")).toBe(true);
    expect(addon.includes("harper-fabric-embeddings")).toBe(false);
    expect(existsSync(addon)).toBe(true);
  });

  it("names the platform package when that prebuilt does not resolve", () => {
    const miss = (): string => {
      throw new Error("cannot find module");
    };
    let caught: unknown;
    try {
      resolveFlairAddonPath(miss, "darwin", "arm64");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EmbeddingModelError);
    if (!(caught instanceof EmbeddingModelError)) return;
    expect(caught.code).toBe("prebuilt");
    expect(caught.message).toContain("darwin/arm64");
    expect(caught.message).toContain("@node-llama-cpp/mac-arm64-metal");
    expect(caught.remedy).toContain("Refusing to build llama.cpp from source");
    expect(caught.message).not.toContain("harper-fabric-embeddings");
  });

  it("names an unsupported platform and does not scan other packages", () => {
    let called = false;
    let caught: unknown;
    try {
      resolveFlairAddonPath(() => {
        called = true;
        return "/unused";
      }, "win32", "x64");
    } catch (err) {
      caught = err;
    }
    expect(called).toBe(false);
    expect(caught).toBeInstanceOf(EmbeddingModelError);
    if (!(caught instanceof EmbeddingModelError)) return;
    expect(caught.message).toContain("win32/x64");
    expect(caught.message).toContain("@node-llama-cpp/linux-x64");
    expect(caught.remedy).toContain("Refusing to build llama.cpp from source");
  });

  it("does not treat an unreadable package entry as a found addon", () => {
    expect(() => resolveFlairAddonPath(() => "/no/such/prebuilt/dist/index.js", "linux", "arm64")).toThrow(EmbeddingModelError);
  });

  it("dlopens one addon per worker thread and reuses the engine for the same model and addon", async () => {
    const root = tempDir("flair-addon-key-");
    const entry = plantAddon(root, "linux-x64");
    const modelPath = join(root, "model.gguf");
    writeFileSync(modelPath, meanGguf());
    let loads = 0;
    const opts = {
      modelPath,
      threads: 1,
      gpuLayers: 0,
      platform: "linux",
      arch: "x64",
      resolvePackage: () => entry,
      verifyBeforeLoad: async () => {},
      loadBinding: async () => {
        loads += 1;
        return fakeBinding();
      },
    };
    const first = createFlairEmbeddingEngine(opts);
    const second = createFlairEmbeddingEngine(opts);
    expect(second).toBe(first);
    await first.ensureReady();
    await second.ensureReady();
    const otherModel = join(root, "other.gguf");
    writeFileSync(otherModel, meanGguf());
    const third = createFlairEmbeddingEngine({ ...opts, modelPath: otherModel });
    expect(third).not.toBe(first);
    await third.ensureReady();
    expect(loads).toBe(1);
    expect(flairAddonLoadCount()).toBe(1);
  });

  it("refuses a second addon path in the same worker thread", () => {
    const root = tempDir("flair-addon-two-");
    const first = plantAddon(root, "first");
    const second = plantAddon(root, "second");
    createFlairEmbeddingEngine({
      modelPath: join(root, "a.gguf"),
      threads: 1,
      gpuLayers: 0,
      platform: "linux",
      arch: "x64",
      resolvePackage: () => first,
      loadBinding: async () => fakeBinding(),
    });
    expect(() => createFlairEmbeddingEngine({
      modelPath: join(root, "b.gguf"),
      threads: 1,
      gpuLayers: 0,
      platform: "linux",
      arch: "x64",
      resolvePackage: () => second,
      loadBinding: async () => fakeBinding(),
    })).toThrow(/worker thread/);
  });

  it("keeps a failed addon load sticky so a retry does not load again", async () => {
    const root = tempDir("flair-addon-fail-");
    const entry = plantAddon(root, "linux-x64");
    const modelPath = join(root, "model.gguf");
    writeFileSync(modelPath, meanGguf());
    let loads = 0;
    const engine = createFlairEmbeddingEngine({
      modelPath,
      threads: 1,
      gpuLayers: 0,
      platform: "linux",
      arch: "x64",
      resolvePackage: () => entry,
      verifyBeforeLoad: async () => {},
      loadBinding: async () => {
        loads += 1;
        throw new Error("init failed after dlopen");
      },
    });
    await expect(engine.ensureReady()).rejects.toThrow(/init failed after dlopen/);
    await expect(engine.ensureReady()).rejects.toThrow(/init failed after dlopen/);
    expect(loads).toBe(1);
    expect(flairAddonLoadCount()).toBe(1);
  });

  it("refuses a real package layout whose version is not 3.18.1 before dlopen", () => {
    const root = tempDir("flair-pin-bad-");
    const entry = plantAddon(root, "linux-x64", "3.18.2");
    let loads = 0;
    let dlopens = 0;
    const orig = process.dlopen.bind(process);
    process.dlopen = ((module: object, filename: string) => {
      dlopens += 1;
      return orig(module, filename);
    }) as typeof process.dlopen;
    try {
      let caught: unknown;
      try {
        createFlairEmbeddingEngine({
          modelPath: join(root, "model.gguf"),
          threads: 1,
          gpuLayers: 0,
          platform: "linux",
          arch: "x64",
          resolvePackage: () => entry,
          loadBinding: async () => {
            loads += 1;
            return fakeBinding();
          },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EmbeddingModelError);
      if (!(caught instanceof EmbeddingModelError)) return;
      expect(caught.code).toBe("prebuilt");
      expect(caught.message).toContain("3.18.1");
      expect(caught.message).toContain("3.18.2");
      expect(caught.message).toContain("was not tested");
    } finally {
      process.dlopen = orig;
    }
    expect(loads).toBe(0);
    expect(dlopens).toBe(0);
  });

  it("accepts a real package layout pinned to 3.18.1", () => {
    const root = tempDir("flair-pin-ok-");
    const entry = plantAddon(root, "linux-x64", "3.18.1");
    const addon = resolveFlairAddonPath(() => entry, "linux", "x64");
    expect(addon.endsWith(`${join("bins", "cpu", "llama-addon.node")}`)).toBe(true);
    expect(existsSync(addon)).toBe(true);
  });
});
