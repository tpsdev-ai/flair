/**
 * Positive control for the in-tree engine: the registry GGUF loads and one
 * embed returns 768 normalized dimensions. Skips visibly when the model file
 * is not on disk (the unit lane does not download it).
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { BUILTIN_EMBEDDING_MODEL } from "../../resources/embeddings/models.ts";
import { ensureBuiltinModelFile } from "../../resources/embeddings/fetch.ts";

const modelDir = process.env.FLAIR_MODELS_DIR ?? join(process.cwd(), "models");
const modelFile = join(modelDir, BUILTIN_EMBEDDING_MODEL.file);
const hasModel = existsSync(modelFile) && statSync(modelFile).size === BUILTIN_EMBEDDING_MODEL.bytes;
const gate = hasModel ? describe : describe.skip;
if (!hasModel) {
  console.warn(`[embeddings-flair-load] SKIPPING: ${modelFile} is not the registry blob.`);
}

gate("flair engine loads the pinned nomic file", () => {
  test("positive control: the real file loads and embeds", async () => {
    const { createFlairEmbeddingEngine } = await import("../../resources/embeddings/engine.ts");
    const path = await ensureBuiltinModelFile(modelDir, {
      download: async () => {
        throw new Error("network was used even though the verified file is present");
      },
    });
    expect(path).toBe(modelFile);
    const engine = createFlairEmbeddingEngine({
      modelPath: path,
      threads: 2,
      gpuLayers: 0,
    });
    try {
      await engine.ensureReady();
      const { vectors, tokens } = await engine.embedMany(["parity probe"], { inputType: "query" });
      expect(vectors).toHaveLength(1);
      const vector = vectors[0]!;
      expect(vector.length).toBe(768);
      let sumSq = 0;
      for (const value of vector) sumSq += value * value;
      expect(Math.abs(sumSq - 1)).toBeLessThan(1e-4);
      expect(tokens).toBeGreaterThan(0);
      expect(engine.llama?.gpu).toBe(false);
    } finally {
      await engine.dispose();
    }
  }, 180_000);
});
