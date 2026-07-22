/**
 * REM nightly runner — orchestrates the cycle.
 *
 * Per FLAIR-NIGHTLY-REM § 4, in order:
 *   1. Pre-flight: check pause sentinel / FLAIR_REM_PAUSE env. Exit clean if paused.
 *   2. Snapshot agent state (memory + soul) to ~/.flair/snapshots/<agent>/.
 *   3. Maintenance — delegate to /MemoryMaintenance (same code path `flair rem light` uses).
 *   4. Trust-tier filter on input memories — permanently deferred (see below).
 *   5. Distillation — call /ReflectMemories with execute:true, persist staged
 *      candidate ids to the audit row.
 *   6. Instance-wide dedup-cluster stat — call /MemoryDedupStats (flair-
 *      quality Slice 1c). NOT part of FLAIR-NIGHTLY-REM's original per-agent
 *      § 4 list — added because a near-duplicate cluster count is inherently
 *      instance-wide (dupes across agents matter), so it runs once per cycle
 *      after the per-agent passes above, rather than being scoped to
 *      opts.agentId like everything else in this file.
 *   7. Append a row to ~/.flair/logs/rem-nightly.jsonl.
 *
 * Status today:
 *   - Steps 1, 2 shipped in slice-1 PR-1 (#414).
 *   - Step 3 (maintenance) shipped in a prior slice-2 PR — fills
 *     `archived`/`expired` in the audit row.
 *   - Step 4: per specs/FLAIR-NIGHTLY-REM-SLICE-2-DISTILLATION.md § 3B,
 *     "Deferred from parent § 4 step 4" — trust tiers aren't derivable yet
 *     (that's the emergent-trust arc). The input filter stays as today (own
 *     agent, non-archived, non-permanent, scope window); the safety net for
 *     un-tiered input is structural — candidates are staged, never
 *     auto-promoted.
 *   - Step 5 (distillation) ships in this PR: calls `/ReflectMemories` with
 *     `execute: true` after maintenance succeeds. `dryRun` skips the call
 *     entirely (staging rows + spending model tokens are side effects).
 *   - Step 6 (dedup-cluster stat, flair-quality Slice 1c): calls
 *     `/MemoryDedupStats` after distillation. `dryRun` skips it (persisting
 *     the stat file is a side effect); failure (e.g. the caller isn't admin
 *     — the resource is admin-gated) is recorded in `errors` and does not
 *     fail the cycle. See resources/MemoryDedupStats.ts for the server-side
 *     computation and resources/dedup-cluster.ts for the stat's canonical
 *     storage location (NOT this log — see those files' module docs for why).
 *   - Step 7 shipped in slice-1 PR-1 (was step 6 before this PR).
 *
 * The audit row's `slice` field tells readers which steps populated which
 * counts: `slice: "1"` rows have `archived`/`expired` undefined; `slice:
 * "2-maintenance"` rows populate them but distillation didn't run this cycle
 * (dry-run skip); `slice: "2"` rows had distillation attempted — check
 * `candidates` for staged ids on success, `errors` for a `distillation:`
 * entry on failure (maintenance results still stand either way).
 *
 * Pure dependency injection so the runner is unit-testable without Harper.
 * The CLI wires the real `apiCall` + `pkgVersion`; tests pass stubs.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { createSnapshot } from "./snapshot.js";

export const REM_PAUSE_FLAG = resolve(homedir(), ".flair", "rem.paused");
export const REM_NIGHTLY_LOG = resolve(homedir(), ".flair", "logs", "rem-nightly.jsonl");

export type ApiCall = (method: string, path: string, body?: unknown) => Promise<any>;

export interface RunnerOpts {
  agentId: string;
  flairVersion: string;
  apiCall: ApiCall;
  /** Override snapshot root (testing). */
  snapshotRoot?: string;
  /** Override audit log path (testing). */
  logPath?: string;
  /** Override pause flag path (testing). */
  pauseFlagPath?: string;
  /** Override env-var check (testing). */
  envPaused?: boolean;
  /** When true, fetch and log but skip the snapshot write. */
  dryRun?: boolean;
  /** Override "now" (testing). */
  nowOverride?: Date;
}

export type RunnerStatus = "paused" | "completed" | "dry-run" | "failed";

/**
 * Audit-row `slice` field. Tracks which phase of FLAIR-NIGHTLY-REM
 * produced this row so log readers can distinguish snapshot-only cycles
 * from cycles with maintenance / distillation populated:
 *
 *   "1"             — snapshot + log only (slice-1, before #416)
 *   "2-maintenance" — snapshot + /MemoryMaintenance, distillation not
 *                     attempted this cycle (dry-run skip)
 *   "2"             — distillation attempted (success or failure — see
 *                     `candidates` / `errors`), per
 *                     specs/FLAIR-NIGHTLY-REM-SLICE-2-DISTILLATION.md § 3B
 */
export type RunnerSlice = "1" | "2-maintenance" | "2";

export interface RunnerLogRow {
  agentId: string;
  runAt: string;
  slice: RunnerSlice;
  status: RunnerStatus;
  dryRun?: boolean;
  snapshotPath?: string;
  memoryCount?: number;
  soulCount?: number;
  pendingCandidates?: number;
  durationMs: number;
  errors: string[];
  /** Slice-2 fields, written as empty placeholders so log readers don't break. */
  archived?: number;
  expired?: number;
  consolidated?: number;
  candidates?: string[];
  /**
   * flair-quality Slice 1c: instance-wide near-duplicate CLUSTER count,
   * populated when the POST /MemoryDedupStats step (below) succeeds this
   * cycle. Unlike every other field on this row, this is NOT scoped to
   * `agentId` — it's a whole-instance stat, mirrored here for audit-log
   * convenience. The CANONICAL copy `/HealthDetail` reads lives server-side
   * at REM_DEDUP_STATS_PATH (resources/dedup-cluster.ts), written directly
   * by the resource — see resources/MemoryDedupStats.ts's module doc for
   * why the runner's own log copy is NOT the source of truth (remote/
   * federated flairUrl deployments would leave HealthDetail with nothing to
   * read otherwise). Absent when dry-run skipped the step, the call failed
   * (see `errors`), or the response didn't carry the expected shape.
   */
  dedup?: {
    clusterCount: number;
    largestClusterSize: number;
    totalMemoriesInClusters: number;
    computedAt: string;
  };
}

export interface RunnerResult {
  status: RunnerStatus;
  logRow: RunnerLogRow;
  snapshotPath?: string;
}

function readPauseSentinel(path: string): boolean {
  try {
    const contents = readFileSync(path, "utf-8");
    // Existence alone is enough; the body is just a touch-timestamp.
    return contents.length >= 0;
  } catch {
    return false;
  }
}

function appendLogRow(logPath: string, row: RunnerLogRow): void {
  const dir = dirname(logPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(logPath, JSON.stringify(row) + "\n", { mode: 0o600 });
}

/**
 * Coerces a Harper REST list response into a flat array. The /Memory and
 * /Soul resources can return either an array directly or a paginated shape
 * `{ results: [], items: [] }` depending on path/options.
 */
function asArray(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.results)) return obj.results as any[];
    if (Array.isArray(obj.items)) return obj.items as any[];
  }
  return [];
}

/**
 * Best-effort extraction of a readable message out of a thrown API error.
 * `apiCall` implementations (see `api()` in src/cli.ts) throw
 * `Error(responseBodyText)` for non-2xx HTTP responses — /ReflectMemories's
 * 503 (no backend configured) and 502 (distillation_failed) bodies are JSON
 * `{ error: string, detail?: string }`. Unwraps that shape into a single
 * string so distinct failure modes read distinctly in the audit log instead
 * of as a raw JSON blob; falls back to the raw input for network errors or
 * any other shape.
 */
function describeApiError(err: unknown): string {
  const message = typeof err === "string" ? err : (err as any)?.message ?? String(err);
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
      return parsed.detail ? `${parsed.error}: ${parsed.detail}` : parsed.error;
    }
  } catch {
    // Not a JSON error body — network error, plain string, etc.
  }
  return message;
}

/**
 * Counts pending memory candidates for the agent.
 *
 * Falls back to a `search_by_conditions` POST that mirrors the pattern
 * `flair rem candidates` uses. Returns 0 on any error — the runner should
 * not fail the cycle just because the candidate count couldn't be sampled.
 */
async function fetchPendingCandidateCount(api: ApiCall, agentId: string): Promise<number> {
  try {
    const result = await api("POST", "/MemoryCandidate/search_by_conditions", {
      operator: "and",
      conditions: [
        { search_attribute: "agentId", search_type: "equals", search_value: agentId },
        { search_attribute: "status", search_type: "equals", search_value: "pending" },
      ],
      get_attributes: ["id"],
    });
    const rows = asArray(result);
    return rows.length;
  } catch {
    return 0;
  }
}

/**
 * Runs one nightly cycle for the given agent. See module header for steps.
 * Pure orchestration; all I/O goes through injected dependencies.
 */
export async function runNightlyCycle(opts: RunnerOpts): Promise<RunnerResult> {
  const startedAt = opts.nowOverride ?? new Date();
  const startedMs = startedAt.getTime();
  const logPath = opts.logPath ?? REM_NIGHTLY_LOG;
  const pauseFlagPath = opts.pauseFlagPath ?? REM_PAUSE_FLAG;
  const envPaused = opts.envPaused ?? process.env.FLAIR_REM_PAUSE === "1";

  const baseRow: Omit<RunnerLogRow, "status" | "durationMs"> = {
    agentId: opts.agentId,
    runAt: startedAt.toISOString(),
    slice: "1",
    errors: [],
  };

  // Step 1: pre-flight (pause)
  if (envPaused || (existsSync(pauseFlagPath) && readPauseSentinel(pauseFlagPath))) {
    const row: RunnerLogRow = {
      ...baseRow,
      status: "paused",
      durationMs: Date.now() - startedMs,
      errors: [],
    };
    appendLogRow(logPath, row);
    return { status: "paused", logRow: row };
  }

  const errors: string[] = [];

  // Step 2: snapshot
  let snapshotPath: string | undefined;
  let memoryCount = 0;
  let soulCount = 0;
  let pendingCandidates = 0;

  try {
    // Fetch agent data
    const memoriesRaw = await opts.apiCall("GET", `/Memory?agentId=${encodeURIComponent(opts.agentId)}`);
    const memories = asArray(memoriesRaw);
    memoryCount = memories.length;

    const soulRaw = await opts.apiCall("GET", `/Soul?agentId=${encodeURIComponent(opts.agentId)}`);
    const souls = asArray(soulRaw);
    soulCount = souls.length;
    // For the snapshot's soul.json: keep the full multi-row shape if there
    // are multiple souls (different keys), or unwrap a single-row response.
    const soulForSnapshot = souls.length === 1 ? souls[0] : souls.length > 1 ? souls : null;

    pendingCandidates = await fetchPendingCandidateCount(opts.apiCall, opts.agentId);

    if (!opts.dryRun) {
      const created = await createSnapshot({
        agentId: opts.agentId,
        flairVersion: opts.flairVersion,
        memories,
        soul: soulForSnapshot as Record<string, unknown> | null,
        pendingCandidateCount: pendingCandidates,
        rootOverride: opts.snapshotRoot,
        nowOverride: opts.nowOverride,
      });
      snapshotPath = created.path;
    }
  } catch (err: any) {
    errors.push(`snapshot: ${err?.message ?? String(err)}`);
    const row: RunnerLogRow = {
      ...baseRow,
      status: "failed",
      memoryCount,
      soulCount,
      pendingCandidates,
      durationMs: Date.now() - startedMs,
      errors,
    };
    appendLogRow(logPath, row);
    return { status: "failed", logRow: row };
  }

  // Step 3: maintenance — soft-delete expired + soft-archive stale.
  // Delegates to /MemoryMaintenance (same endpoint `flair rem light` uses).
  // In dry-run mode the snapshot wasn't written, but we still want to know
  // what maintenance WOULD do — POST with dryRun=true so the response counts
  // are accurate without mutating state.
  let archived = 0;
  let expired = 0;
  let sliceLabel: RunnerLogRow["slice"] = "2-maintenance";

  try {
    const maintRaw = await opts.apiCall("POST", "/MemoryMaintenance", {
      agentId: opts.agentId,
      dryRun: opts.dryRun ?? false,
    });
    if (maintRaw && typeof maintRaw === "object") {
      const obj = maintRaw as Record<string, unknown>;
      if (obj.error) {
        // /MemoryMaintenance returned { error: "..." } — treat as failure.
        throw new Error(String(obj.error));
      }
      expired = typeof obj.expired === "number" ? obj.expired : 0;
      archived = typeof obj.archived === "number" ? obj.archived : 0;
    }
  } catch (err: any) {
    errors.push(`maintenance: ${err?.message ?? String(err)}`);
    const row: RunnerLogRow = {
      ...baseRow,
      slice: sliceLabel,
      status: "failed",
      snapshotPath,
      memoryCount,
      soulCount,
      pendingCandidates,
      durationMs: Date.now() - startedMs,
      errors,
    };
    appendLogRow(logPath, row);
    return { status: "failed", logRow: row, snapshotPath };
  }

  // Step 5: distillation — call /ReflectMemories with execute:true, now that
  // maintenance has succeeded. Per spec § 3B, dryRun skips the call entirely:
  // staging MemoryCandidate rows and spending model tokens are side effects,
  // the same way dryRun skips the snapshot write.
  // When the call IS attempted (success or failure), the audit row's `slice`
  // flips to "2" — "2-maintenance" is reserved for the dry-run skip case.
  let candidates: string[] | undefined;

  if (!opts.dryRun) {
    sliceLabel = "2";
    try {
      const reflectRaw = await opts.apiCall("POST", "/ReflectMemories", {
        agentId: opts.agentId,
        execute: true,
      });
      const obj = (reflectRaw && typeof reflectRaw === "object") ? (reflectRaw as Record<string, unknown>) : {};
      if (obj.error) {
        // Defensive: a 200 response shouldn't carry { error }, since
        // MemoryReflect signals failure via HTTP status (503/502) — apiCall
        // implementations throw for those. Handled the same way regardless.
        errors.push(`distillation: ${describeApiError(obj.error)}`);
      } else {
        const staged = asArray(obj.candidates);
        candidates = staged
          .map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>).id : c))
          .filter((id): id is string => typeof id === "string");
      }
    } catch (err: any) {
      // Distillation failure is recorded, not fatal — maintenance already
      // succeeded and the cycle's guaranteed steps are done (spec § 3B item
      // 3). Zero partial candidates is guaranteed server-side (all-or-
      // nothing staging in /ReflectMemories).
      errors.push(`distillation: ${describeApiError(err?.message ?? err)}`);
    }
  }

  // Step 6 (flair-quality Slice 1c): instance-wide dedup-cluster stat.
  // Distinct from every step above — NOT scoped to opts.agentId. Runs ONCE
  // per cycle, after the per-agent passes (spec: "a new instance-wide step
  // in the REM nightly runner... runs once per cycle, after the per-agent
  // passes"). Skipped in dry-run for the same reason distillation is:
  // persisting the stat file is a side effect. Non-fatal on failure — e.g.
  // POST /MemoryDedupStats is admin-gated (resources/MemoryDedupStats.ts),
  // so a non-admin agent's nightly cycle records a `dedup:` error here and
  // otherwise completes normally; maintenance + distillation already stand.
  //
  // NOTE (flagged for review): if MULTIPLE agents on the same instance each
  // run their own nightly cycle, each cycle triggers this same instance-wide
  // sweep independently — the stat is recomputed N times a night rather than
  // once. No cross-process guard was added (kept the smallest surface); the
  // recomputation is idempotent (same inputs → same aggregate, just wasted
  // work), not incorrect.
  let dedup: RunnerLogRow["dedup"];

  if (!opts.dryRun) {
    try {
      const dedupRaw = await opts.apiCall("POST", "/MemoryDedupStats", {});
      const obj = (dedupRaw && typeof dedupRaw === "object") ? (dedupRaw as Record<string, unknown>) : {};
      if (obj.error) {
        errors.push(`dedup: ${describeApiError(obj.error)}`);
      } else if (
        typeof obj.clusterCount === "number" &&
        typeof obj.largestClusterSize === "number" &&
        typeof obj.totalMemoriesInClusters === "number" &&
        typeof obj.computedAt === "string"
      ) {
        dedup = {
          clusterCount: obj.clusterCount,
          largestClusterSize: obj.largestClusterSize,
          totalMemoriesInClusters: obj.totalMemoriesInClusters,
          computedAt: obj.computedAt,
        };
      } else {
        errors.push("dedup: unexpected /MemoryDedupStats response shape");
      }
    } catch (err: any) {
      errors.push(`dedup: ${describeApiError(err?.message ?? err)}`);
    }
  }

  // Step 7: log
  const row: RunnerLogRow = {
    ...baseRow,
    slice: sliceLabel,
    status: opts.dryRun ? "dry-run" : "completed",
    dryRun: opts.dryRun || undefined,
    snapshotPath,
    memoryCount,
    soulCount,
    pendingCandidates,
    archived,
    expired,
    candidates,
    dedup,
    durationMs: Date.now() - startedMs,
    errors,
    // `consolidated` remains undefined — this runner has no consolidation
    // step; it's reserved for a future slice that adds one.
  };
  appendLogRow(logPath, row);
  return { status: row.status, logRow: row, snapshotPath };
}
