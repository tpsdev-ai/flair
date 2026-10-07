/**
 * Read `<arch>.pooling_type` from a GGUF header. Stops at the metadata the
 * engine needs; tensor bytes are not loaded. A short or unreadable header
 * refuses — it is not "pooling absent, proceed".
 */
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { EmbeddingModelError } from "./errors.js";
import type { EmbeddingPooling } from "./models.js";

const GGUF_MAGIC = 0x46554747;
const MAX_KEY_LENGTH = 1 << 16;
const MAX_KV_COUNT = 1 << 20;

const POOLING_BY_NAME: Record<EmbeddingPooling, number> = {
  none: 0,
  mean: 1,
  cls: 2,
  last: 3,
  rank: 4,
};

const FIXED_SIZES: Record<number, number> = {
  0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8,
};

class GgufReader {
  #handle: Awaited<ReturnType<typeof open>>;
  #buffer = Buffer.alloc(0);
  #bufferStart = 0;
  #pos = 0;

  constructor(handle: Awaited<ReturnType<typeof open>>) {
    this.#handle = handle;
  }

  async #ensure(n: number): Promise<Buffer> {
    const offset = this.#pos - this.#bufferStart;
    if (offset >= 0 && offset + n <= this.#buffer.length) {
      return this.#buffer.subarray(offset, offset + n);
    }
    const size = Math.max(n, 1 << 20);
    const fresh = Buffer.alloc(size);
    const { bytesRead } = await this.#handle.read(fresh, 0, size, this.#pos);
    if (bytesRead < n) {
      throw new EmbeddingModelError(
        "unreadable",
        `[embeddings] GGUF header ended at offset ${this.#pos} (needed ${n} bytes, got ${bytesRead}).`,
        "Replace the model file with the registry blob. Refusing to load a truncated header.",
      );
    }
    this.#buffer = fresh.subarray(0, bytesRead);
    this.#bufferStart = this.#pos;
    return this.#buffer.subarray(0, n);
  }

  async u32(): Promise<number> {
    const b = await this.#ensure(4);
    this.#pos += 4;
    return b.readUInt32LE(0);
  }

  async u64(): Promise<number> {
    const b = await this.#ensure(8);
    this.#pos += 8;
    const value = b.readBigUInt64LE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new EmbeddingModelError(
        "unreadable",
        `[embeddings] GGUF length at offset ${this.#pos - 8} is outside the safe integer range.`,
        "Replace the model file with the registry blob.",
      );
    }
    return Number(value);
  }

  async numeric(type: number): Promise<number> {
    const size = FIXED_SIZES[type];
    if (size == null) {
      throw new EmbeddingModelError(
        "pooling",
        `[embeddings] pooling_type has GGUF type ${type}, which is not a numeric scalar.`,
        "Use a GGUF whose pooling_type is a numeric metadata value.",
      );
    }
    const b = await this.#ensure(size);
    this.#pos += size;
    switch (type) {
      case 0: return b.readUInt8(0);
      case 1: return b.readInt8(0);
      case 2: return b.readUInt16LE(0);
      case 3: return b.readInt16LE(0);
      case 4: return b.readUInt32LE(0);
      case 5: return b.readInt32LE(0);
      case 6: return b.readFloatLE(0);
      case 7: return b.readUInt8(0);
      case 10:
      case 11: return Number(b.readBigUInt64LE(0));
      case 12: return b.readDoubleLE(0);
      default:
        throw new EmbeddingModelError(
          "pooling",
          `[embeddings] pooling_type type ${type} is not numeric.`,
          "Use a GGUF whose pooling_type is a numeric metadata value.",
        );
    }
  }

  async string(maxLength: number): Promise<string> {
    const length = await this.u64();
    if (length > maxLength) {
      throw new EmbeddingModelError(
        "unreadable",
        `[embeddings] GGUF string length ${length} exceeds ${maxLength}.`,
        "Replace the model file with the registry blob.",
      );
    }
    const b = await this.#ensure(length);
    this.#pos += length;
    return b.toString("utf8");
  }

  skip(n: number): void {
    this.#pos += n;
  }

  async skipString(): Promise<void> {
    this.skip(await this.u64());
  }

  async skipValue(type: number): Promise<void> {
    const fixed = FIXED_SIZES[type];
    if (fixed !== undefined) {
      this.skip(fixed);
      return;
    }
    if (type === 8) {
      await this.skipString();
      return;
    }
    if (type === 9) {
      const elemType = await this.u32();
      const count = await this.u64();
      const elemFixed = FIXED_SIZES[elemType];
      if (elemFixed !== undefined) {
        this.skip(elemFixed * count);
        return;
      }
      if (elemType === 8) {
        for (let i = 0; i < count; i++) await this.skipString();
        return;
      }
      throw new EmbeddingModelError(
        "unreadable",
        `[embeddings] GGUF array element type ${elemType} is not skipped.`,
        "Replace the model file with the registry blob.",
      );
    }
    throw new EmbeddingModelError(
      "unreadable",
      `[embeddings] GGUF value type ${type} is not skipped.`,
      "Replace the model file with the registry blob.",
    );
  }
}

export interface GgufPoolingInfo {
  architecture?: string;
  poolingType?: number;
}

export async function readGgufPooling(modelPath: string): Promise<GgufPoolingInfo> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(modelPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = errorCode(err);
    if (code === "ELOOP") {
      throw new EmbeddingModelError(
        "symlink",
        `[embeddings] model path ${modelPath} is a symlink.`,
        "Put the verified GGUF file itself in the models directory. Refusing to follow a symlink.",
      );
    }
    throw new EmbeddingModelError(
      "unreadable",
      `[embeddings] model file ${modelPath} could not be opened (${code ?? "unknown"}).`,
      "Restore the registry file. Refusing to load an unreadable model.",
    );
  }
  try {
    const reader = new GgufReader(handle);
    const magic = await reader.u32();
    if (magic !== GGUF_MAGIC) {
      throw new EmbeddingModelError(
        "pooling",
        `[embeddings] ${modelPath} is not a GGUF file (magic 0x${magic.toString(16)}).`,
        "Replace it with the registry GGUF. Refusing to load.",
      );
    }
    const version = await reader.u32();
    if (version < 2 || version > 3) {
      throw new EmbeddingModelError(
        "pooling",
        `[embeddings] ${modelPath} has GGUF version ${version}.`,
        "Use a GGUF version 2 or 3 file that matches the registry.",
      );
    }
    await reader.u64();
    const kvCount = await reader.u64();
    if (kvCount > MAX_KV_COUNT) {
      throw new EmbeddingModelError(
        "unreadable",
        `[embeddings] ${modelPath} reports ${kvCount} metadata entries.`,
        "Replace the model file with the registry blob.",
      );
    }
    const info: GgufPoolingInfo = {};
    for (let i = 0; i < kvCount; i++) {
      const key = await reader.string(MAX_KEY_LENGTH);
      const type = await reader.u32();
      if (key === "general.architecture" && type === 8) {
        info.architecture = await reader.string(MAX_KEY_LENGTH);
      } else if (key.endsWith(".pooling_type") && FIXED_SIZES[type] !== undefined) {
        info.poolingType = await reader.numeric(type);
      } else {
        await reader.skipValue(type);
      }
      if (info.architecture !== undefined && info.poolingType !== undefined) break;
    }
    return info;
  } finally {
    await handle.close();
  }
}

export async function assertDeclaredPooling(
  modelPath: string,
  declared: EmbeddingPooling,
): Promise<void> {
  const expected = POOLING_BY_NAME[declared];
  const { architecture, poolingType } = await readGgufPooling(modelPath);
  const arch = architecture ?? "<arch>";
  if (poolingType === undefined) {
    throw new EmbeddingModelError(
      "pooling",
      `[embeddings] ${modelPath} has no ${arch}.pooling_type metadata.`,
      `Use a GGUF that declares pooling '${declared}'. Refusing to load a file whose pooling is unknown.`,
    );
  }
  if (poolingType !== expected) {
    throw new EmbeddingModelError(
      "pooling",
      `[embeddings] ${modelPath} declares pooling type ${poolingType} (${arch}.pooling_type) but the registry expects '${declared}'.`,
      "Point the registry at a file whose pooling matches, or change the registry entry. The engine cannot override pooling.",
    );
  }
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
