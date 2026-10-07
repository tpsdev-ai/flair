/**
 * One embedding engine per worker thread, keyed by model path plus addon
 * path. The registry lives on globalThis, so it is per isolate. Node-wide
 * ownership across workers is #2052. Exactly one addon is dlopen'd in that
 * isolate. A failed load stays in the registry, so a later ensureReady does
 * not dlopen again. The addon is the optional `@node-llama-cpp/<platform>` prebuilt
 * for this host (linux-x64 CPU, linux-arm64 CPU, or darwin-arm64 Metal).
 * There is no umbrella `node-llama-cpp` package and no fallback onto
 * harper-fabric-embeddings. A missing or unsupported prebuilt throws; boot
 * skips registration and keyword search remains.
 *
 * The addon is opened the same way the production HFE engine opens it —
 * init, then loadBackends — because getLlama()'s setup does not reproduce
 * those vectors. The bytes are re-verified immediately before AddonModel.
 * The decode path is HFE's batch (one sequence, embeddings on, no extra
 * generated token). embedMany is serialized; the llama.cpp context is not
 * concurrent.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { EmbeddingModelError } from "./errors.js";
import { reverifyBeforeLoad } from "./fetch.js";
import { assertDeclaredPooling } from "./gguf.js";
import { BUILTIN_EMBEDDING_MODEL, type EmbeddingModelEntry } from "./models.js";
import { hostLabel, PINNED_PREBUILT_VERSION, prebuiltForPlatform } from "./platforms.js";
import { versionFromPackageJson } from "./provenance.js";
import { applyEmbeddingTemplate } from "./template.js";

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
  /** Test seam. Production resolves the host platform package from this module. */
  resolvePackage?: (name: string) => string;
  platform?: string;
  arch?: string;
  /** Test seam. Production dlopens the resolved addon. */
  loadBinding?: (addonPath: string) => Promise<NativeBinding>;
  /** Test seam. Production re-verifies the registry file before AddonModel. */
  verifyBeforeLoad?: (entry: EmbeddingModelEntry, modelPath: string) => Promise<void>;
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

const REGISTRY = Symbol.for("flair.embeddings.engine.registry");

interface EngineRegistry {
  byKey: Map<string, FlairEmbeddingEngine>;
  /** Addon path already selected in this worker thread. A second path is refused. */
  addonPath: string | null;
  /** Times loadBinding actually ran. A cached addon does not increment this. */
  loads: number;
  bindings: Map<string, Promise<NativeBinding>>;
}

function registry(): EngineRegistry {
  const g = globalThis as Record<symbol, EngineRegistry | undefined>;
  let reg = g[REGISTRY];
  if (!reg) {
    reg = { byKey: new Map(), addonPath: null, loads: 0, bindings: new Map() };
    g[REGISTRY] = reg;
  }
  return reg;
}

/** How many times this worker thread has dlopen'd an embedding addon. */
export function flairAddonLoadCount(): number {
  return registry().loads;
}

export function createFlairEmbeddingEngine(opts: FlairEngineOptions): FlairEmbeddingEngine {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const addonPath = resolveFlairAddonPath(opts.resolvePackage, platform, arch);
  const key = `${opts.modelPath}\0${addonPath}`;
  const reg = registry();
  const existing = reg.byKey.get(key);
  if (existing && !existing.disposed) return existing;
  if (reg.addonPath != null && reg.addonPath !== addonPath) {
    throw new EmbeddingModelError(
      "engine",
      `[embeddings] this worker thread already loaded ${reg.addonPath}.`,
      "One addon dlopen per worker thread. A second native library is refused. Node-wide sharing across workers is #2052.",
    );
  }
  const engine = new FlairEmbeddingEngine(opts, addonPath, key);
  reg.byKey.set(key, engine);
  reg.addonPath = addonPath;
  return engine;
}

export function _resetFlairEmbeddingEngineForTests(): void {
  const g = globalThis as Record<symbol, EngineRegistry | undefined>;
  delete g[REGISTRY];
}

export class FlairEmbeddingEngine {
  readonly entry: EmbeddingModelEntry;
  readonly modelPath: string;
  readonly threads: number;
  readonly requestedGpuLayers: number;
  readonly #addonPath: string;
  readonly #key: string;
  readonly #loadBinding: ((addonPath: string) => Promise<NativeBinding>) | undefined;
  readonly #verifyBeforeLoad: ((entry: EmbeddingModelEntry, modelPath: string) => Promise<void>) | undefined;
  #gpu: GpuKind | undefined;
  #model: AddonModelHandle | null = null;
  #context: AddonContextHandle | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #ready: Promise<void> | null = null;
  #disposed = false;

  constructor(opts: FlairEngineOptions, addonPath: string, key: string) {
    this.entry = opts.entry ?? BUILTIN_EMBEDDING_MODEL;
    this.modelPath = opts.modelPath;
    this.threads = opts.threads;
    this.requestedGpuLayers = opts.gpuLayers;
    this.#addonPath = addonPath;
    this.#key = key;
    this.#loadBinding = opts.loadBinding;
    this.#verifyBeforeLoad = opts.verifyBeforeLoad;
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
    const reg = registry();
    if (reg.byKey.get(this.#key) === this) reg.byKey.delete(this.#key);
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
    const binding = await acquireBinding(this.#addonPath, this.#loadBinding);
    const gpu = readGpuType(binding.getGpuType());
    const verify = this.#verifyBeforeLoad ?? reverifyBeforeLoad;
    await verify(this.entry, this.modelPath);
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
  resolvePackage: (name: string) => string = (name) => createRequire(import.meta.url).resolve(name),
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const match = prebuiltForPlatform(platform, arch);
  const label = hostLabel(platform, arch);
  if (!match) {
    throw new EmbeddingModelError(
      "prebuilt",
      `[embeddings] platform ${label} has no supported prebuilt ` +
        `(supported: @node-llama-cpp/linux-x64, @node-llama-cpp/linux-arm64, @node-llama-cpp/mac-arm64-metal).`,
      "Run on a supported platform. Refusing to build llama.cpp from source. Embeddings stay on keyword search.",
    );
  }
  let entry: string;
  try {
    entry = resolvePackage(match.packageName);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new EmbeddingModelError(
      "prebuilt",
      `[embeddings] prebuilt ${match.packageName} for platform ${label} is not installed (${detail}).`,
      `Install the optional dependency ${match.packageName}. Refusing to build llama.cpp from source. Embeddings stay on keyword search.`,
    );
  }
  const addon = findAddonBinary(entry);
  if (!addon) {
    throw new EmbeddingModelError(
      "prebuilt",
      `[embeddings] ${match.packageName} for platform ${label} did not contain llama-addon.node.`,
      `Reinstall ${match.packageName}. Refusing to build llama.cpp from source.`,
    );
  }
  assertPinnedAddon(addon, match.packageName);
  return addon;
}

/** Refuse any prebuilt other than the tested pin before process.dlopen. */
function assertPinnedAddon(addonPath: string, packageName: string): void {
  const pkgPath = join(dirname(addonPath), "..", "..", "package.json");
  let text: string;
  try {
    text = readFileSync(pkgPath, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new EmbeddingModelError(
      "prebuilt",
      `[embeddings] ${packageName} package.json at ${pkgPath} is unreadable (${detail}).`,
      `Reinstall ${packageName}@${PINNED_PREBUILT_VERSION}. Refusing to dlopen an untested prebuilt.`,
    );
  }
  try {
    versionFromPackageJson(text, pkgPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new EmbeddingModelError(
      "prebuilt",
      `[embeddings] ${packageName} is not the tested prebuilt ${PINNED_PREBUILT_VERSION}. ${detail}`,
      `Install ${packageName}@${PINNED_PREBUILT_VERSION}. Refusing to dlopen a version that was not tested.`,
    );
  }
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

function acquireBinding(
  addonPath: string,
  load: ((addonPath: string) => Promise<NativeBinding>) | undefined,
): Promise<NativeBinding> {
  const reg = registry();
  let pending = reg.bindings.get(addonPath);
  if (!pending) {
    reg.loads += 1;
    const run = load ?? loadBinding;
    pending = run(addonPath);
    reg.bindings.set(addonPath, pending);
    // A rejection stays. Deleting it let the next ensureReady dlopen again,
    // including when dlopen had already succeeded and init then failed.
  }
  return pending;
}

async function loadBinding(addonPath: string): Promise<NativeBinding> {
  assertPinnedAddon(addonPath, "node-llama-cpp prebuilt");
  const holder: { exports: unknown } = { exports: {} };
  try {
    process.dlopen(holder, addonPath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new EmbeddingModelError(
      "prebuilt",
      `[embeddings] node-llama-cpp prebuilt did not load (${detail}).`,
      "Install the @node-llama-cpp prebuilt for this platform. Refusing to build llama.cpp from source.",
    );
  }
  if (!isNativeBinding(holder.exports)) {
    throw new EmbeddingModelError(
      "prebuilt",
      "[embeddings] node-llama-cpp prebuilt loaded without AddonModel/AddonContext.",
      "Reinstall the pinned platform prebuilt. Refusing to embed through a different decode path.",
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
