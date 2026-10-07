/**
 * One in-process embedding engine per instance. Loads the registry GGUF
 * through the node-llama-cpp prebuilt (never a source build), checks
 * pooling and dims, applies registry templates, and returns L2-normalized
 * vectors. The addon is opened the same way the production HFE engine opens
 * it — init, then loadBackends — because getLlama()'s setup does not
 * reproduce those vectors. The decode path is HFE's batch (one sequence,
 * embeddings on, no extra generated token). embedMany is serialized; the
 * llama.cpp context is not concurrent.
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { EmbeddingModelError } from "./errors.js";
import { assertDeclaredPooling } from "./gguf.js";
import { BUILTIN_EMBEDDING_MODEL, type EmbeddingModelEntry } from "./models.js";
import { applyEmbeddingTemplate } from "./template.js";

/**
 * Same search order harper-fabric-embeddings uses, then the other CPU
 * prebuilts node-llama-cpp publishes. CUDA/Vulkan packages are omitted on
 * purpose: HFE does not select them, and a different binary is a different
 * vector. Resolved from Flair's own `node-llama-cpp` dependency, not from
 * whatever happens to sit in cwd/node_modules.
 */
const ADDON_PACKAGES = [
  "@node-llama-cpp/linux-x64",
  "@node-llama-cpp/mac-arm64-metal",
  "@node-llama-cpp/mac-x64",
  "@node-llama-cpp/linux-arm64",
  "@node-llama-cpp/linux-armv7l",
  "@node-llama-cpp/win-x64",
  "@node-llama-cpp/win-arm64",
] as const;

type GpuKind = "metal" | "cuda" | "vulkan" | false;

const CONTEXT_SIZE = 2048;

export interface EmbedManyOptions {
  inputType?: string;
  task?: string;
  signal?: AbortSignal;
}

export interface FlairEngineOptions {
  entry?: EmbeddingModelEntry;
  modelPath: string;
  threads: number;
  gpuLayers: number;
}

interface AddonModelOptions {
  gpuLayers: number;
  useMmap: boolean;
  useMlock: boolean;
  checkTensors: boolean;
}

interface AddonContextOptions {
  contextSize: number;
  batchSize: number;
  sequences: number;
  embeddings: boolean;
  threads: number;
}

interface AddonModelHandle {
  init(): Promise<boolean>;
  dispose(): Promise<void>;
  tokenBos(): number;
  tokenEos(): number;
  tokenize(text: string, addBos: boolean): ArrayLike<number>;
  getEmbeddingVectorSize(): number;
}

interface AddonContextHandle {
  init(): Promise<boolean>;
  dispose(): Promise<void>;
  disposeSequence(seqId: number): void;
  initBatch(size: number): void;
  addToBatch(seqId: number, pos: number, tokens: Uint32Array, logitIndexes: Uint32Array): unknown;
  decodeBatch(): Promise<void>;
  getEmbedding(length: number): ArrayLike<number>;
}

interface NativeBinding {
  init(): Promise<unknown>;
  loadBackends(dir?: string): void;
  getGpuType(): unknown;
  AddonModel: new (modelPath: string, opts: AddonModelOptions) => AddonModelHandle;
  AddonContext: new (model: AddonModelHandle, opts: AddonContextOptions) => AddonContextHandle;
}

let active: FlairEmbeddingEngine | null = null;
const bindings = new Map<string, Promise<NativeBinding>>();

export function createFlairEmbeddingEngine(opts: FlairEngineOptions): FlairEmbeddingEngine {
  if (active && !active.disposed) {
    throw new EmbeddingModelError(
      "engine",
      "[embeddings] an embedding engine is already loaded in this process.",
      "Reuse the existing engine. One engine per instance.",
    );
  }
  active = new FlairEmbeddingEngine(opts);
  return active;
}

export function _resetFlairEmbeddingEngineForTests(): void {
  active = null;
}

export class FlairEmbeddingEngine {
  readonly entry: EmbeddingModelEntry;
  readonly modelPath: string;
  readonly threads: number;
  readonly requestedGpuLayers: number;
  #gpu: GpuKind | undefined;
  #model: AddonModelHandle | null = null;
  #context: AddonContextHandle | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #ready: Promise<void> | null = null;
  #disposed = false;

  constructor(opts: FlairEngineOptions) {
    this.entry = opts.entry ?? BUILTIN_EMBEDDING_MODEL;
    this.modelPath = opts.modelPath;
    this.threads = opts.threads;
    this.requestedGpuLayers = opts.gpuLayers;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** GPU type reported by the prebuilt that loaded the model. Absent before ensureReady. */
  get llama(): { readonly gpu: GpuKind } | undefined {
    if (this.#gpu === undefined) return undefined;
    return { gpu: this.#gpu };
  }

  /** Layers requested of the loader. 0 when GPU support was disabled. */
  get gpuLayers(): number {
    return this.requestedGpuLayers > 0 ? this.requestedGpuLayers : 0;
  }

  ensureReady(): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(new EmbeddingModelError(
        "engine",
        "[embeddings] engine has been disposed.",
        "Restart the process. Refusing to embed.",
      ));
    }
    if (this.#ready) return this.#ready;
    const attempt = this.#doInit();
    this.#ready = attempt;
    attempt.catch(() => {
      if (this.#ready === attempt) this.#ready = null;
    });
    return attempt;
  }

  async embedMany(
    texts: readonly string[],
    opts: EmbedManyOptions = {},
  ): Promise<{ vectors: Float32Array[]; tokens: number }> {
    opts.signal?.throwIfAborted();
    const run = this.#queue.then(async () => {
      await this.ensureReady();
      const context = this.#context;
      const model = this.#model;
      if (!context || !model || this.#disposed) {
        throw new EmbeddingModelError(
          "engine",
          "[embeddings] engine is not ready.",
          "Restart the process. Refusing to embed.",
        );
      }
      const vectors: Float32Array[] = [];
      let tokens = 0;
      for (const text of texts) {
        opts.signal?.throwIfAborted();
        const prompted = applyEmbeddingTemplate(this.entry, text, opts.inputType, opts.task);
        const sequence = buildTokenSequence(model, prompted);
        if (!sequence) {
          vectors.push(new Float32Array(0));
          continue;
        }
        const vector = await decodeAndEmbed(context, sequence.input);
        if (vector.length !== this.entry.dims) {
          throw new EmbeddingModelError(
            "dims",
            `[embeddings] ${this.entry.id} returned ${vector.length} dimensions; the registry records ${this.entry.dims}.`,
            "Refusing to return a vector from a different space.",
          );
        }
        vectors.push(vector);
        tokens += sequence.tokens;
      }
      return { vectors, tokens };
    });
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    if (active === this) active = null;
    await this.#queue.catch(() => undefined);
    const context = this.#context;
    const model = this.#model;
    this.#context = null;
    this.#model = null;
    this.#gpu = undefined;
    this.#ready = null;
    // The addon stays loaded. Disposing it unregisters ggml backends, and
    // the next load would register them again until the process aborts.
    if (context) await context.dispose().catch(() => undefined);
    if (model) await model.dispose().catch(() => undefined);
  }

  async #doInit(): Promise<void> {
    if (this.#disposed) {
      throw new EmbeddingModelError(
        "engine",
        "[embeddings] engine has been disposed.",
        "Restart the process. Refusing to load the model.",
      );
    }
    await assertDeclaredPooling(this.modelPath, this.entry.pooling);
    const gpuLayers = this.requestedGpuLayers > 0 ? this.requestedGpuLayers : 0;
    const binding = await acquireBinding(resolveFlairAddonPath());
    const gpu = readGpuType(binding.getGpuType());
    let model: AddonModelHandle | null = null;
    let context: AddonContextHandle | null = null;
    try {
      model = new binding.AddonModel(this.modelPath, {
        gpuLayers,
        useMmap: true,
        useMlock: false,
        checkTensors: false,
      });
      if (!(await model.init())) {
        await model.dispose().catch(() => undefined);
        model = null;
        throw new EmbeddingModelError(
          "engine",
          `[embeddings] failed to load ${this.modelPath}.`,
          "Restore the registry file and the platform prebuilt. Refusing to embed.",
        );
      }
      const dims = model.getEmbeddingVectorSize();
      if (dims !== this.entry.dims) {
        throw new EmbeddingModelError(
          "dims",
          `[embeddings] ${this.modelPath} reports ${dims} dimensions; the registry records ${this.entry.dims}.`,
          "Refusing to load a model whose dimensions differ from the registry.",
        );
      }
      context = new binding.AddonContext(model, {
        contextSize: CONTEXT_SIZE,
        batchSize: CONTEXT_SIZE,
        sequences: 1,
        embeddings: true,
        threads: this.threads,
      });
      if (!(await context.init())) {
        await context.dispose().catch(() => undefined);
        context = null;
        throw new EmbeddingModelError(
          "engine",
          `[embeddings] failed to create an embedding context for ${this.modelPath}.`,
          "Restore the registry file and the platform prebuilt. Refusing to embed.",
        );
      }
    } catch (err) {
      if (context) await context.dispose().catch(() => undefined);
      if (model) await model.dispose().catch(() => undefined);
      if (err instanceof EmbeddingModelError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new EmbeddingModelError(
        "engine",
        `[embeddings] failed to load ${this.modelPath} (${detail}).`,
        "Restore the registry file and the platform prebuilt. Refusing to embed.",
      );
    }
    if (this.#disposed) {
      await context.dispose().catch(() => undefined);
      await model.dispose().catch(() => undefined);
      throw new EmbeddingModelError(
        "engine",
        "[embeddings] engine was disposed during load.",
        "Restart the process. Refusing to embed.",
      );
    }
    this.#gpu = gpu;
    this.#model = model;
    this.#context = context;
  }
}

export function resolveFlairAddonPath(
  resolvePackage: (name: string) => string = defaultResolveAddonPackage,
): string {
  const tried: string[] = [];
  for (const name of ADDON_PACKAGES) {
    let entry: string;
    try {
      entry = resolvePackage(name);
    } catch {
      tried.push(name);
      continue;
    }
    const addon = findAddonBinary(entry);
    if (addon) return addon;
    tried.push(name);
  }
  throw new EmbeddingModelError(
    "engine",
    `[embeddings] no node-llama-cpp prebuilt resolved (tried ${tried.join(", ")}).`,
    "Install the @node-llama-cpp prebuilt for this platform. Refusing to build llama.cpp from source.",
  );
}

function defaultResolveAddonPackage(name: string): string {
  const own = createRequire(import.meta.url);
  // node-llama-cpp is an optional peer (#887: a hard dependency installs
  // ~670MB of CUDA/Vulkan prebuilts on every Linux x64 machine). When the
  // peer is present, resolve from its graph. When it is not, the same
  // 3.18.1 platform addon is already installed by harper-fabric-embeddings.
  let anchor: string;
  try {
    anchor = own.resolve("node-llama-cpp");
  } catch {
    anchor = own.resolve("harper-fabric-embeddings");
  }
  return createRequire(anchor).resolve(name);
}

function findAddonBinary(packageEntry: string): string | null {
  const bins = join(dirname(packageEntry), "..", "bins");
  if (!existsSync(bins)) return null;
  let entries: string[];
  try {
    entries = readdirSync(bins);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const addon = join(bins, entry, "llama-addon.node");
    if (existsSync(addon)) return addon;
  }
  return null;
}

function acquireBinding(addonPath: string): Promise<NativeBinding> {
  let pending = bindings.get(addonPath);
  if (!pending) {
    pending = loadBinding(addonPath);
    bindings.set(addonPath, pending);
    pending.catch(() => {
      if (bindings.get(addonPath) === pending) bindings.delete(addonPath);
    });
  }
  return pending;
}

async function loadBinding(addonPath: string): Promise<NativeBinding> {
  const holder: { exports: unknown } = { exports: {} };
  try {
    process.dlopen(holder, addonPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new EmbeddingModelError(
      "engine",
      `[embeddings] node-llama-cpp prebuilt did not load (${detail}).`,
      "Install the @node-llama-cpp prebuilt for this platform. Refusing to build llama.cpp from source.",
    );
  }
  if (!isNativeBinding(holder.exports)) {
    throw new EmbeddingModelError(
      "engine",
      "[embeddings] node-llama-cpp prebuilt loaded without AddonModel/AddonContext.",
      "Reinstall the pinned node-llama-cpp prebuilt. Refusing to embed through a different decode path.",
    );
  }
  const binding = holder.exports;
  await binding.init();
  binding.loadBackends();
  binding.loadBackends(dirname(addonPath));
  return binding;
}

function isNativeBinding(value: unknown): value is NativeBinding {
  if (typeof value !== "object" || value === null) return false;
  return typeof Reflect.get(value, "init") === "function"
    && typeof Reflect.get(value, "loadBackends") === "function"
    && typeof Reflect.get(value, "getGpuType") === "function"
    && typeof Reflect.get(value, "AddonModel") === "function"
    && typeof Reflect.get(value, "AddonContext") === "function";
}

function readGpuType(value: unknown): GpuKind {
  if (value === false || value == null) return false;
  if (value === "metal" || value === "cuda" || value === "vulkan") return value;
  throw new EmbeddingModelError(
    "engine",
    `[embeddings] node-llama-cpp reported an unrecognized GPU type ${JSON.stringify(value)}.`,
    "Reinstall the pinned prebuilt. Refusing to claim a GPU the binding did not name.",
  );
}

/**
 * HFE's token sequence: body tokens from tokenize(text, false), truncated to
 * leave two slots, then BOS/EOS when those markers are not already the ends.
 * An empty tokenization is no sequence — markers are not added.
 */
function buildTokenSequence(
  model: AddonModelHandle,
  text: string,
): { input: Uint32Array; tokens: number } | null {
  const body = Array.from(model.tokenize(text, false));
  if (body.length === 0) return null;
  const maxBody = Math.max(1, CONTEXT_SIZE - 2);
  const sliced = body.length > maxBody ? body.slice(0, maxBody) : body;
  const bos = model.tokenBos();
  const eos = model.tokenEos();
  const parts: number[] = [];
  const first = sliced[0];
  const last = sliced[sliced.length - 1];
  if (bos >= 0 && first !== bos) parts.push(bos);
  for (const token of sliced) parts.push(token);
  if (eos >= 0 && last !== eos) parts.push(eos);
  return { input: Uint32Array.from(parts), tokens: parts.length };
}

async function decodeAndEmbed(context: AddonContextHandle, input: Uint32Array): Promise<Float32Array> {
  context.disposeSequence(0);
  context.initBatch(input.length);
  const logitIndexes = new Uint32Array(input.length);
  for (let i = 0; i < input.length; i++) logitIndexes[i] = i;
  context.addToBatch(0, 0, input, logitIndexes);
  await context.decodeBatch();
  return l2Normalize(context.getEmbedding(input.length));
}

function l2Normalize(values: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(values);
  let sumSq = 0;
  for (let i = 0; i < out.length; i++) sumSq += out[i]! * out[i]!;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return out;
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm;
  return out;
}
