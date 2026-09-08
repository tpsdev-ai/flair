/**
 * Embedding engine internals.
 *
 * `EmbeddingEngine` owns one GGUF model + llama.cpp context and serializes
 * embed calls against it. Multiple engines can coexist in one process — one
 * per registered Harper model entry — so the native addon binding is shared
 * through a process-resident registry keyed by addon path (dlopen of the same
 * path returns the same handle; llama.cpp keeps all state in heap objects, so
 * engines stay independent through the shared native code).
 */

import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { assertDeclaredPooling, POOLING_NAMES, type PoolingName } from './gguf.js';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ModelConfig {
	repo: string;
	file: string;
	templates?: EmbedTemplates;
}

/**
 * Per-inputType prompt templates, declared as data on a model entry (built-in
 * registry or `templates` in engine/config options) instead of detected by
 * model-name heuristics in code. See issue #4.
 *
 * Placeholders are `{name}` tokens: `{text}` is the input text (always
 * provided); `{task}` comes from the embed call's `task` option, falling back
 * to `defaults.task`; any other placeholder must have a value in `defaults`.
 * Literal braces are escaped as `{{` / `}}`. Interpolation is single-pass —
 * placeholder values are never re-scanned for placeholders.
 *
 * A missing template for an inputType means passthrough, and an omitted
 * `inputType` is ALWAYS passthrough regardless of templates — that is the
 * compatibility contract that keeps vectors from older versions comparable.
 */
export interface EmbedTemplates {
	/** Template applied when `inputType: 'document'`. */
	document?: string;
	/** Template applied when `inputType: 'query'`. */
	query?: string;
	/** Fallback values for non-`{text}` placeholders (e.g. `task`, `title`). */
	defaults?: Record<string, string>;
}

export interface EngineOptions {
	/** Absolute path to a .gguf model file. */
	modelPath?: string;
	/** Directory containing (or to download to) model files. */
	modelsDir?: string;
	/** Model name from the built-in registry. */
	modelName?: string;
	/** Token context window size. */
	contextSize?: number;
	/**
	 * Batch processing size. In node-llama-cpp this sets both `n_batch` AND
	 * `n_ubatch` on the llama.cpp context. llama.cpp's encoder asserts
	 * `n_ubatch >= n_tokens` for every input — inputs that tokenize above
	 * `batchSize` trigger `GGML_ASSERT` → `ggml_abort`, killing the host
	 * process. Defaults to `contextSize` so the full context window is
	 * usable out of the box.
	 */
	batchSize?: number;
	/** CPU threads for inference. */
	threads?: number;
	/** Layers to offload to GPU (0 = CPU only). */
	gpuLayers?: number;
	/** Override path to llama-addon.node. */
	addonPath?: string;
	/**
	 * Prompt templates for this model. Overrides the built-in registry entry's
	 * templates; validated at construction (registration time). Without this —
	 * and without registry templates — template-less models fall back to the
	 * legacy nomic name-prefix heuristic.
	 */
	templates?: EmbedTemplates;
	/**
	 * Expected pooling for this model (`'none' | 'mean' | 'cls' | 'last' |
	 * 'rank'`). Verification, not override: the native addon exposes no pooling
	 * option, so the llama.cpp context always uses the model's own
	 * `<arch>.pooling_type` metadata. Declaring the expectation makes init fail
	 * loudly when the GGUF omits or contradicts it — the alternative is a
	 * metadata-less conversion silently mean-pooling a last-token model
	 * (issue #12). Omitted = accept whatever the model resolves to.
	 */
	pooling?: PoolingName;
}

export interface EmbedManyOptions {
	/**
	 * For models that distinguish document-vs-query embeddings. Applies the
	 * model's template for that side (or the legacy nomic prefix for
	 * template-less models). Omitted = passthrough, always.
	 */
	inputType?: 'document' | 'query';
	/**
	 * Free-text task instruction for models whose templates use `{task}`
	 * (instruct-style embedders). Overrides the entry's `templates.defaults.task`.
	 */
	task?: string;
	/** Best-effort cancellation — checked between inputs, not mid-decode. */
	signal?: AbortSignal;
}

export interface EmbedManyResult {
	/** One L2-normalized vector per input, in input order. */
	vectors: Float32Array[];
	/** Total tokens decoded across all inputs (including BOS/EOS). */
	tokens: number;
}

/** Native llama.cpp binding loaded from the platform-specific addon. */
interface LlamaBinding {
	init(): Promise<void>;
	dispose(): Promise<void>;
	loadBackends(dir?: string): void;
	AddonModel: new (
		path: string,
		options: {
			gpuLayers: number;
			useMmap: boolean;
			useMlock: boolean;
			checkTensors: boolean;
		}
	) => LlamaModel;
	AddonContext: new (
		model: LlamaModel,
		options: {
			contextSize: number;
			batchSize: number;
			sequences: number;
			embeddings: boolean;
			threads: number;
		}
	) => LlamaContext;
}

/** Native model handle. */
interface LlamaModel {
	init(): Promise<boolean>;
	dispose(): Promise<void>;
	tokenBos(): number;
	tokenEos(): number;
	tokenize(text: string, addSpecial: boolean): Uint32Array;
	getEmbeddingVectorSize(): number;
}

/**
 * Native embedding context handle. Exported because `decodeAndEmbed` — public
 * so tests can exercise it against a fake — takes one as a parameter;
 * `declaration: true` requires every type reachable from an exported
 * signature to itself be exported.
 */
export interface LlamaContext {
	init(): Promise<boolean>;
	dispose(): Promise<void>;
	initBatch(size: number): void;
	addToBatch(seq: number, pos: number, tokens: Uint32Array, logitIndexes: Uint32Array): void;
	decodeBatch(): Promise<void>;
	getEmbedding(tokenCount: number): Float32Array;
	/**
	 * Evict every KV-cache cell for a sequence (`llama_memory_seq_rm(seq, -1, -1)`
	 * under the hood). Synchronous; throws if the native eviction fails. A no-op
	 * on a sequence with no cached cells (e.g. a freshly created context).
	 */
	disposeSequence(seq: number): void;
}

// ─── Model registry ─────────────────────────────────────────────────────────

const NOMIC_TEMPLATES: EmbedTemplates = {
	document: 'search_document: {text}',
	query: 'search_query: {text}',
};

// EmbeddingGemma (Gemma3-based) uses task-prompt templates, NOT nomic's
// search_* prefixes. The query side carries a task description (default
// "search result", caller-overridable via opts.task); the document side is
// title/text. Ref: google/embeddinggemma-300m model card prompt formats.
const EMBEDDINGGEMMA_TEMPLATES: EmbedTemplates = {
	document: 'title: none | text: {text}',
	query: 'task: {task} | query: {text}',
	defaults: { task: 'search result' },
};

const MODELS: Record<string, ModelConfig> = {
	'nomic-embed-text': {
		repo: 'nomic-ai/nomic-embed-text-v1.5-GGUF',
		file: 'nomic-embed-text-v1.5.Q4_K_M.gguf',
		templates: NOMIC_TEMPLATES,
	},
	'nomic-embed-text-v2-moe': {
		repo: 'nomic-ai/nomic-embed-text-v2-moe-GGUF',
		file: 'nomic-embed-text-v2-moe.Q4_K_M.gguf',
		templates: NOMIC_TEMPLATES,
	},
	// Opt-in dogfood candidate (Google's on-device embedder). The ggml-org
	// GGUF includes the required dense/pooling layers — earlier community GGUFs
	// dropped them and produced wrong embeddings. 768-dim (Matryoshka).
	'embeddinggemma-300m': {
		repo: 'ggml-org/embeddinggemma-300M-GGUF',
		file: 'embeddinggemma-300M-Q8_0.gguf',
		templates: EMBEDDINGGEMMA_TEMPLATES,
	},
};

// ─── Shared native binding registry ─────────────────────────────────────────

// One dlopen + backend load per addon path, shared across engines and resident
// for the life of the process. Never torn down: dlopen dedups by path, so a
// "fresh" load after a teardown gets the SAME native module back — and
// re-running init()/loadBackends() re-registers backend devices in ggml's
// global registry without unregistering the old entries. ggml_backend_sched_new
// asserts n_backends <= GGML_SCHED_MAX_BACKENDS (16), so ~7 construct/dispose
// cycles abort the host process on Metal (issue #9). Engines still free their
// own model + context in dispose(); the addon handle and its one-time backend
// registrations are process-lifetime. A failed load is evicted so the next
// acquire retries.
const bindings = new Map<string, Promise<LlamaBinding>>();

function acquireBinding(addonPath: string): Promise<LlamaBinding> {
	let promise = bindings.get(addonPath);
	if (!promise) {
		const created = loadBinding(addonPath);
		created.catch(() => {
			if (bindings.get(addonPath) === created) bindings.delete(addonPath);
		});
		bindings.set(addonPath, created);
		promise = created;
	}
	return promise;
}

async function loadBinding(addonPath: string): Promise<LlamaBinding> {
	const binding = loadAddon(addonPath);
	await binding.init();
	// Load GPU/CPU backends from the same directory as the addon binary
	binding.loadBackends();
	binding.loadBackends(path.dirname(addonPath));
	return binding;
}

// ─── Engine ─────────────────────────────────────────────────────────────────

/**
 * One GGUF model + llama.cpp embedding context.
 *
 * - Construction validates configuration synchronously (missing model source,
 *   unknown model name) so misconfiguration fails at registration, not first use.
 * - Heavy work (download, addon + model load) happens in `ensureReady()`, which
 *   is lazy, shared across concurrent callers, and retryable after failure.
 * - `embedMany()` serializes against a per-engine queue — the llama.cpp context
 *   is not safe for concurrent use.
 */
export class EmbeddingEngine {
	#options: EngineOptions;
	#modelIdentity: string;
	#templates: EmbedTemplates | undefined;
	#nomicFallback: boolean;
	#binding: LlamaBinding | null = null;
	#model: LlamaModel | null = null;
	#context: LlamaContext | null = null;
	#bosToken = -1;
	#eosToken = -1;
	// Effective n_ubatch the live context was created with. embedOne truncates
	// against this so oversized inputs return a (shorter) embedding instead of
	// tripping the llama.cpp GGML_ASSERT that kills the host process.
	#maxInputTokens = 0;
	#truncationWarned = false;
	#disposed = false;
	// Set at dispose() entry, before the queue drain. Embeds already queued on an
	// initialized engine complete; anything needing a fresh init (or submitted
	// after) rejects instead of starting native work during shutdown.
	#disposeStarted = false;
	#initPromise: Promise<void> | null = null;
	// Serial queue for embed calls — llama.cpp context is not safe for concurrent use
	#queue: Promise<unknown> = Promise.resolve();

	constructor(options: EngineOptions) {
		if (!options.modelPath && !options.modelsDir) {
			throw new Error('Either modelPath or modelsDir is required');
		}
		const modelName = options.modelName ?? 'nomic-embed-text';
		if (!options.modelPath && !MODELS[modelName]) {
			throw new Error(`Unknown model: ${modelName}. Available: ${Object.keys(MODELS).join(', ')}`);
		}
		// The truncation guard in #embedOne reserves 2 slots for BOS/EOS; an
		// effective batch below 3 can still build a 3-token sequence and trip the
		// llama.cpp GGML_ASSERT that kills the host process. Reject up front.
		const effectiveBatchSize = options.batchSize ?? options.contextSize ?? 2048;
		if (effectiveBatchSize < 3) {
			throw new Error(`batchSize must be at least 3 (one body token plus BOS/EOS), got ${effectiveBatchSize}`);
		}
		if (options.pooling !== undefined && !POOLING_NAMES.includes(options.pooling)) {
			throw new Error(`Unknown pooling '${String(options.pooling)}' (expected one of: ${POOLING_NAMES.join(', ')})`);
		}
		this.#options = options;
		this.#modelIdentity = options.modelPath ? path.basename(options.modelPath) : modelName;
		const templates = resolveEngineTemplates(options);
		if (templates) validateTemplates(templates);
		this.#templates = templates;
		this.#nomicFallback = /nomic-embed-text/i.test(this.#modelIdentity);
	}

	/** Model name (or model file basename) — used for backend naming and prefix detection. */
	get modelIdentity(): string {
		return this.#modelIdentity;
	}

	/**
	 * Kick off (or join) initialization. Lazy and retryable: a failed attempt
	 * resets so the next call tries again (e.g. a transient download failure).
	 */
	ensureReady(): Promise<void> {
		if (this.#initPromise) return this.#initPromise;
		const attempt = this.#doInit();
		this.#initPromise = attempt;
		attempt.catch(() => {
			if (this.#initPromise === attempt) this.#initPromise = null;
		});
		return attempt;
	}

	async #doInit(): Promise<void> {
		if (this.#disposed || this.#disposeStarted) throw new Error('Engine has been disposed.');

		const {
			modelPath: explicitPath,
			modelsDir,
			modelName = 'nomic-embed-text',
			contextSize = 2048,
			batchSize: explicitBatchSize,
			threads = 6,
			gpuLayers = 0,
			addonPath,
		} = this.#options;

		// node-llama-cpp's AddonContext ties n_batch and n_ubatch to `batchSize`,
		// and llama.cpp aborts (GGML_ASSERT -> ggml_abort, kills the host process)
		// when any input tokenizes above n_ubatch. Default to contextSize so the
		// full declared context window is actually embeddable.
		const batchSize = explicitBatchSize ?? contextSize;

		// Resolve the model BEFORE touching the addon: the common misconfiguration
		// (bad path, missing file) never churns the shared binding refcount.
		let modelPath = explicitPath;
		if (!modelPath) {
			modelPath = await resolveModelPath(modelsDir!, modelName);
		}
		if (!existsSync(modelPath)) throw new Error(`Model file not found: ${modelPath}`);

		// Same principle as resolving the model first: verify pooling before the
		// addon is touched, so a wrong-pooling model never churns the binding
		// refcount or pays a model load just to be rejected.
		if (this.#options.pooling) {
			await assertDeclaredPooling(modelPath, this.#options.pooling);
		}

		const resolvedAddonPath = addonPath || findAddonBinary();
		const binding = await acquireBinding(resolvedAddonPath);
		let model: LlamaModel | null = null;
		let context: LlamaContext | null = null;
		try {
			model = new binding.AddonModel(modelPath, {
				gpuLayers,
				useMmap: true,
				useMlock: false,
				checkTensors: false,
			});
			if (!(await model.init())) {
				// Dispose before nulling: a false init() may still hold native
				// resources, and the catch below skips dispose for a null model.
				await model.dispose().catch(() => {});
				model = null;
				throw new Error('Failed to load model');
			}
			context = new binding.AddonContext(model, {
				contextSize,
				batchSize,
				sequences: 1,
				embeddings: true,
				threads,
			});
			if (!(await context.init())) {
				context = null;
				throw new Error('Failed to create embedding context');
			}
			if (this.#disposed) throw new Error('Engine has been disposed.');
		} catch (err) {
			if (context) await context.dispose().catch(() => {});
			if (model) await model.dispose().catch(() => {});
			throw err;
		}

		// Commit state only after everything succeeds
		this.#binding = binding;
		this.#model = model;
		this.#context = context;
		this.#bosToken = model.tokenBos();
		this.#eosToken = model.tokenEos();
		this.#maxInputTokens = batchSize;
	}

	/**
	 * Generate one L2-normalized vector per input, in input order.
	 *
	 * Serialized against the engine's queue; init is awaited lazily on first
	 * call. `opts.signal` is checked between inputs (best-effort — a decode in
	 * flight can't be interrupted).
	 */
	embedMany(texts: string[], opts: EmbedManyOptions = {}): Promise<EmbedManyResult> {
		// Fail an already-aborted call synchronously instead of parking it in the queue.
		opts.signal?.throwIfAborted();
		const result = this.#queue.then(async () => {
			await this.ensureReady();
			this.#assertReady();
			const vectors: Float32Array[] = [];
			let tokens = 0;
			for (const text of texts) {
				opts.signal?.throwIfAborted();
				const one = await this.#embedOne(this.#applyTemplate(text, opts));
				vectors.push(one.vector);
				tokens += one.tokens;
			}
			return { vectors, tokens };
		});
		this.#queue = result.catch(() => {});
		return result;
	}

	/** Get the embedding vector dimensionality. */
	dimensions(): number {
		if (!this.#model) throw new Error('Not initialized. Call init() first.');
		return this.#model.getEmbeddingVectorSize();
	}

	/**
	 * Clean up native resources.
	 *
	 * Drains the embed queue before touching native handles — disposing the
	 * llama.cpp context while a decodeBatch is executing is a use-after-free
	 * that can kill the host process. Embeds accepted before this call complete
	 * (when the engine is initialized); embeds that would need a fresh init
	 * during disposal, and any submitted after, reject with a disposed error.
	 */
	async dispose(): Promise<void> {
		this.#disposeStarted = true;
		await this.#queue.catch(() => {});
		this.#disposed = true;
		this.#initPromise = null;
		if (this.#context) {
			await this.#context.dispose();
			this.#context = null;
		}
		if (this.#model) {
			await this.#model.dispose();
			this.#model = null;
		}
		// The shared addon binding is resident (see the bindings registry) — only
		// this engine's reference is dropped here.
		this.#binding = null;
		this.#bosToken = -1;
		this.#eosToken = -1;
		this.#maxInputTokens = 0;
		this.#truncationWarned = false;
	}

	#assertReady(): void {
		if (this.#disposed) throw new Error('Engine has been disposed.');
		if (!this.#binding || !this.#model || !this.#context) {
			throw new Error('Not initialized. Call init() first.');
		}
	}

	#applyTemplate(text: string, opts: EmbedManyOptions): string {
		const inputType = opts.inputType;
		// Contract: omitted inputType is ALWAYS passthrough, templates or not —
		// input handling stays byte-identical to pre-template versions so
		// existing vectors remain comparable. The explicit two-value check also
		// keeps unrecognized runtime values (`inputType: 'toString'` through the
		// untyped facade path) on the passthrough side instead of resolving
		// prototype properties off the templates object.
		if (inputType !== 'document' && inputType !== 'query') return text;
		const template = this.#templates?.[inputType];
		if (template) {
			const vars: Record<string, string> = { ...this.#templates!.defaults };
			if (opts.task !== undefined) vars.task = opts.task;
			vars.text = text;
			return renderTemplate(template, vars);
		}
		// Legacy fallback for template-less models (explicit modelPath overrides):
		// nomic-embed-text v1.5+ task prefixes, detected by name. Mirrors the
		// convention in Harper's built-in ollama backend.
		if (this.#nomicFallback) {
			return (inputType === 'document' ? 'search_document: ' : 'search_query: ') + text;
		}
		return text;
	}

	/** Generate a single embedding (must be called within the serial queue). */
	async #embedOne(text: string): Promise<{ vector: Float32Array; tokens: number }> {
		let tokens: Uint32Array = this.#model!.tokenize(text, false);
		if (tokens.length === 0) return { vector: new Float32Array(0), tokens: 0 };

		// Belt-and-suspenders: reserve 2 slots for BOS/EOS and truncate anything
		// that would exceed the live context's n_ubatch. Prevents GGML_ASSERT when
		// callers pass an explicit `batchSize` smaller than their real inputs.
		const maxBodyTokens = Math.max(1, this.#maxInputTokens - 2);
		if (tokens.length > maxBodyTokens) {
			if (!this.#truncationWarned) {
				console.warn(
					`[harper-fabric-embeddings] Input tokenized to ${tokens.length} tokens, ` +
						`truncating to ${maxBodyTokens} (batchSize=${this.#maxInputTokens}). ` +
						`Increase batchSize/contextSize if you need longer inputs embedded in full.`
				);
				this.#truncationWarned = true;
			}
			tokens = tokens.subarray(0, maxBodyTokens);
		}

		const input = this.#buildTokenSequence(tokens);
		return decodeAndEmbed(this.#context!, input);
	}

	/** Build the full token sequence with BOS/EOS markers. */
	#buildTokenSequence(tokens: Uint32Array): Uint32Array {
		const parts: number[] = [];

		if (this.#bosToken >= 0 && tokens[0] !== this.#bosToken) {
			parts.push(this.#bosToken);
		}

		for (let i = 0; i < tokens.length; i++) {
			parts.push(tokens[i]);
		}

		if (this.#eosToken >= 0 && tokens[tokens.length - 1] !== this.#eosToken) {
			parts.push(this.#eosToken);
		}

		return new Uint32Array(parts);
	}
}

// ─── Single-sequence decode ─────────────────────────────────────────────────

/**
 * Decode one token sequence against a single-sequence llama.cpp context
 * (`sequences: 1` — see `#doInit`) and return its L2-normalized embedding.
 *
 * Always decodes at `seq=0, pos=0`: there is exactly one KV-cache sequence
 * slot on the context, reused across every call. `disposeSequence(0)` evicts
 * whatever cache cells the *previous* call on this context left behind
 * before writing new cells at pos 0 — without it, a second decode on the
 * same context sees inconsistent KV-cache/position state at pos 0 and
 * `llama_decode` hard-aborts the host process (a native `GGML_ASSERT`, not a
 * catchable JS error). A no-op on a fresh context (issue #8).
 *
 * A free function (not a private method) so it can be unit tested against a
 * fake `LlamaContext` double — the real native context can't be constructed
 * without a loaded GGUF model.
 */
export async function decodeAndEmbed(
	context: LlamaContext,
	input: Uint32Array
): Promise<{ vector: Float32Array; tokens: number }> {
	context.disposeSequence(0);
	context.initBatch(input.length);

	const logitIndexes = new Uint32Array(input.length);
	for (let i = 0; i < input.length; i++) logitIndexes[i] = i;

	context.addToBatch(0, 0, input, logitIndexes);
	await context.decodeBatch();

	// Copy before normalizing — don't assume the addon's returned view stays
	// stable across the next decode.
	const vector = Float32Array.from(context.getEmbedding(input.length));
	l2NormalizeInPlace(vector);
	return { vector, tokens: input.length };
}

// ─── Prompt templates ───────────────────────────────────────────────────────

// One pass: `{{` / `}}` escapes and `{name}` placeholders, matched together so
// values are substituted exactly once and never re-scanned.
const TEMPLATE_TOKEN = /\{\{|\}\}|\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Resolve the templates an engine will use: explicit `options.templates` wins;
 * a registry model falls back to its entry's templates; an explicit `modelPath`
 * with no explicit templates gets none (the legacy name-prefix heuristic still
 * applies at embed time). Exported for tests — the models-backend production
 * path constructs via `modelName` and must resolve the registry branch.
 */
export function resolveEngineTemplates(options: EngineOptions): EmbedTemplates | undefined {
	if (options.templates) return options.templates;
	if (options.modelPath) return undefined;
	return MODELS[options.modelName ?? 'nomic-embed-text']?.templates;
}

/**
 * Validate templates at construction (registration) time, so misconfiguration
 * fails at Harper boot instead of on the first embed call. Unrecognized
 * top-level keys are rejected (a typo'd side like `documnet:` would otherwise
 * silently fall back to unprefixed embeds); every placeholder must be `{text}`,
 * `{task}` (call-suppliable), or covered by `defaults`; any other `{`/`}` must
 * be escaped as `{{` / `}}`.
 */
export function validateTemplates(templates: EmbedTemplates): void {
	if (typeof templates !== 'object' || templates === null || Array.isArray(templates)) {
		throw new Error('templates must be an object with optional document/query strings and a defaults record');
	}
	for (const key of Object.keys(templates)) {
		if (key !== 'document' && key !== 'query' && key !== 'defaults') {
			throw new Error(`templates contains unrecognized key '${key}' (expected 'document', 'query', 'defaults')`);
		}
	}
	// `??` already normalized a null/omitted defaults to `{}`.
	const defaults = templates.defaults ?? {};
	if (typeof defaults !== 'object' || Array.isArray(defaults)) {
		throw new Error('templates.defaults must be a record of string values');
	}
	for (const [key, value] of Object.entries(defaults)) {
		if (typeof value !== 'string') {
			throw new Error(`templates.defaults.${key} must be a string, got ${typeof value}`);
		}
		if (key === 'text') {
			throw new Error("templates.defaults may not define 'text' — it is always the embed input");
		}
	}
	for (const side of ['document', 'query'] as const) {
		const template = templates[side];
		if (template === undefined) continue;
		if (typeof template !== 'string') {
			throw new Error(`templates.${side} must be a string, got ${typeof template}`);
		}
		// Brace hygiene first, so a placeholder typo like `{ text }` reports as an
		// unescaped-brace error rather than a missing-{text} error.
		const residue = template.replace(TEMPLATE_TOKEN, '');
		if (/[{}]/.test(residue)) {
			throw new Error(
				`templates.${side} contains an unescaped '{' or '}' (placeholders are {name}; escape literals as {{ and }})`
			);
		}
		const placeholders = templatePlaceholders(template);
		if (!placeholders.includes('text')) {
			// Without {text} every input renders the same static prompt — identical
			// vectors and silently broken retrieval. Catch the typo at registration.
			throw new Error(`templates.${side} must include the {text} placeholder`);
		}
		for (const name of placeholders) {
			// Object.hasOwn, not `in`: a prototype-property name ({toString},
			// {constructor}) must not satisfy the defaults check.
			if (name !== 'text' && name !== 'task' && !Object.hasOwn(defaults, name)) {
				throw new Error(
					`templates.${side} uses {${name}} which is neither {text}, {task}, nor covered by templates.defaults`
				);
			}
		}
	}
}

function templatePlaceholders(template: string): string[] {
	const names: string[] = [];
	for (const match of template.matchAll(TEMPLATE_TOKEN)) {
		if (match[1]) names.push(match[1]);
	}
	return names;
}

/** Single-pass interpolation. `vars` must cover every placeholder (validated at registration for all but a default-less `{task}`). */
export function renderTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(TEMPLATE_TOKEN, (match, name: string | undefined) => {
		if (match === '{{') return '{';
		if (match === '}}') return '}';
		// Own properties only — a prototype-property placeholder must error, not
		// coerce an inherited function into the prompt.
		const value = Object.hasOwn(vars, name!) ? vars[name!] : undefined;
		if (value === undefined) {
			throw new Error(
				`No value for template placeholder {${name}} — pass it in the embed call (e.g. 'task') or add it to templates.defaults`
			);
		}
		return value;
	});
}

/** L2-normalize in place. A zero vector is left unchanged. */
function l2NormalizeInPlace(vec: Float32Array): void {
	let sumSq = 0;
	for (let i = 0; i < vec.length; i++) {
		sumSq += vec[i] * vec[i];
	}
	const norm = Math.sqrt(sumSq);
	if (norm === 0) return;
	for (let i = 0; i < vec.length; i++) {
		vec[i] /= norm;
	}
}

// ─── Model resolution & download ────────────────────────────────────────────

/**
 * Find an existing model file or download it.
 */
async function resolveModelPath(dir: string, modelName: string): Promise<string> {
	const config = MODELS[modelName];
	if (!config) {
		throw new Error(`Unknown model: ${modelName}. Available: ${Object.keys(MODELS).join(', ')}`);
	}

	mkdirSync(dir, { recursive: true });

	// Check for existing file (hf-prefixed name from node-llama-cpp, or bare name)
	const hfName = `hf_${config.repo.replace('/', '_')}_${config.file}`;
	const hfPath = path.join(dir, hfName);
	if (existsSync(hfPath)) return hfPath;

	const barePath = path.join(dir, config.file);
	if (existsSync(barePath)) return barePath;

	// Scan for any matching .gguf
	const stem = config.file.replace('.gguf', '');
	for (const entry of readdirSync(dir)) {
		if (entry.endsWith('.gguf') && entry.includes(stem)) {
			return path.join(dir, entry);
		}
	}

	// Download from Hugging Face
	return downloadModel(dir, modelName);
}

/**
 * A `.downloading` lock untouched for this long is considered abandoned and is
 * reclaimed. An active download keeps the lock file's mtime fresh — the bytes
 * stream into it — so only a dead owner (SIGKILL / OOM / power loss mid-download)
 * leaves it unmoving.
 */
const LOCK_STALE_MS = 60_000;

/** Total time a worker will wait on other workers before giving up. */
const DOWNLOAD_WAIT_TIMEOUT_MS = 300_000;

/**
 * Download a model from Hugging Face.
 *
 * Cross-worker coordination: exclusive creation of `<file>.downloading` elects
 * one downloader; the rest poll. A lock whose owner died is reclaimed after
 * `LOCK_STALE_MS`, and a waiter whose winner failed (lock vanished, no final
 * file) retakes the lock and retries rather than timing out.
 */
export async function downloadModel(dir: string, modelName = 'nomic-embed-text'): Promise<string> {
	const config = MODELS[modelName];
	if (!config) {
		throw new Error(`Unknown model: ${modelName}. Available: ${Object.keys(MODELS).join(', ')}`);
	}

	mkdirSync(dir, { recursive: true });

	const destPath = path.join(dir, config.file);

	// Already downloaded
	if (existsSync(destPath)) return destPath;

	const tmpPath = destPath + '.downloading';
	const deadline = Date.now() + DOWNLOAD_WAIT_TIMEOUT_MS;

	while (true) {
		reclaimStaleLock(tmpPath);

		// Try to exclusively create the temp file — only one worker wins
		let lockHandle;
		try {
			lockHandle = await open(tmpPath, 'wx');
		} catch {
			// Another worker is downloading — wait for it to finish or fail
			console.log(`[harper-fabric-embeddings] Waiting for another worker to finish downloading ${config.file}...`);
			const outcome = await waitForDownload(destPath, tmpPath, deadline);
			if (outcome === 'complete') return destPath;
			continue; // lock vanished or went stale without a final file — take over
		}

		// We won the lock — download the model
		try {
			console.log(`[harper-fabric-embeddings] Downloading ${config.file} from Hugging Face...`);
			await lockHandle.close();

			const url = `https://huggingface.co/${config.repo}/resolve/main/${config.file}`;
			// HuggingFace 403s anonymous large-file (CDN) downloads in some
			// environments; a free account token clears it. undici strips the
			// Authorization header on the cross-origin redirect to the CDN, so the
			// token never reaches the signed-URL host.
			const token = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN;
			const response = await fetch(url, {
				redirect: 'follow',
				headers: token ? { authorization: `Bearer ${token}` } : undefined,
			});
			if (!response.ok) {
				const hint =
					response.status === 403 && !token
						? ' (HuggingFace may require authentication for large-file downloads — set HF_TOKEN)'
						: '';
				throw new Error(`Download failed: ${response.status} ${response.statusText} — ${url}${hint}`);
			}

			const fileStream = createWriteStream(tmpPath);
			await pipeline(response.body!, fileStream);

			// Rename to final path (atomic on same filesystem)
			await rename(tmpPath, destPath);
			console.log(`[harper-fabric-embeddings] Downloaded ${config.file} to ${destPath}`);
		} catch (err) {
			await unlink(tmpPath).catch(() => {});
			throw err;
		}

		return destPath;
	}
}

/** Remove a `.downloading` lock whose owner died (no mtime movement for `LOCK_STALE_MS`). */
function reclaimStaleLock(tmpPath: string): void {
	try {
		if (Date.now() - statSync(tmpPath).mtimeMs > LOCK_STALE_MS) {
			console.warn(`[harper-fabric-embeddings] Reclaiming stale download lock ${tmpPath}`);
			unlinkSync(tmpPath);
		}
	} catch {
		// No lock file (or it vanished between stat and unlink) — nothing to reclaim.
	}
}

/**
 * Poll until the download completes (`'complete'`), the lock disappears or goes
 * stale without a final file (`'retry'` — the caller retakes the lock), or the
 * deadline passes (throws).
 */
async function waitForDownload(destPath: string, tmpPath: string, deadline: number): Promise<'complete' | 'retry'> {
	while (true) {
		if (existsSync(destPath)) return 'complete';
		let lockAlive: boolean;
		try {
			lockAlive = Date.now() - statSync(tmpPath).mtimeMs <= LOCK_STALE_MS;
		} catch {
			// Lock gone: the winner either renamed to destPath (check again) or failed.
			return existsSync(destPath) ? 'complete' : 'retry';
		}
		if (!lockAlive) return 'retry';
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for model download: ${destPath}`);
		}
		await sleep(500);
	}
}

/**
 * The `@node-llama-cpp/<platform>` packages that ship a prebuilt
 * `llama-addon.node`. This list is the addon-resolution mirror of the
 * `optionalDependencies` this module's host declares (flair's package.json) —
 * Kern review addition (B): the two MUST stay the same set, so a platform that
 * is installable is also discoverable. Adds win-arm64, win-x64 and linux-armv7l
 * over the original four. A per-platform install materializes exactly one of
 * these (the others fail their os/cpu constraint and are skipped), so the loop
 * finds the one that is present.
 */
const ADDON_PLATFORM_PACKAGES = [
	'@node-llama-cpp/linux-arm64',
	'@node-llama-cpp/linux-armv7l',
	'@node-llama-cpp/linux-x64',
	'@node-llama-cpp/mac-arm64-metal',
	'@node-llama-cpp/mac-x64',
	'@node-llama-cpp/win-arm64',
	'@node-llama-cpp/win-x64',
];

/**
 * Every `node_modules` reachable by walking UP the directory tree from
 * `startDir`, nearest first — the same ancestor scan Node's own module
 * resolution performs. Kern review addition (A): after this engine moved into
 * flair's tree its moduleDir is `dist/resources/embeddings`, so the old
 * package-relative roots (`moduleDir/../..`, `moduleDir/../node_modules`) point
 * at directories that no longer contain the platform packages. An
 * import-anchored ancestor walk finds the addon uniformly across every deploy
 * shape — launchd (WorkingDirectory=FLAIR_DIR), Docker (WORKDIR /app) AND the
 * Fabric component process, whose cwd is NOT guaranteed to be the install root —
 * because the platform package hoists into an ancestor `node_modules` of this
 * file regardless of what cwd happens to be.
 */
function ancestorNodeModules(startDir: string): string[] {
	const roots: string[] = [];
	let dir = startDir;
	while (true) {
		roots.push(path.join(dir, 'node_modules'));
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return roots;
}

/**
 * The addon binary a `@node-llama-cpp/<platform>` package ships lives in one of
 * its `bins/<variant>/` subdirs. Return the first `llama-addon.node` found under
 * `binsDir`, or null. Shared by the standard-layout and bun-store scans below.
 */
function addonInBinsDir(binsDir: string): string | null {
	if (!existsSync(binsDir)) return null;
	for (const entry of readdirSync(binsDir)) {
		const addonPath = path.join(binsDir, entry, 'llama-addon.node');
		if (existsSync(addonPath)) return addonPath;
	}
	return null;
}

/**
 * Find the llama-addon.node binary from installed platform packages.
 *
 * Scans node_modules on the filesystem rather than using require.resolve —
 * Harper's sandbox blocks node:module, and the platform packages are
 * binary-only (no entry point for require.resolve / import.meta.resolve to hit
 * anyway), so filesystem scanning is the only resolution mechanism available.
 */
function findAddonBinary(): string {
	const candidates = ADDON_PLATFORM_PACKAGES;

	// fileURLToPath, not URL.pathname: pathname is percent-encoded (spaces → %20)
	// and carries a broken leading slash on Windows, so existsSync would miss.
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	// Root (a): cwd/node_modules — correct under launchd/Docker where cwd is the
	// install root and the platform binary hoists top-level. KEPT (Kern A).
	// Then the module-anchored ancestor walk (Kern A), which supersedes the old
	// package-relative roots that went dead when this engine moved into flair.
	// De-duplicated, first-hit-wins, so ordering only affects which equal binary
	// is returned first.
	const searchRoots = Array.from(
		new Set([path.join(process.cwd(), 'node_modules'), ...ancestorNodeModules(moduleDir)])
	);

	console.log(
		`[harper-fabric-embeddings] findAddonBinary: cwd=${process.cwd()}, searching ${searchRoots.length} roots`
	);

	for (const nmDir of searchRoots) {
		if (!existsSync(nmDir)) continue;

		// Standard layout: <nmDir>/@node-llama-cpp/<platform>/bins/<variant>/llama-addon.node.
		// Covers npm (hoisted or nested under the package) and bun installs that
		// DID materialize a top-level `@node-llama-cpp/<platform>` symlink.
		for (const pkg of candidates) {
			const addonPath = addonInBinsDir(path.join(nmDir, pkg, 'bins'));
			if (addonPath) {
				console.log(`[harper-fabric-embeddings] findAddonBinary: found ${addonPath}`);
				return addonPath;
			}
		}

		// bun isolated store:
		//   <nmDir>/.bun/@node-llama-cpp+<platform>@<ver>/node_modules/@node-llama-cpp/<platform>/bins/...
		// bun's default (isolated) linker extracts every package into this
		// content-addressed store and only symlinks a package top-level when it
		// resolves as a dependency of the current install context. A platform
		// package gated by os/cpu/libc (e.g. @node-llama-cpp/linux-x64, which
		// declares libc:"glibc") can land in the store WITHOUT that top-level
		// symlink — the standard scan above then sees no
		// `<nmDir>/@node-llama-cpp/<platform>` and misses it, degrading semantic
		// search to keyword-only. Scan the store directly so the addon resolves
		// under bun regardless of whether the symlink was created (flair#1549
		// CI: clean-VM + integration-heavy).
		const bunStore = path.join(nmDir, '.bun');
		if (existsSync(bunStore)) {
			for (const storeEntry of readdirSync(bunStore)) {
				if (!storeEntry.startsWith('@node-llama-cpp+')) continue;
				const scopeDir = path.join(bunStore, storeEntry, 'node_modules', '@node-llama-cpp');
				if (!existsSync(scopeDir)) continue;
				for (const platform of readdirSync(scopeDir)) {
					const addonPath = addonInBinsDir(path.join(scopeDir, platform, 'bins'));
					if (addonPath) {
						console.log(`[harper-fabric-embeddings] findAddonBinary: found ${addonPath} (bun store)`);
						return addonPath;
					}
				}
			}
		}
	}

	throw new Error(
		'No llama-addon.node binary found. Install a @node-llama-cpp platform package ' +
			'(e.g., @node-llama-cpp/linux-x64).'
	);
}

/**
 * Load the native addon via process.dlopen.
 *
 * On Linux, dlopen of the same path returns the same handle (OS deduplicates
 * by inode), so all worker threads share the same native .so in memory.
 * This is safe because llama.cpp stores all state in heap-allocated objects
 * (LlamaModel, LlamaContext) rather than C++ globals — each thread operates
 * on its own object instances through the shared native code.
 */
function loadAddon(addonPath: string): LlamaBinding {
	const mod = { exports: {} } as { exports: LlamaBinding };
	process.dlopen(mod, addonPath);
	return mod.exports;
}
