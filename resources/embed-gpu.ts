/**
 * embed-gpu.ts — stated gpuLayers default for in-process embedding (flair#1437).
 *
 * Harper-free so the detect → derive → override → readback decision is
 * unit-testable without a live engine. embeddings-boot.ts is the only
 * production caller that talks to HFE; Health/HealthDetail read the stated
 * snapshot.
 *
 * Engagement is read from the engine after warmup (flair#2031). node-llama-cpp
 * reports the loaded GPU backend as `Llama.gpu` / binding `getGpuType()`
 * (`"metal" | "cuda" | "vulkan" | false`) and the offloaded layer count as
 * `LlamaModel.gpuLayers` (the `n_gpu_layers` the model was constructed with;
 * 0 when GPU support is disabled). HFE's `EmbeddingEngine` does not re-export
 * those getters; it forwards `config.gpuLayers` unchanged into `AddonModel`
 * and loads the same native binding. An empty stdout/stderr capture is not
 * evidence of CPU — ggml writes `ggml_metal_init` to fd 2 via libc, which
 * under launchd never reaches Node's streams. The launchd stderr log is not
 * consulted either (host-specific, stale across restarts).
 *
 * `parseMetalEngaged` remains the ingest-throughput bench's log gate (#1597).
 * It is not the product engagement decision.
 */
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const METAL_PREBUILT = "@node-llama-cpp/mac-arm64-metal";

/**
 * Fail-loud sentence. Only when the engine itself reports no GPU.
 * Never report GPU while this is the live statement.
 */
export const EMBED_GPU_FALLBACK_MSG =
  "requested GPU offload; Metal did not engage; running CPU";

/**
 * Offload was requested and the engine exposed no GPU type / layer count.
 * This is not a CPU claim — Health must not pair it with `backend: "cpu"`
 * or `gpuLayers: 0`.
 */
export const EMBED_GPU_UNCONFIRMED_MSG =
  "requested GPU offload; Metal engagement unconfirmed";

export type EmbedGpuBackend = "metal" | "cpu" | "unconfirmed";
export type EmbedGpuSource = "detected" | "env" | "default";

export interface EmbedGpuStatement {
  backend: EmbedGpuBackend;
  /**
   * Offloaded layers the engine reported.
   * `null` when engagement is unconfirmed — never a fabricated 0.
   */
  gpuLayers: number | null;
  source: EmbedGpuSource;
  /** Present only when the engine reported CPU after a GPU offload request. */
  fallback?: string;
}

export interface MetalDetectInput {
  platform?: string;
  arch?: string;
  /** Injected resolver — production uses Node module resolution. */
  resolve?: (specifier: string) => string;
  /** Test override; when set, platform/resolve are not consulted. */
  usable?: boolean;
}

export interface EmbedGpuChoice {
  gpuLayers: number;
  source: EmbedGpuSource;
  metalUsable: boolean;
}

export interface MetalReadback {
  engaged: boolean;
  hasInit: boolean;
  hasComputeBuffer: boolean;
  evidence: string[];
}

const METAL_INIT_RE = /ggml_metal_init/i;
const METAL_BUFFER_RE = /compute[- ]buffer/i;

let stated: EmbedGpuStatement | null = null;

/**
 * A *usable* Metal backend is darwin+arm64 AND a resolvable
 * `@node-llama-cpp/mac-arm64-metal` prebuilt. Platform alone is not proof
 * (headless / VM / stripped install).
 */
export function detectUsableMetalBackend(input: MetalDetectInput = {}): boolean {
  if (typeof input.usable === "boolean") return input.usable;
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  if (platform !== "darwin" || arch !== "arm64") return false;
  const resolve = input.resolve ?? defaultResolveMetal;
  try {
    resolve(METAL_PREBUILT);
    return true;
  } catch {
    return false;
  }
}

function defaultResolveMetal(specifier: string): string {
  const fromHere = createRequire(import.meta.url);
  try {
    return fromHere.resolve(specifier);
  } catch {
    // Optional dep lives on harper-fabric-embeddings; try from its graph.
    const hfe = fromHere.resolve("harper-fabric-embeddings");
    return createRequire(hfe).resolve(specifier);
  }
}

/**
 * Derived default: usable Metal → 99, else 0. `FLAIR_EMBED_GPU_LAYERS`
 * (non-negative integer) wins. Invalid / empty values fall through to the
 * derived default — they do not omit the field (HFE would then silently
 * keep its own 0, which is exactly the unstated default this issue removes).
 */
export function resolveEmbedGpuChoice(
  env: NodeJS.ProcessEnv = process.env,
  detect: MetalDetectInput = {},
): EmbedGpuChoice {
  const metalUsable = detectUsableMetalBackend(detect);
  const parsed = parseNonNegativeInt(env.FLAIR_EMBED_GPU_LAYERS);
  if (parsed !== undefined) {
    return { gpuLayers: parsed, source: "env", metalUsable };
  }
  if (metalUsable) {
    return { gpuLayers: 99, source: "detected", metalUsable: true };
  }
  return { gpuLayers: 0, source: "default", metalUsable: false };
}

export function resolveEmbedGpuLayers(
  env: NodeJS.ProcessEnv = process.env,
  detect: MetalDetectInput = {},
): number {
  return resolveEmbedGpuChoice(env, detect).gpuLayers;
}

function parseNonNegativeInt(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

/**
 * Bench log gate (#1597 / #1436). Not the product engagement decision —
 * a missing capture is not evidence the engine is on CPU (flair#2031).
 */
export function parseMetalEngaged(log: string): MetalReadback {
  const lines = (log ?? "").split(/\r?\n/);
  const evidence = lines.filter((l) => METAL_INIT_RE.test(l) || METAL_BUFFER_RE.test(l));
  const hasInit = evidence.some((l) => METAL_INIT_RE.test(l));
  const hasComputeBuffer = evidence.some((l) => METAL_BUFFER_RE.test(l));
  return {
    engaged: hasInit && hasComputeBuffer,
    hasInit,
    hasComputeBuffer,
    evidence: evidence.slice(0, 12),
  };
}

/** GPU backend node-llama-cpp's binding reports. `false` means CPU. */
export type NodeLlamaGpuType = "metal" | "cuda" | "vulkan" | false;

/**
 * What the engine reported. `available: false` means the API did not answer —
 * callers must not treat that as CPU.
 */
export type EngineGpuReadback =
  | { available: true; gpu: "metal"; gpuLayers: number }
  | { available: true; gpu: false; gpuLayers: 0 }
  | { available: false };

function isLayerCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isCpuGpuType(value: unknown): boolean {
  return value === false || value === "cpu";
}

function asNodeLlamaGpu(value: unknown): NodeLlamaGpuType | undefined {
  if (value === false || value === "metal" || value === "cuda" || value === "vulkan") {
    return value;
  }
  return undefined;
}

/**
 * Read GPU type and offloaded layer count from an engine object.
 *
 * Recognized shapes (the node-llama-cpp / native binding API, not logs):
 * - `LlamaModel`: numeric `gpuLayers` and `llama.gpu`
 * - the same pair flattened (`gpu` + `gpuLayers`)
 * - binding `getGpuType()` plus numeric `gpuLayers` on the same object
 *
 * `gpu === false` (or `"cpu"`) is the engine saying no GPU device; offloaded
 * layers are then 0, matching `LlamaModel.gpuLayers` when GPU support is
 * disabled. A GPU type without a layer count, or a layer count without a
 * type, is unavailable.
 */
export function readEngineGpuEngagement(engine: unknown): EngineGpuReadback {
  try {
    return readEngineGpuEngagementUnchecked(engine);
  } catch {
    return { available: false };
  }
}

function readEngineGpuEngagementUnchecked(engine: unknown): EngineGpuReadback {
  if (engine == null || typeof engine !== "object") return { available: false };
  const obj = engine as Record<string, unknown>;
  const gpu = readGpuTypeProperty(obj);
  if (isCpuGpuType(gpu)) {
    return { available: true, gpu: false, gpuLayers: 0 };
  }
  const named = asNodeLlamaGpu(gpu);
  if (named === undefined) return { available: false };
  if (named === "metal" && isLayerCount(obj.gpuLayers) && obj.gpuLayers > 0) {
    return { available: true, gpu: "metal", gpuLayers: obj.gpuLayers };
  }
  // cuda/vulkan, metal with 0 layers, or metal without a layer count:
  // not a Metal engagement, and not an engine-stated CPU.
  return { available: false };
}

function readGpuTypeProperty(obj: Record<string, unknown>): unknown {
  const llama = obj.llama;
  if (llama != null && typeof llama === "object" && "gpu" in llama) {
    return (llama as { gpu?: unknown }).gpu;
  }
  if ("gpu" in obj) return obj.gpu;
  if (typeof obj.getGpuType === "function") {
    return (obj.getGpuType as () => unknown)();
  }
  return undefined;
}

/**
 * Binding-level readback used when the engine object does not expose
 * `gpu` / `gpuLayers` (HFE's `EmbeddingEngine`).
 *
 * `gpuType` is `getGpuType()` after warmup. `loadedGpuLayers` is the
 * `gpuLayers` value passed into `AddonModel` — the same number
 * `LlamaModel.gpuLayers` returns when a GPU device is present. It is
 * reported only after the binding says Metal. A CPU binding forces 0.
 * `undefined` (no device enumerated) is unavailable, not CPU.
 */
export function readBindingGpuEngagement(
  gpuType: unknown,
  loadedGpuLayers: number,
): EngineGpuReadback {
  if (isCpuGpuType(gpuType)) {
    return { available: true, gpu: false, gpuLayers: 0 };
  }
  const named = asNodeLlamaGpu(gpuType);
  if (named === "metal" && isLayerCount(loadedGpuLayers) && loadedGpuLayers > 0) {
    return { available: true, gpu: "metal", gpuLayers: loadedGpuLayers };
  }
  return { available: false };
}

/**
 * `getGpuType()` on the native addon HFE already loaded. Does not call
 * `init` or `loadBackends` — repeating those re-registers ggml devices and
 * can abort the process. Missing addon or a throw is `undefined` (unconfirmed),
 * not CPU. Never reads a launchd log file.
 */
export function probeLoadedAddonGpuType(): unknown {
  const addonPath = findLlamaAddonPath();
  if (!addonPath) return undefined;
  try {
    const mod = { exports: {} } as unknown as NodeJS.Module;
    process.dlopen(mod, addonPath);
    const binding = mod.exports as { getGpuType?: () => unknown };
    if (typeof binding?.getGpuType !== "function") return undefined;
    return binding.getGpuType();
  } catch {
    return undefined;
  }
}

function findLlamaAddonPath(): string | undefined {
  let requireFromHfe: NodeRequire;
  try {
    const fromHere = createRequire(import.meta.url);
    const hfe = fromHere.resolve("harper-fabric-embeddings");
    requireFromHfe = createRequire(hfe);
  } catch {
    return undefined;
  }
  for (const spec of addonCandidates()) {
    try {
      const pkgJson = requireFromHfe.resolve(`${spec}/package.json`);
      const binsDir = join(dirname(pkgJson), "bins");
      if (!existsSync(binsDir)) continue;
      for (const entry of readdirSync(binsDir)) {
        const addon = join(binsDir, entry, "llama-addon.node");
        if (existsSync(addon)) return addon;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function addonCandidates(): string[] {
  const host = hostAddonPackage();
  const rest = [
    "@node-llama-cpp/mac-arm64-metal",
    "@node-llama-cpp/linux-x64",
    "@node-llama-cpp/mac-x64",
    "@node-llama-cpp/linux-arm64",
    "@node-llama-cpp/win-x64",
    "@node-llama-cpp/win-arm64",
    "@node-llama-cpp/linux-armv7l",
  ];
  return host ? [host, ...rest.filter((spec) => spec !== host)] : rest;
}

function hostAddonPackage(): string | undefined {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "@node-llama-cpp/mac-arm64-metal";
  }
  if (process.platform === "darwin") return "@node-llama-cpp/mac-x64";
  if (process.platform === "linux" && process.arch === "arm64") {
    return "@node-llama-cpp/linux-arm64";
  }
  if (process.platform === "linux") return "@node-llama-cpp/linux-x64";
  if (process.platform === "win32" && process.arch === "arm64") {
    return "@node-llama-cpp/win-arm64";
  }
  if (process.platform === "win32") return "@node-llama-cpp/win-x64";
  return undefined;
}

function safeProbe(probe: () => unknown): unknown {
  try {
    return probe();
  } catch {
    return undefined;
  }
}

/**
 * Engagement from the engine, not from captured stdio.
 *
 * `warmupLog` / `capturedLog` are accepted and ignored so a launchd capture
 * (empty, or full of markers that never reached Node) cannot decide the
 * statement. `metalUsable` is platform detection, not engagement evidence.
 *
 * When `engine` exposes `gpu` + `gpuLayers` (or `getGpuType()` + `gpuLayers`),
 * that pair wins. Otherwise `probeGpuType` — boot passes
 * `probeLoadedAddonGpuType` — is combined with `requestedGpuLayers`, which
 * is the count HFE passed to `AddonModel`. No probe and no engine fields
 * is unconfirmed.
 */
export function confirmMetalEngagement(opts: {
  requestedGpuLayers: number;
  metalUsable: boolean;
  source: EmbedGpuSource;
  /** Ignored. Captured stdio is not evidence of CPU or Metal. */
  warmupLog?: string;
  /** Ignored. Same contract as `warmupLog`. */
  capturedLog?: string;
  engine?: unknown;
  /**
   * Binding `getGpuType()` seam. Production passes `probeLoadedAddonGpuType`
   * after warmup. Omitted → no native probe (a stub engine with no fields
   * stays unconfirmed).
   */
  probeGpuType?: () => unknown;
}): { engaged: boolean; statement: EmbedGpuStatement } {
  const { requestedGpuLayers, source, engine, probeGpuType } = opts;
  if (requestedGpuLayers <= 0) {
    return { engaged: false, statement: { backend: "cpu", gpuLayers: 0, source } };
  }
  const direct = readEngineGpuEngagement(engine);
  const readback = direct.available
    ? direct
    : probeGpuType
      ? readBindingGpuEngagement(safeProbe(probeGpuType), requestedGpuLayers)
      : { available: false as const };
  return statementFromReadback(source, readback);
}

function statementFromReadback(
  source: EmbedGpuSource,
  readback: EngineGpuReadback,
): { engaged: boolean; statement: EmbedGpuStatement } {
  if (readback.available && readback.gpu === "metal") {
    return {
      engaged: true,
      statement: { backend: "metal", gpuLayers: readback.gpuLayers, source },
    };
  }
  if (readback.available && readback.gpu === false) {
    return {
      engaged: false,
      statement: {
        backend: "cpu",
        gpuLayers: 0,
        source,
        fallback: EMBED_GPU_FALLBACK_MSG,
      },
    };
  }
  return {
    engaged: false,
    statement: { backend: "unconfirmed", gpuLayers: null, source },
  };
}

/**
 * Pre-confirmation view. A requested offload does not claim Metal and does
 * not claim CPU / `gpuLayers: 0` before the engine answers.
 */
export function previewEmbedGpuStatement(choice: EmbedGpuChoice): EmbedGpuStatement {
  if (choice.gpuLayers <= 0) {
    return { backend: "cpu", gpuLayers: 0, source: choice.source };
  }
  return { backend: "unconfirmed", gpuLayers: null, source: choice.source };
}

export function applyEmbedGpuChoice(
  choice: EmbedGpuChoice,
  engine?: unknown,
  probeGpuType?: () => unknown,
): EmbedGpuStatement {
  const { statement } = confirmMetalEngagement({
    requestedGpuLayers: choice.gpuLayers,
    metalUsable: choice.metalUsable,
    source: choice.source,
    engine: typeof engine === "string" ? undefined : engine,
    probeGpuType,
  });
  stated = statement;
  return statement;
}

export function setEmbedGpuStatement(next: EmbedGpuStatement): void {
  stated = next;
}

export function getEmbedGpuStatement(detect: MetalDetectInput = {}): EmbedGpuStatement {
  if (stated) return stated;
  return previewEmbedGpuStatement(resolveEmbedGpuChoice(process.env, detect));
}

export function _resetEmbedGpuStatementForTests(): void {
  stated = null;
}

export function formatEmbedGpuLogLine(statement: EmbedGpuStatement): string {
  if (statement.fallback) {
    return `[embeddings] ${statement.fallback} (source=${statement.source})`;
  }
  if (statement.backend === "metal" && statement.gpuLayers != null) {
    return `[embeddings] embedding: GPU (Metal), ${statement.gpuLayers} layers (source=${statement.source})`;
  }
  if (statement.backend === "unconfirmed") {
    return `[embeddings] ${EMBED_GPU_UNCONFIRMED_MSG} (source=${statement.source})`;
  }
  if (statement.source === "env") {
    return `[embeddings] embedding: CPU, 0 layers (source=env)`;
  }
  return `[embeddings] embedding: CPU (no GPU backend detected)`;
}

/** Boot line before readback. Names the request; it does not claim a backend. */
export function formatEmbedGpuRequestLine(choice: EmbedGpuChoice): string {
  return (
    `[embeddings] embedding: GPU (Metal) requested, ${choice.gpuLayers} layers ` +
    `(source=${choice.source}) — confirming engagement`
  );
}

/**
 * Warning text `flair status` prints from HealthDetail. `null` when there is
 * nothing to warn about (Metal engaged, or a CPU request that was not an
 * offload). Unconfirmed text does not say the engine is on CPU.
 */
export function embedGpuStatusWarning(statement: EmbedGpuStatement): string | null {
  if (statement.backend === "metal") return null;
  if (statement.fallback) return statement.fallback;
  if (statement.backend === "unconfirmed") return EMBED_GPU_UNCONFIRMED_MSG;
  return null;
}

/** Attach the stated embedding field to a /Health or /HealthDetail body. */
export function withEmbedGpuHealth<T extends Record<string, unknown>>(
  body: T,
): T & { embedding: EmbedGpuStatement } {
  return { ...body, embedding: getEmbedGpuStatement() };
}

/**
 * Capture stdout/stderr (and console.*) for the duration of `fn`.
 * Native ggml writes that bypass Node's stream (fd 2 via libc) are not
 * guaranteed to appear here. Product engagement does not read this capture
 * (flair#2031); the ingest-throughput bench still greps its own logs.
 */
export async function captureIoDuring<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; log: string }> {
  const chunks: string[] = [];
  const tapChunk = (chunk: unknown): void => {
    if (typeof chunk === "string") chunks.push(chunk);
    else if (Buffer.isBuffer(chunk)) chunks.push(chunk.toString("utf8"));
    else chunks.push(String(chunk));
  };
  const wrapWrite = (orig: typeof process.stderr.write) =>
    function (this: NodeJS.WriteStream, chunk: unknown, encoding?: unknown, cb?: unknown) {
      tapChunk(chunk);
      return (orig as Function).call(this, chunk, encoding, cb);
    };
  const origErr = process.stderr.write;
  const origOut = process.stdout.write;
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const tapConsole =
    (orig: typeof console.log) =>
    (...args: unknown[]) => {
      chunks.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") + "\n");
      return orig.apply(console, args as []);
    };
  process.stderr.write = wrapWrite(origErr) as typeof process.stderr.write;
  process.stdout.write = wrapWrite(origOut) as typeof process.stdout.write;
  console.log = tapConsole(origLog);
  console.warn = tapConsole(origWarn);
  console.error = tapConsole(origError);
  try {
    const value = await fn();
    return { value, log: chunks.join("") };
  } finally {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
}
