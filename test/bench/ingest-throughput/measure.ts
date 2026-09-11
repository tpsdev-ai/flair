/**
 * measure.ts — one (threads × gpuLayers) cell of the ingest-only throughput
 * bench (flair#1436). Fresh Harper per cell — do not pipeline the lifecycle
 * across settings (threads and gpuLayers are resolved at module-load).
 */
import { performance } from "node:perf_hooks";
import { availableParallelism, cpus } from "node:os";
import { startHarper, stopHarper, type HarperInstance } from "../../helpers/harper-lifecycle";
import {
  mkAgent, registerAgent, ingestSessionHistory, adminOp,
  type SessionHistory,
} from "../../../packages/flair-bench/lib/index";
import { entryToSessions, toSessionHistories, type LmeEntry } from "../longmemeval/dataset";
import { FLUSH_WAIT_MS } from "./config";
import { observedThreadDelta, readProcessStatus } from "./observe";
import { decideMetalGate, decideObservedThreads, parseMetalEngaged } from "../../unit/ingest-throughput-control";

export interface SettingMetrics {
  requestedThreads: number | "default";
  requestedGpuLayers: number;
  /** Embedder threads actually created (warmup delta). Refuse if unreadable. */
  observedThreads: number;
  availableParallelism: number;
  hostCores: number;
  wallClockMs: number;
  modelLoadMs: number;
  documents: number;
  tokensIngested: number;
  estimateTokens: number;
  tokPerSec: number;
  tokPerSecPerCore: number;
  docsPerSec: number;
  peakRssBytes: number;
  metalEngaged: boolean;
  metalEvidence: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function queryEmbeddingTokens(harper: HarperInstance): Promise<number> {
  const res = await adminOp(harper, {
    operation: "sql",
    sql: "SELECT SUM(embedding_tokens) AS total FROM system.hdb_model_calls",
  });
  if (!res.ok) {
    throw new Error(`queryEmbeddingTokens: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const body: any = await res.json();
  const total = Array.isArray(body) && body.length > 0 ? Number(body[0]?.total ?? 0) : 0;
  return Number.isFinite(total) ? total : 0;
}

function estimateTokens(entries: LmeEntry[]): number {
  let sum = 0;
  for (const entry of entries) {
    for (const session of entryToSessions(entry)) {
      for (const ev of session.events) {
        sum += Math.ceil((ev.content ?? "").length / 4);
      }
    }
  }
  return sum;
}

export interface MeasureOptions {
  repoRoot: string;
  concurrency: number;
  log: (msg: string) => void;
}

export interface CellSpec {
  threads: number | "default";
  gpuLayers: number;
}

function applyCellEnv(cell: CellSpec): () => void {
  const savedThreads = process.env.FLAIR_EMBED_THREADS;
  const savedGpu = process.env.FLAIR_EMBED_GPU_LAYERS;
  if (cell.threads === "default") delete process.env.FLAIR_EMBED_THREADS;
  else process.env.FLAIR_EMBED_THREADS = String(cell.threads);
  if (cell.gpuLayers === 0) {
    // Unset = HFE default 0. The sweep's cpu cell measures the real default path.
    delete process.env.FLAIR_EMBED_GPU_LAYERS;
  } else {
    process.env.FLAIR_EMBED_GPU_LAYERS = String(cell.gpuLayers);
  }
  return () => {
    if (savedThreads === undefined) delete process.env.FLAIR_EMBED_THREADS;
    else process.env.FLAIR_EMBED_THREADS = savedThreads;
    if (savedGpu === undefined) delete process.env.FLAIR_EMBED_GPU_LAYERS;
    else process.env.FLAIR_EMBED_GPU_LAYERS = savedGpu;
  };
}

export async function measureSetting(
  entries: LmeEntry[],
  cell: CellSpec,
  opts: MeasureOptions,
): Promise<SettingMetrics> {
  const { repoRoot, concurrency, log } = opts;
  const restoreEnv = applyCellEnv(cell);

  const harper = await startHarper({ cwd: repoRoot, harperBinDir: repoRoot });
  const pid = harper.process?.pid;
  const extraLog: string[] = [];
  const onChunk = (d: Buffer) => { extraLog.push(d.toString()); };
  harper.process?.stdout?.on("data", onChunk);
  harper.process?.stderr?.on("data", onChunk);

  try {
    if (!pid) {
      throw new Error(
        "observe: Harper pid is missing (external mode?) — cannot read observed threads, refusing",
      );
    }
    const baseline = readProcessStatus(pid);

    const warmupAgent = mkAgent("ingest-warmup");
    await registerAgent(harper, warmupAgent);
    const warmupSessions: SessionHistory[] = [{
      sessionId: "ingest-warmup",
      events: [{ id: "ingest-warmup-1", content: "warmup", createdAt: new Date().toISOString() }],
    }];
    const t0 = performance.now();
    await ingestSessionHistory({ harper, agent: warmupAgent }, warmupSessions, { concurrency });
    const modelLoadMs = performance.now() - t0;

    const postWarmup = readProcessStatus(pid);
    const observedThreads = observedThreadDelta(baseline.threads, postWarmup.threads);
    const observedGate = decideObservedThreads(observedThreads);
    if (observedGate.blocked) throw new Error(observedGate.reason);
    log(
      `    observed threads: ${observedThreads} ` +
      `(baseline ${baseline.threads} → ${postWarmup.threads}, via ${postWarmup.source})`,
    );

    const capturedLog = `${harper.getLog?.() ?? ""}\n${extraLog.join("")}`;
    const metalGate = decideMetalGate(cell.gpuLayers, capturedLog);
    if (metalGate.blocked) {
      throw new Error(metalGate.reason);
    }
    const metal = parseMetalEngaged(capturedLog);
    if (cell.gpuLayers > 0) {
      log(`    Metal engaged: ${metal.engaged} (init=${metal.hasInit} buffer=${metal.hasComputeBuffer})`);
    }

    await sleep(FLUSH_WAIT_MS);
    const baselineTokens = await queryEmbeddingTokens(harper);

    const mainAgent = mkAgent("ingest-main");
    await registerAgent(harper, mainAgent);
    const sessions = entries.flatMap((e) => toSessionHistories(entryToSessions(e)));
    const t1 = performance.now();
    const ingest = await ingestSessionHistory({ harper, agent: mainAgent }, sessions, { concurrency });
    const wallClockMs = performance.now() - t1;

    await sleep(FLUSH_WAIT_MS);
    const totalTokens = await queryEmbeddingTokens(harper);
    const tokensIngested = totalTokens - baselineTokens;

    const final = readProcessStatus(pid);
    const peakRssBytes = Number.isFinite(final.rssBytes) ? final.rssBytes : 0;

    const tokPerSec = tokensIngested / (wallClockMs / 1000);
    const tokPerSecPerCore = observedThreads > 0 ? tokPerSec / observedThreads : 0;
    const docsPerSec = ingest.written / (wallClockMs / 1000);

    return {
      requestedThreads: cell.threads,
      requestedGpuLayers: cell.gpuLayers,
      observedThreads,
      availableParallelism: availableParallelism(),
      hostCores: cpus().length,
      wallClockMs,
      modelLoadMs,
      documents: ingest.written,
      tokensIngested,
      estimateTokens: estimateTokens(entries),
      tokPerSec,
      tokPerSecPerCore,
      docsPerSec,
      peakRssBytes,
      metalEngaged: metal.engaged,
      metalEvidence: metal.evidence,
    };
  } finally {
    harper.process?.stdout?.off("data", onChunk);
    harper.process?.stderr?.off("data", onChunk);
    await stopHarper(harper, { keepInstallDir: false });
    restoreEnv();
  }
}
