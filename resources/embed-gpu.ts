/**
 * embed-gpu.ts — stated gpuLayers default for in-process embedding (flair#1437).
 *
 * Harper-free so the detect → derive → override → fail-loud decision is
 * unit-testable without a live engine. embeddings-boot.ts is the only
 * production caller that talks to HFE; Health/HealthDetail read the stated
 * snapshot.
 *
 * HFE's EngineOptions.gpuLayers is input-only — it cannot confirm Metal
 * engaged. The confirmation signal is the same ggml_metal_init +
 * compute-buffer pair the ingest-throughput bench already greps (#1597).
 * A first-class HFE readback is a follow-up, not this change.
 */
import { createRequire } from "node:module";

export const METAL_PREBUILT = "@node-llama-cpp/mac-arm64-metal";

/** Fail-loud sentence. Never report GPU while this is the live statement. */
export const EMBED_GPU_FALLBACK_MSG =
  "requested GPU offload; Metal did not engage; running CPU";

export type EmbedGpuBackend = "metal" | "cpu";
export type EmbedGpuSource = "detected" | "env" | "default";

export interface EmbedGpuStatement {
  backend: EmbedGpuBackend;
  gpuLayers: number;
  source: EmbedGpuSource;
  /** Present only when offload was requested but Metal did not engage. */
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

/** Prove GPU engagement from the engine / boot log. Requested ≠ used. */
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

/**
 * Fail-loud confirmation. Offload requested + Metal not usable, or offload
 * requested + usable but the ggml_metal_init / compute-buffer pair is
 * missing → CPU + fallback sentence. Never returns backend="metal" without
 * the log proof.
 */
export function confirmMetalEngagement(opts: {
  requestedGpuLayers: number;
  metalUsable: boolean;
  warmupLog: string;
  source: EmbedGpuSource;
}): { engaged: boolean; statement: EmbedGpuStatement } {
  const { requestedGpuLayers, metalUsable, warmupLog, source } = opts;
  if (requestedGpuLayers <= 0) {
    return { engaged: false, statement: { backend: "cpu", gpuLayers: 0, source } };
  }
  if (!metalUsable) {
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
  const readback = parseMetalEngaged(warmupLog);
  if (readback.engaged) {
    return {
      engaged: true,
      statement: { backend: "metal", gpuLayers: requestedGpuLayers, source },
    };
  }
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

/**
 * Pre-confirmation view of a choice. A Metal-derived 99 does not claim
 * `backend: "metal"` until confirmMetalEngagement sees the log markers.
 */
export function previewEmbedGpuStatement(choice: EmbedGpuChoice): EmbedGpuStatement {
  if (choice.gpuLayers <= 0) {
    return { backend: "cpu", gpuLayers: 0, source: choice.source };
  }
  if (!choice.metalUsable) {
    return {
      backend: "cpu",
      gpuLayers: 0,
      source: choice.source,
      fallback: EMBED_GPU_FALLBACK_MSG,
    };
  }
  return { backend: "cpu", gpuLayers: choice.gpuLayers, source: choice.source };
}

export function applyEmbedGpuChoice(
  choice: EmbedGpuChoice,
  warmupLog: string,
): EmbedGpuStatement {
  const { statement } = confirmMetalEngagement({
    requestedGpuLayers: choice.gpuLayers,
    metalUsable: choice.metalUsable,
    warmupLog,
    source: choice.source,
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
  if (statement.backend === "metal") {
    return `[embeddings] embedding: GPU (Metal), ${statement.gpuLayers} layers (source=${statement.source})`;
  }
  if (statement.gpuLayers > 0) {
    return (
      `[embeddings] embedding: GPU (Metal) requested, ${statement.gpuLayers} layers ` +
      `(source=${statement.source}) — confirming engagement`
    );
  }
  if (statement.source === "env") {
    return `[embeddings] embedding: CPU, 0 layers (source=env)`;
  }
  return `[embeddings] embedding: CPU (no GPU backend detected)`;
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
 * guaranteed to appear here — that is the HFE-readback follow-up. The
 * fail-loud path that does not need a log (offload requested + Metal not
 * usable) does not call this.
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
