/**
 * embeddings-pooling-templates.test.ts
 *
 * Ported from harper-fabric-embeddings' own unit suite (test/index.test.js)
 * when the embedding engine was absorbed into flair (#1549). Covers the two
 * model-independent invariants that guard stored-vector compatibility:
 *
 *   - GGUF pooling verification (resources/embeddings/gguf.ts): readGgufPooling
 *     parses only metadata, matches `<arch>.pooling_type` by suffix, skips every
 *     other value shape, and assertDeclaredPooling fails LOUD on absent/mismatched
 *     pooling — the safety net that turns a metadata-less conversion silently
 *     mean-pooling a last-token model into a boot-time error.
 *   - Prompt-template rendering/validation/resolution (resources/embeddings/engine.ts):
 *     the nomic `search_document:`/`search_query:` prefixes must render
 *     byte-identically to the legacy strings — one character of drift silently
 *     invalidates every stored HNSW vector.
 *
 * Native-model tests (embedding generation, decode) are NOT ported here — they
 * need a real GGUF + addon and live in the recall/integration suites. These are
 * the pure, model-free checks named in the migration acceptance gate.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EmbeddingEngine,
  renderTemplate,
  resolveEngineTemplates,
  validateTemplates,
  type EngineOptions,
  type EmbedTemplates,
} from "../../resources/embeddings/engine";
import { readGgufPooling, assertDeclaredPooling } from "../../resources/embeddings/gguf";

// Casts used only to feed deliberately-invalid inputs past the compiler so the
// RUNTIME rejection can be asserted — the whole point of these cases.
const asTemplates = (x: unknown) => x as unknown as EmbedTemplates;

describe("renderTemplate", () => {
  it("interpolates {text} and extra placeholders", () => {
    expect(renderTemplate("Instruct: {task}\nQuery: {text}", { task: "find docs", text: "hello" })).toBe(
      "Instruct: find docs\nQuery: hello"
    );
  });

  it("renders {{ and }} as literal braces", () => {
    expect(renderTemplate("{{json}} {text}", { text: "x" })).toBe("{json} x");
  });

  it("is single-pass: placeholder values are not re-expanded", () => {
    expect(renderTemplate("{task} | {text}", { task: "literal {text} inside", text: "x" })).toBe(
      "literal {text} inside | x"
    );
  });

  it("throws on a placeholder with no value", () => {
    expect(() => renderTemplate("Instruct: {task}\nQuery: {text}", { text: "x" })).toThrow(
      /No value for template placeholder \{task\}/
    );
  });

  it("never resolves prototype properties as placeholder values", () => {
    expect(() => renderTemplate("{toString} {text}", { text: "x" })).toThrow(/No value for template placeholder/);
  });

  it("renders the built-in nomic templates byte-identically to the legacy prefixes", () => {
    // Downstream HNSW corpora are stamped against the exact old strings — one
    // character of drift (trailing space, added newline) silently invalidates
    // every stored vector.
    expect(renderTemplate("search_document: {text}", { text: "hello world" })).toBe("search_document: hello world");
    expect(renderTemplate("search_query: {text}", { text: "hello world" })).toBe("search_query: hello world");
    expect(renderTemplate("search_document: {text}", { text: "" })).toBe("search_document: ");
  });

  it("inserts replacement-pattern tokens in values literally (function replacer)", () => {
    expect(renderTemplate("search_document: {text}", { text: "$& $1 $' $$" })).toBe("search_document: $& $1 $' $$");
  });
});

describe("resolveEngineTemplates", () => {
  it("modelName-only construction (the models-backend production path) resolves registry templates", () => {
    const templates = resolveEngineTemplates({ modelsDir: "/x", modelName: "nomic-embed-text" });
    expect(templates?.document).toBe("search_document: {text}");
    expect(templates?.query).toBe("search_query: {text}");
  });

  it("defaults to the nomic-embed-text entry when modelName is omitted", () => {
    const templates = resolveEngineTemplates({ modelsDir: "/x" });
    expect(templates?.document).toBe("search_document: {text}");
  });

  it("explicit modelPath without templates resolves none (legacy-fallback territory)", () => {
    expect(resolveEngineTemplates({ modelPath: "/m.gguf" })).toBeUndefined();
  });

  it("explicit templates win over the registry entry", () => {
    const templates = resolveEngineTemplates({
      modelsDir: "/x",
      modelName: "nomic-embed-text",
      templates: { document: "D {text}" },
    });
    expect(templates?.document).toBe("D {text}");
  });
});

describe("validateTemplates", () => {
  it("accepts a Qwen3-style template block", () => {
    validateTemplates({
      document: "{text}",
      query: "Instruct: {task}\nQuery: {text}",
      defaults: { task: "Given a search query, retrieve relevant passages" },
    });
  });

  it("rejects an unknown placeholder with no default", () => {
    expect(() => validateTemplates({ document: "{title} | {text}" })).toThrow(/\{title\}.*neither/);
  });

  it("rejects unescaped braces (placeholder typos)", () => {
    expect(() => validateTemplates({ document: "search { text }" })).toThrow(/unescaped/);
  });

  it("rejects defaults that define 'text'", () => {
    expect(() => validateTemplates({ document: "{text}", defaults: { text: "nope" } })).toThrow(
      /may not define 'text'/
    );
  });

  it("rejects a non-string template side", () => {
    expect(() => validateTemplates(asTemplates({ document: 42 }))).toThrow(/must be a string/);
  });

  it("rejects a template that omits {text} (static-prompt typo)", () => {
    expect(() => validateTemplates({ query: "Instruct: {task}", defaults: { task: "retrieve" } })).toThrow(
      /must include the \{text\} placeholder/
    );
  });

  it("rejects prototype-property placeholder names (no `in`-chain leak)", () => {
    expect(() => validateTemplates({ query: "{toString} {text}" })).toThrow(/\{toString\}/);
  });

  it("rejects unrecognized top-level keys (a typo like documnet would silently unprefix embeds)", () => {
    expect(() =>
      validateTemplates(asTemplates({ documnet: "search_document: {text}", query: "search_query: {text}" }))
    ).toThrow(/unrecognized key 'documnet'/);
  });
});

describe("gguf pooling verification", () => {
  // Synthetic GGUF builders — header + metadata KVs per the GGUF v3 spec.
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const u64 = (n: number): Buffer => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  const str = (s: string): Buffer => {
    const body = Buffer.from(s, "utf8");
    return Buffer.concat([u64(body.length), body]);
  };
  const kvStr = (key: string, value: string): Buffer => Buffer.concat([str(key), u32(8), str(value)]);
  const kvU32 = (key: string, value: number): Buffer => Buffer.concat([str(key), u32(4), u32(value)]);
  const kvI32 = (key: string, value: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(value);
    return Buffer.concat([str(key), u32(5), b]);
  };
  const kvF32 = (key: string, value: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeFloatLE(value);
    return Buffer.concat([str(key), u32(6), b]);
  };
  const kvBool = (key: string, value: boolean): Buffer =>
    Buffer.concat([str(key), u32(7), Buffer.from([value ? 1 : 0])]);
  const kvStrArray = (key: string, values: string[]): Buffer =>
    Buffer.concat([str(key), u32(9), u32(8), u64(values.length), ...values.map((v) => str(v))]);
  const kvU32Array = (key: string, values: number[]): Buffer =>
    Buffer.concat([str(key), u32(9), u32(4), u64(values.length), ...values.map((v) => u32(v))]);
  const buildGguf = (kvs: Buffer[], { magic = 0x46554747, version = 3 }: { magic?: number; version?: number } = {}) =>
    Buffer.concat([u32(magic), u32(version), u64(0), u64(kvs.length), ...kvs]);

  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hfe-gguf-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const write = (name: string, buffer: Buffer): string => {
    const p = join(dir, name);
    writeFileSync(p, buffer);
    return p;
  };

  it("reads architecture and pooling_type", async () => {
    const p = write("qwen3.gguf", buildGguf([kvStr("general.architecture", "qwen3"), kvU32("qwen3.pooling_type", 3)]));
    expect(await readGgufPooling(p)).toEqual({ architecture: "qwen3", poolingType: 3 });
  });

  it("matches the pooling key by suffix regardless of key order", async () => {
    const p = write("order.gguf", buildGguf([kvU32("bert.pooling_type", 1), kvStr("general.architecture", "bert")]));
    expect(await readGgufPooling(p)).toEqual({ architecture: "bert", poolingType: 1 });
  });

  it("skips unrelated values of every shape, including tokenizer-style string arrays", async () => {
    const p = write(
      "noisy.gguf",
      buildGguf([
        kvStr("general.name", "test model"),
        kvF32("bert.rope.freq_base", 10000),
        kvBool("bert.attention.causal", false),
        kvStrArray("tokenizer.ggml.tokens", ["<s>", "</s>", "hello", "world", "éé"]),
        kvU32Array("bert.layer_sizes", [768, 768, 768]),
        kvStr("general.architecture", "bert"),
        kvI32("bert.pooling_type", 2),
      ])
    );
    expect(await readGgufPooling(p)).toEqual({ architecture: "bert", poolingType: 2 });
  });

  it("reports absent pooling metadata as undefined, not an error", async () => {
    const p = write("bare.gguf", buildGguf([kvStr("general.architecture", "bert")]));
    expect(await readGgufPooling(p)).toEqual({ architecture: "bert" });
  });

  it("rejects a non-GGUF file", async () => {
    const p = write("bad.gguf", buildGguf([], { magic: 0xdeadbeef }));
    await expect(readGgufPooling(p)).rejects.toThrow(/Not a GGUF file/);
  });

  it("rejects unsupported GGUF versions", async () => {
    const p = write("v1.gguf", buildGguf([], { version: 1 }));
    await expect(readGgufPooling(p)).rejects.toThrow(/Unsupported GGUF version 1/);
  });

  it("rejects a truncated file", async () => {
    const whole = buildGguf([kvStr("general.architecture", "qwen3"), kvU32("qwen3.pooling_type", 3)]);
    const p = write("truncated.gguf", whole.subarray(0, whole.length - 6));
    await expect(readGgufPooling(p)).rejects.toThrow(/Unexpected end of file/);
  });

  it("assertDeclaredPooling passes on a match", async () => {
    const p = write("match.gguf", buildGguf([kvStr("general.architecture", "qwen3"), kvU32("qwen3.pooling_type", 3)]));
    await assertDeclaredPooling(p, "last");
  });

  it("assertDeclaredPooling names both sides on a mismatch", async () => {
    const p = write("mismatch.gguf", buildGguf([kvStr("general.architecture", "bert"), kvU32("bert.pooling_type", 1)]));
    await expect(assertDeclaredPooling(p, "last")).rejects.toThrow(/declares pooling 'mean'.*expects 'last'/);
  });

  it("assertDeclaredPooling fails loudly when the model declares nothing", async () => {
    const p = write("undeclared.gguf", buildGguf([kvStr("general.architecture", "bert")]));
    await expect(assertDeclaredPooling(p, "last")).rejects.toThrow(/declares no bert\.pooling_type/);
  });

  it("engine constructor rejects a pooling typo at registration time", () => {
    const badOpts = { modelPath: "/nonexistent.gguf", pooling: "means" } as unknown as EngineOptions;
    expect(() => new EmbeddingEngine(badOpts)).toThrow(/Unknown pooling 'means'/);
  });
});

// ─── EmbeddingGemma registry entry (flair dogfood; no model needed) ──────────

describe("EmbeddingGemma templates (registry)", () => {
  const opts = { modelName: "embeddinggemma-300m" };
  it("resolves embeddinggemma-300m templates from the registry", () => {
    const t = resolveEngineTemplates(opts);
    expect(t).toBeTruthy();
    expect(t?.query).toBe("task: {task} | query: {text}");
    expect(t?.document).toBe("title: none | text: {text}");
    expect(t?.defaults?.task).toBe("search result");
  });
  it("validates at construction time without throwing", () => {
    validateTemplates(resolveEngineTemplates(opts) as EmbedTemplates);
  });
  it("renders the default retrieval query + document prompts", () => {
    const t = resolveEngineTemplates(opts) as EmbedTemplates;
    expect(renderTemplate(t.query as string, { ...t.defaults, text: "hello" })).toBe("task: search result | query: hello");
    expect(renderTemplate(t.document as string, { ...t.defaults, text: "a doc" })).toBe("title: none | text: a doc");
  });
  it("lets a caller override the task description", () => {
    const t = resolveEngineTemplates(opts) as EmbedTemplates;
    expect(renderTemplate(t.query as string, { ...t.defaults, task: "question answering", text: "q" })).toBe(
      "task: question answering | query: q"
    );
  });
});
