import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { tempDir } from "../helpers/temp-dir.ts";
import { EmbeddingModelError } from "../../resources/embeddings/errors.ts";
import { assertDeclaredPooling } from "../../resources/embeddings/gguf.ts";

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

function str(s: string): Buffer {
  return Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
}

/** Minimal GGUF v3 header: architecture + pooling_type, no tensors. */
function gguf(pooling: number): Buffer {
  return Buffer.concat([
    u32(0x46554747),
    u32(3),
    u64(0),
    u64(2),
    str("general.architecture"),
    u32(8),
    str("nomic-bert"),
    str("nomic-bert.pooling_type"),
    u32(4),
    u32(pooling),
  ]);
}

describe("GGUF pooling check", () => {
  it("accepts a declared mean pooling and refuses a different one", async () => {
    const dir = tempDir("flair-gguf-");
    const mean = join(dir, "mean.gguf");
    const last = join(dir, "last.gguf");
    await writeFile(mean, gguf(1));
    await writeFile(last, gguf(3));
    await expect(assertDeclaredPooling(mean, "mean")).resolves.toBeUndefined();
    const err = await assertDeclaredPooling(last, "mean").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingModelError);
    if (err instanceof EmbeddingModelError) expect(err.code).toBe("pooling");
  }, 10_000);

  it("refuses a truncated header instead of treating pooling as absent", async () => {
    const dir = tempDir("flair-gguf-short-");
    const path = join(dir, "short.gguf");
    await writeFile(path, Buffer.from("GGUF"));
    const err = await assertDeclaredPooling(path, "mean").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingModelError);
    if (err instanceof EmbeddingModelError) {
      expect(err.code === "unreadable" || err.code === "pooling").toBe(true);
    }
  }, 10_000);
});
