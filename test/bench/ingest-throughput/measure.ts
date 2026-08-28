/**
 * measure.ts — the ingest-only throughput measurement itself.
 *
 * For one thread setting: spawn a fresh ephemeral Harper with
 * FLAIR_EMBED_THREADS set in the parent env (resolved at module-load by
 * `resolveEmbedThreads()` in resources/embeddings-boot.ts), warm up the
 * embedder (loads the model + creates the llama.cpp worker threads), observe
 * the ACTUAL thread count from /proc/<pid>/status (not just the requested
 * env-var value), ingest the slice, and count tokens from the embedder's own
 * analytics table (`hdb_model_calls.embedding_tokens`).
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { availableParallelism, cpus } from "node:os";
import { startHarper, stopHarper, type HarperInstance } from "../../helpers/harper-lifecycle";
import {
  mkAgent, registerAgent, ingestSessionHistory, adminOp,
  type SessionHistory,
} from "../../../packages/flair-bench/lib/index";
import { entryToSessions, toSessionHistories, type LmeEntry } from "../longmemeval/dataset";
import { FLUSH_WAIT_MS } from "./config";

export interface SettingMetrics {
  /** The env-var value requested ("default" = unset). */
  requestedThreads: number | "default";
  /** Threads actually created by the embedder, observed as the /proc Threads:
   *  delta before/after warmup. This is the number the sweep is really about. */
  observedThreads: number;
  /** os.availableParallelism() in the bench process (cgroup-aware). */
  availableParallelism: number;
  /** os.cpus().length (physical/hyperthread count). */
  hostCores: number;
  /** Wall-clock for the full ingest pass (ms), model already warm. */
  wallClockMs: number;
  /** Model-load + warmup wall-clock (ms) — reported separately, not in tok/s. */
  modelLoadMs: number;
  /** Memory records written (one per event). */
  documents: number;
  /** Tokens ingested, from the embedder's own count (hdb_model_calls). */
  tokensIngested: number;
  /** Cross-check: chars/4 estimate (reader-free, deterministic). */
  estimateTokens: number;
  /** tokensIngested / (wallClockMs/1000). */
  tokPerSec: number;
  /** tokPerSec / observedThreads. */
  tokPerSecPerCore: number;
  /** Peak RSS (VmHWM) of the Harper process, bytes. */
  peakRssBytes: number;
}

interface ProcStatus {
  threads: number;
  vmHWM: number; // bytes
}

function readProcStatus(pid: number): ProcStatus {
  const raw = readFileSync(`/proc/${pid}/status`, "utf8");
  const threads = Number(/^Threads:\s+(\d+)/m.exec(raw)?.[1] ?? 0);
  const vmHWMkB = Number(/^VmHWM:\s+(\d+)/m.exec(raw)?.[1] ?? 0);
  return { threads, vmHWM: vmHWMkB * 1024 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Sum the embedder's reported token count from `system.hdb_model_calls`.
 *  The table is written via primaryStore.put (bypasses indices) and buffered
 *  (10s flush), so callers must wait FLUSH_WAIT_MS after ingest before
 *  querying. Returns 0 if the table is empty (e.g. no embeds yet). */
async function queryEmbeddingTokens(harper: HarperInstance): Promise<number> {
  const res = await adminOp(harper, {
    operation: "sql",
    sql: "SELECT SUM(embedding_tokens) AS total FROM system.hdb_model_calls",
  });
  if (!res.ok) {
    throw new Error(`queryEmbeddingTokens: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const body: any = await res.json();
  // evaluateSQL returns an array of rows; SUM(...) AS total lands in row[0].total.
  const total = Array.isArray(body) && body.length > 0 ? Number(body[0]?.total ?? 0) : 0;
  return Number.isFinite(total) ? total : 0;
}

/** Deterministic chars/4 token estimate over every event in the slice. */
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

export async function measureSetting(
  entries: LmeEntry[],
  threads: number | "default",
  opts: MeasureOptions,
): Promise<SettingMetrics> {
  const { repoRoot, concurrency, log } = opts;

  // Set the env var in the PARENT before startHarper(); startHarper spreads
  // parentEnv (a copy of process.env) into the child's baseEnv, and
  // resolveEmbedThreads() reads it at module-load inside the Harper process.
  if (threads === "default") delete process.env.FLAIR_EMBED_THREADS;
  else process.env.FLAIR_EMBED_THREADS = String(threads);

  const harper = await startHarper({ cwd: repoRoot, harperBinDir: repoRoot });
  const pid = harper.process?.pid;

  try {
    const baseline = pid ? readProcStatus(pid) : null;

    // Warmup: ingest a single synthetic event under a throwaway agent to load
    // the model and create the llama.cpp worker threads. Its tokens are
    // subtracted below, so it never pollutes the measured count.
    const warmupAgent = mkAgent("ingest-warmup");
    await registerAgent(harper, warmupAgent);
    const warmupSessions: SessionHistory[] = [{
      sessionId: "ingest-warmup",
      events: [{ id: "ingest-warmup-1", content: "warmup", createdAt: new Date().toISOString() }],
    }];
    const t0 = performance.now();
    await ingestSessionHistory({ harper, agent: warmupAgent }, warmupSessions, { concurrency });
    const modelLoadMs = performance.now() - t0;

    const postWarmup = pid ? readProcStatus(pid) : null;
    const observedThreads = baseline && postWarmup ? postWarmup.threads - baseline.threads : 0;
    log(`    observed threads: ${observedThreads} (baseline ${baseline?.threads ?? "?"} -> ${postWarmup?.threads ?? "?"})`);

    // Flush warmup tokens, then read the baseline count to subtract.
    await sleep(FLUSH_WAIT_MS);
    const baselineTokens = await queryEmbeddingTokens(harper);

    // Ingest the full slice under the main agent.
    const mainAgent = mkAgent("ingest-main");
    await registerAgent(harper, mainAgent);
    const sessions = entries.flatMap((e) => toSessionHistories(entryToSessions(e)));
    const t1 = performance.now();
    const ingest = await ingestSessionHistory({ harper, agent: mainAgent }, sessions, { concurrency });
    const wallClockMs = performance.now() - t1;

    // Flush ingest tokens, then read the total and subtract the warmup.
    await sleep(FLUSH_WAIT_MS);
    const totalTokens = await queryEmbeddingTokens(harper);
    const tokensIngested = totalTokens - baselineTokens;

    const final = pid ? readProcStatus(pid) : null;
    const peakRssBytes = final?.vmHWM ?? 0;

    const tokPerSec = tokensIngested / (wallClockMs / 1000);
    const tokPerSecPerCore = observedThreads > 0 ? tokPerSec / observedThreads : 0;

    return {
      requestedThreads: threads,
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
      peakRssBytes,
    };
  } finally {
    await stopHarper(harper, { keepInstallDir: false });
    delete process.env.FLAIR_EMBED_THREADS;
  }
}
