/**
 * Minimal GGUF header reader — just enough to answer "what pooling does this
 * model declare?" without loading the model.
 *
 * Why it exists (issue #12): the native addon accepts no pooling option, so
 * the llama.cpp context always resolves pooling from the model's own
 * `<arch>.pooling_type` metadata — and when that key is missing (common in
 * third-party GGUF conversions), llama.cpp falls back to an arch-dependent
 * default that may silently mean-pool a last-token model. Degraded vectors,
 * no error. We can't override the pooling, but we CAN verify the file
 * declares what the caller expects and fail loudly at init when it doesn't.
 *
 * Parses only the metadata KV section (never tensor data), early-exits once
 * the interesting keys are found, and skips large values (tokenizer arrays)
 * without materializing them.
 */

import { open } from 'node:fs/promises';

// llama.cpp's llama_pooling_type enum, as written into GGUF metadata.
const POOLING_TYPES = { none: 0, mean: 1, cls: 2, last: 3, rank: 4 } as const;

export type PoolingName = keyof typeof POOLING_TYPES;

export const POOLING_NAMES: readonly PoolingName[] = Object.keys(POOLING_TYPES) as PoolingName[];

function poolingName(value: number): string {
	const entry = Object.entries(POOLING_TYPES).find(([, v]) => v === value);
	return entry ? entry[0] : `unknown(${value})`;
}

export interface GgufPoolingInfo {
	/** `general.architecture`, when present (e.g. `qwen3`, `bert`). */
	architecture?: string;
	/** Value of the `<arch>.pooling_type` key, when declared. */
	poolingType?: number;
}

// GGUF value-type enum (spec: ggml/docs/gguf.md).
const enum GgufType {
	UINT8 = 0,
	INT8 = 1,
	UINT16 = 2,
	INT16 = 3,
	UINT32 = 4,
	INT32 = 5,
	FLOAT32 = 6,
	BOOL = 7,
	STRING = 8,
	ARRAY = 9,
	UINT64 = 10,
	INT64 = 11,
	FLOAT64 = 12,
}

const FIXED_SIZES: Partial<Record<GgufType, number>> = {
	[GgufType.UINT8]: 1,
	[GgufType.INT8]: 1,
	[GgufType.UINT16]: 2,
	[GgufType.INT16]: 2,
	[GgufType.UINT32]: 4,
	[GgufType.INT32]: 4,
	[GgufType.FLOAT32]: 4,
	[GgufType.BOOL]: 1,
	[GgufType.UINT64]: 8,
	[GgufType.INT64]: 8,
	[GgufType.FLOAT64]: 8,
};

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian
// Defensive bounds — a malformed length should error, not attempt a huge read.
const MAX_KEY_LENGTH = 1 << 16;
const MAX_KV_COUNT = 1 << 20;

/** Sequential little-endian reader over a file descriptor with buffered refills and O(1) skips. */
class GgufReader {
	#handle;
	#buffer = Buffer.alloc(0);
	#bufferStart = 0; // absolute file offset of #buffer[0]
	#pos = 0; // absolute read cursor
	static #CHUNK = 1 << 20;

	constructor(handle: Awaited<ReturnType<typeof open>>) {
		this.#handle = handle;
	}

	async #ensure(n: number): Promise<Buffer> {
		const offsetInBuffer = this.#pos - this.#bufferStart;
		if (offsetInBuffer >= 0 && offsetInBuffer + n <= this.#buffer.length) {
			return this.#buffer.subarray(offsetInBuffer, offsetInBuffer + n);
		}
		const size = Math.max(n, GgufReader.#CHUNK);
		const fresh = Buffer.alloc(size);
		const { bytesRead } = await this.#handle.read(fresh, 0, size, this.#pos);
		if (bytesRead < n) {
			throw new Error(`Unexpected end of file at offset ${this.#pos} (needed ${n} bytes, got ${bytesRead})`);
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
			throw new Error(`64-bit value ${value} at offset ${this.#pos - 8} exceeds safe integer range`);
		}
		return Number(value);
	}

	/** Read a numeric metadata value of any integer/float type, coerced to number. */
	async numeric(type: GgufType): Promise<number> {
		const size = FIXED_SIZES[type]!;
		const b = await this.#ensure(size);
		this.#pos += size;
		switch (type) {
			case GgufType.UINT8:
				return b.readUInt8(0);
			case GgufType.INT8:
				return b.readInt8(0);
			case GgufType.UINT16:
				return b.readUInt16LE(0);
			case GgufType.INT16:
				return b.readInt16LE(0);
			case GgufType.UINT32:
				return b.readUInt32LE(0);
			case GgufType.INT32:
				return b.readInt32LE(0);
			case GgufType.FLOAT32:
				return b.readFloatLE(0);
			case GgufType.BOOL:
				return b.readUInt8(0);
			case GgufType.UINT64:
			case GgufType.INT64: {
				const value = b.readBigUInt64LE(0);
				return Number(value); // metadata scalars are small; precision loss impossible in practice
			}
			case GgufType.FLOAT64:
				return b.readDoubleLE(0);
			default:
				throw new Error(`Not a numeric GGUF type: ${type}`);
		}
	}

	async string(maxLength: number): Promise<string> {
		const length = await this.u64();
		if (length > maxLength) {
			throw new Error(`String length ${length} at offset ${this.#pos - 8} exceeds limit ${maxLength}`);
		}
		const b = await this.#ensure(length);
		this.#pos += length;
		return b.toString('utf8');
	}

	skip(n: number): void {
		this.#pos += n;
	}

	async skipString(): Promise<void> {
		this.skip(await this.u64());
	}

	/** Skip a metadata value of the given type without materializing it. */
	async skipValue(type: GgufType): Promise<void> {
		const fixed = FIXED_SIZES[type];
		if (fixed !== undefined) {
			this.skip(fixed);
			return;
		}
		if (type === GgufType.STRING) {
			await this.skipString();
			return;
		}
		if (type === GgufType.ARRAY) {
			const elemType = (await this.u32()) as GgufType;
			const count = await this.u64();
			const elemFixed = FIXED_SIZES[elemType];
			if (elemFixed !== undefined) {
				this.skip(elemFixed * count);
				return;
			}
			if (elemType === GgufType.STRING) {
				// Tokenizer vocabularies land here — one length-prefixed skip per
				// element, buffered reads keep it cheap.
				for (let i = 0; i < count; i++) await this.skipString();
				return;
			}
			throw new Error(`Unsupported GGUF array element type ${elemType}`);
		}
		throw new Error(`Unsupported GGUF value type ${type}`);
	}
}

/**
 * Read `general.architecture` and the model's `<arch>.pooling_type` from a
 * GGUF file's metadata. Matches the pooling key by `.pooling_type` suffix so
 * key order relative to `general.architecture` doesn't matter. Returns what
 * it found; both fields are optional — absence is data, not an error.
 */
export async function readGgufPooling(modelPath: string): Promise<GgufPoolingInfo> {
	const handle = await open(modelPath, 'r');
	try {
		const reader = new GgufReader(handle);
		const magic = await reader.u32();
		if (magic !== GGUF_MAGIC) {
			throw new Error(`Not a GGUF file (bad magic 0x${magic.toString(16)}): ${modelPath}`);
		}
		const version = await reader.u32();
		if (version < 2 || version > 3) {
			throw new Error(`Unsupported GGUF version ${version} in ${modelPath} (supported: 2, 3)`);
		}
		await reader.u64(); // tensor count — not needed
		const kvCount = await reader.u64();
		if (kvCount > MAX_KV_COUNT) {
			throw new Error(`Implausible GGUF metadata count ${kvCount} in ${modelPath}`);
		}

		const info: GgufPoolingInfo = {};
		for (let i = 0; i < kvCount; i++) {
			const key = await reader.string(MAX_KEY_LENGTH);
			const type = (await reader.u32()) as GgufType;
			if (key === 'general.architecture' && type === GgufType.STRING) {
				info.architecture = await reader.string(MAX_KEY_LENGTH);
			} else if (key.endsWith('.pooling_type') && FIXED_SIZES[type] !== undefined) {
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

/**
 * Verify a model file declares the pooling the caller expects. The addon
 * offers no pooling override, so a declaration that isn't in the file cannot
 * be satisfied — fail at init (registration time) instead of silently
 * producing wrong-pooling vectors.
 */
export async function assertDeclaredPooling(modelPath: string, declared: PoolingName): Promise<void> {
	const expected = POOLING_TYPES[declared];
	const { architecture, poolingType } = await readGgufPooling(modelPath);
	const arch = architecture ?? '<arch>';
	if (poolingType === undefined) {
		throw new Error(
			`Model ${modelPath} declares no ${arch}.pooling_type metadata, so llama.cpp will use an ` +
				`arch-dependent default that cannot be overridden through the addon and may not be '${declared}'. ` +
				`Use a GGUF conversion that writes pooling metadata, or remove the 'pooling' option to accept the default.`
		);
	}
	if (poolingType !== expected) {
		throw new Error(
			`Model ${modelPath} declares pooling '${poolingName(poolingType)}' (${arch}.pooling_type=${poolingType}) ` +
				`but the config expects '${declared}'. The addon cannot override model pooling — fix the config or the model file.`
		);
	}
	console.log(
		`[harper-fabric-embeddings] pooling verified: '${declared}' (${arch}.pooling_type=${poolingType}) for ${modelPath}`
	);
}
