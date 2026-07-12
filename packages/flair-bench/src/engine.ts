/**
 * engine.ts — node-llama-cpp integration: model loading, identity, and
 * corpus embedding.
 *
 * Uses node-llama-cpp DIRECTLY (the same engine dependency
 * harper-fabric-embeddings/HFE wraps for Harper) rather than going through
 * HFE — flair-bench has to run with no Flair/Harper installation at all, so
 * it can't depend on the Harper-only wrapper package. See prefixes.ts for
 * how the nomic search-prefix convention HFE applies is replicated here.
 */

import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { getLlama, GgufFileType, type Llama, type LlamaModel } from "node-llama-cpp";
import { CORPUS, QUERIES } from "./corpus-v2.js";
import { rankOf } from "./cosine.js";
import { applyDocumentPrefix, applyQueryPrefix, resolvePrefixConvention } from "./prefixes.js";
import { scoreRows, type ScoredRow } from "./scorer.js";
import type { BenchProgressEvent, CorpusInfo, ModelBenchResult, ModelIdentity } from "./types.js";

const DEFAULT_WARMUP_N = 8;
const MIN_TIMED_EMBEDS = 64;

let _llama: Llama | undefined;

/** Shared Llama instance for the whole batch run — one backend/GPU detection, reused across every model load. */
export async function getSharedLlama(): Promise<Llama> {
  if (_llama) return _llama;
  _llama = await getLlama();
  return _llama;
}

export function corpusInfo(): CorpusInfo {
  return { version: "v2", records: CORPUS.length, queries: QUERIES.length };
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Total parameter count, approximated by summing every tensor's element
 * count from the GGUF's own tensor index — the same method llama.cpp's CLI
 * uses to report "params" in its load banner. Embedding-architecture GGUFs
 * (BERT-family, unlike LLaMA-family) don't reliably carry a
 * `general.parameter_count` metadata field, so this is computed rather than
 * read.
 */
function approxParamCount(model: LlamaModel): number {
  const tensors = model.fileInfo.tensorInfo ?? [];
  let total = 0n;
  for (const t of tensors) {
    let elements = 1n;
    for (const d of t.dimensions) {
      elements *= typeof d === "bigint" ? d : BigInt(d);
    }
    total += elements;
  }
  return Number(total);
}

/** "MOSTLY_Q4_K_M" -> "Q4_K_M"; falls back to parsing the filename if GGUF metadata carries no file_type. */
function resolveQuant(model: LlamaModel, fileName: string): { quant: string; quantSource: "gguf-metadata" | "filename-fallback" } {
  const fileType = model.fileInfo.metadata?.general?.file_type;
  if (fileType !== undefined) {
    const name = GgufFileType[fileType];
    if (name) return { quant: name.replace(/^MOSTLY_/, "").replace(/^ALL_/, ""), quantSource: "gguf-metadata" };
  }
  const match = fileName.match(/\.((?:Q|IQ)[0-9][A-Z0-9_]*|F16|F32|BF16)\.gguf$/i);
  return { quant: match ? match[1]!.toUpperCase() : "unknown", quantSource: "filename-fallback" };
}

export async function computeModelIdentity(model: LlamaModel, filePath: string): Promise<ModelIdentity> {
  const fileName = basename(filePath);
  const sizeBytes = statSync(filePath).size;
  const sha256 = await sha256File(filePath);
  const { quant, quantSource } = resolveQuant(model, fileName);
  const dims = model.fileInsights.embeddingVectorSize ?? 0;
  const paramsApprox = approxParamCount(model);
  const bpw = paramsApprox > 0 ? (sizeBytes * 8) / paramsApprox : 0;
  return { fileName, sha256, sizeBytes, quant, quantSource, dims, paramsApprox, bpw };
}

interface EmbedPhaseResult {
  documentVectors: number[][];
  queryVectors: number[][];
  msPerEmbedSerialWarm: number;
}

/**
 * Embeds every CORPUS record (as "document") and every QUERIES entry (as
 * "query") serially, applying the resolved prefix convention. The first
 * `warmupN` embeds (drawn from CORPUS) run untimed before the stopwatch
 * starts, so first-call allocation/JIT overhead doesn't skew the reported
 * ms/embed — the timed set is CORPUS.length + QUERIES.length - warmupN,
 * comfortably >= 64 for corpus-v2 (251 + 126 - 8 = 369).
 */
async function embedCorpus(
  model: LlamaModel,
  fileName: string,
  warmupN: number,
  sample: () => void,
  onProgress?: (e: BenchProgressEvent) => void,
): Promise<EmbedPhaseResult> {
  const convention = resolvePrefixConvention(fileName);
  const embeddingContext = await model.createEmbeddingContext();
  sample();
  try {
    const documentTexts = CORPUS.map((r) => applyDocumentPrefix(r.text, convention));
    const queryTexts = QUERIES.map((q) => applyQueryPrefix(q.q, convention));

    const warm = Math.min(Math.max(0, warmupN), documentTexts.length);
    for (let i = 0; i < warm; i++) {
      await embeddingContext.getEmbeddingFor(documentTexts[i]!);
      sample();
    }

    const documentVectors: number[][] = new Array(documentTexts.length);
    const queryVectors: number[][] = new Array(queryTexts.length);
    const totalToEmbed = documentTexts.length + queryTexts.length;
    let done = 0;
    let timedCount = 0;
    let timedMs = 0;

    for (let i = 0; i < documentTexts.length; i++) {
      const timed = i >= warm;
      const t0 = timed ? performance.now() : 0;
      const emb = await embeddingContext.getEmbeddingFor(documentTexts[i]!);
      if (timed) {
        timedMs += performance.now() - t0;
        timedCount++;
      }
      documentVectors[i] = emb.vector as number[];
      sample();
      done++;
      onProgress?.({ type: "model-embedding", fileName, done, total: totalToEmbed });
    }
    for (let i = 0; i < queryTexts.length; i++) {
      const t0 = performance.now();
      const emb = await embeddingContext.getEmbeddingFor(queryTexts[i]!);
      timedMs += performance.now() - t0;
      timedCount++;
      queryVectors[i] = emb.vector as number[];
      sample();
      done++;
      onProgress?.({ type: "model-embedding", fileName, done, total: totalToEmbed });
    }

    const msPerEmbedSerialWarm = timedCount > 0 ? timedMs / timedCount : 0;
    if (timedCount < MIN_TIMED_EMBEDS) {
      // Should be unreachable with corpus-v2's fixed size, but fail loudly
      // rather than silently report a latency figure the spec's own N>=64
      // floor wasn't met by.
      throw new Error(`embedCorpus: only ${timedCount} timed embeds (need >= ${MIN_TIMED_EMBEDS}) — corpus-v2 too small or warmupN too large`);
    }

    return { documentVectors, queryVectors, msPerEmbedSerialWarm };
  } finally {
    await embeddingContext.dispose();
  }
}

/**
 * Full single-model benchmark: load, embed the corpus, exact-cosine rank
 * every query, score p@3/MRR overall and per-kind. Disposes the model
 * before returning so a batch run's next model starts from a clean slate.
 *
 * Peak-RSS baseline is captured BEFORE `llama.loadModel()` runs — sampling
 * only from inside the embedding phase (an earlier version of this
 * function did that) would already have the model's own weights resident
 * in the baseline, silently undercounting the number the spec actually
 * wants ("how much memory does loading+using this model cost"). Verified
 * against the Q4 baseline: an 80 MiB GGUF was reporting a ~24 MiB delta
 * before this fix, because mmap'd model weight pages had already been
 * counted into the baseline by the time sampling started.
 */
export async function benchModel(
  llama: Llama,
  filePath: string,
  options: { warmupN?: number; onProgress?: (e: BenchProgressEvent) => void; index?: number; total?: number } = {},
): Promise<ModelBenchResult> {
  const fileName = basename(filePath);
  const { warmupN = DEFAULT_WARMUP_N, onProgress, index = 0, total = 1 } = options;

  onProgress?.({ type: "model-start", fileName, index, total });

  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  const sample = () => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  };

  const loadStart = performance.now();
  const model = await llama.loadModel({ modelPath: filePath });
  const loadTimeMs = performance.now() - loadStart;
  sample();
  onProgress?.({ type: "model-loaded", fileName, loadTimeMs });

  try {
    const modelIdentity = await computeModelIdentity(model, filePath);
    sample();
    const { documentVectors, queryVectors, msPerEmbedSerialWarm } = await embedCorpus(model, fileName, warmupN, sample, onProgress);
    const peakRssDeltaMiB = Math.max(0, (peakRss - baselineRss) / (1024 * 1024));

    const markerToIndex = new Map(CORPUS.map((r, i) => [r.marker, i] as const));
    const rows: ScoredRow[] = QUERIES.map((q, qi) => {
      const targetIndex = markerToIndex.get(q.expectMarker);
      if (targetIndex === undefined) {
        throw new Error(`benchModel: QUERIES[${qi}].expectMarker "${q.expectMarker}" has no matching CORPUS record`);
      }
      const rank = rankOf(queryVectors[qi]!, documentVectors, targetIndex);
      return { rank, kind: q.kind };
    });
    const { aggregate, perKind } = scoreRows(rows);

    const result: ModelBenchResult = {
      model: modelIdentity,
      loadTimeMs,
      msPerEmbedSerialWarm,
      peakRssDeltaMiB,
      aggregate,
      perKind,
    };
    onProgress?.({ type: "model-done", fileName, result });
    return result;
  } finally {
    await model.dispose();
  }
}
