/**
 * Operator text for the persistent BM25 index (flair#2032).
 *
 * Harper-free so `flair status` and the search-readiness decision can share
 * one wording. The index itself is per Harper worker; when THREADS_COUNT is
 * greater than 1 the line names the worker it describes instead of implying
 * a cluster-wide aggregate.
 */

export type Bm25IndexState = "empty" | "building" | "ready" | "disabled" | "failed";

export type Bm25StatusFields = {
  state: Bm25IndexState | string;
  reason?: string;
  size: number;
  built: number;
  total: number;
  startedAt: number | null;
  finishedAt: number | null;
  buildDurationMs: number | null;
  workerThreadId: number;
  threadsCount: number | null;
};

/** Positive integer THREADS_COUNT, or null when unset or not a count. */
export function readThreadsCount(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.THREADS_COUNT;
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

function formatAgo(ms: number): string {
  const elapsed = Math.max(0, ms);
  if (elapsed < 1000) return "just now";
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(elapsed / 86_400_000);
  return `${days}d ago`;
}

function formatDuration(ms: number): string {
  const n = Math.max(0, ms);
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 10_000) {
    const tenths = Math.round(n / 100) / 10;
    return `${tenths.toFixed(1)}s`;
  }
  return `${Math.round(n / 1000)}s`;
}

function percent(built: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((built * 100) / total);
}

function workerSuffix(threadsCount: number | null, workerThreadId: number): string {
  if (threadsCount != null && threadsCount > 1) {
    return ` · worker ${workerThreadId} of ${threadsCount}`;
  }
  return "";
}

/**
 * One line for HealthDetail and `flair status`.
 *
 *   building 312/817 docs (38%) · started 4s ago
 *   ready · 817 docs · built in 1.2s · 3m ago
 *   disabled — <reason>
 */
export function formatBm25IndexSummary(input: Bm25StatusFields, now = Date.now()): string {
  const suffix = workerSuffix(input.threadsCount, input.workerThreadId);
  const reason = (input.reason ?? "").trim();

  if (input.state === "building") {
    const head = input.total > 0
      ? `building ${input.built}/${input.total} docs (${percent(input.built, input.total)}%)`
      : `building ${input.built} docs`;
    const started = input.startedAt == null ? "" : ` · started ${formatAgo(now - input.startedAt)}`;
    return `${head}${started}${suffix}`;
  }

  if (input.state === "ready") {
    const dur = input.buildDurationMs == null ? "" : ` · built in ${formatDuration(input.buildDurationMs)}`;
    const ago = input.finishedAt == null ? "" : ` · ${formatAgo(now - input.finishedAt)}`;
    return `ready · ${input.size} docs${dur}${ago}${suffix}`;
  }

  if (input.state === "disabled" || input.state === "failed") {
    const why = reason.length > 0 ? reason : "no reason recorded";
    const label = input.state === "failed" ? "failed" : "disabled";
    return `${label} — ${why}${suffix}`;
  }

  // `empty`: the warm has not started (or a stale marker cleared a ready
  // index). Say what clears it. A stale reason, when one was recorded, is
  // part of that sentence.
  if (reason.length > 0) {
    return `not built yet — ${reason}; a text search rebuilds it${suffix}`;
  }
  return `not built yet — builds in the background after startup, or on the first text search${suffix}`;
}

/**
 * HealthDetail warning for an index that is `disabled` while search still
 * answers. Only a failure (feed error, failed build, failed rank) warns.
 * `FLAIR_BM25_INDEX=false` and vector-only retrieval are operator settings:
 * the status line states them, and they are not a standing warning.
 */
export function bm25DisabledWarning(
  bm25: { state?: string; summary?: string } | null | undefined,
  opts: { indexEnabled: boolean; inRetrievalPath: boolean },
): string | null {
  if (!opts.indexEnabled || !opts.inRetrievalPath) return null;
  if (bm25?.state !== "disabled") return null;
  const summary = bm25.summary?.trim() ?? "";
  if (summary.length === 0) return null;
  return `bm25 index: ${summary}`;
}

/**
 * Lag text for searchReady. A caller that already has a summary (HealthDetail)
 * passes it through; a caller with only a state (public /Health) gets the
 * same facts without doc counts.
 */
export function bm25SearchLagReason(bm25: { state?: string; summary?: string } | null | undefined): string {
  const summary = bm25?.summary?.trim() ?? "";
  if (summary.length > 0) {
    return summary.startsWith("bm25 index:") ? summary : `bm25 index: ${summary}`;
  }
  if (bm25?.state === "building") {
    return "bm25 index: building — a text search waits for this build";
  }
  return "bm25 index not built yet — builds in the background after startup, or on the first text search";
}
