/**
 * REM nightly runner — orchestrates the cycle.
 *
 * Per FLAIR-NIGHTLY-REM § 4, in order:
 *   1. Pre-flight: check pause sentinel / FLAIR_REM_PAUSE env. Exit clean if paused.
 *   2. Snapshot agent state (memory + soul) to ~/.flair/snapshots/<agent>/.
 *   3. Maintenance — delegate to /MemoryMaintenance (same code path `flair rem light` uses).
 *   4. (slice-2 next) trust-tier filter on input memories.
 *   5. (slice-2 next) distillation — call /ReflectMemories, persist candidates.
 *   6. Append a row to ~/.flair/logs/rem-nightly.jsonl.
 *
 * Status today:
 *   - Steps 1, 2, 6 shipped in slice-1 PR-1 (#414).
 *   - Step 3 (maintenance) ships in this PR — fills `archived`/`expired` in
 *     the audit row.
 *   - Steps 4, 5 are slice-2 follow-ups; require an in-process distillation
 *     LLM path (today `/ReflectMemories` returns a prompt for human/agent
 *     consumption, not server-side candidate generation).
 *
 * The audit row's `slice` field tells readers which steps populated which
 * counts: `slice: "1"` rows have `archived`/`expired` undefined; `slice:
 * "2-maintenance"` rows populate them; future slice-2 rows will populate
 * `consolidated` and `candidates`.
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
 *   "2-maintenance" — snapshot + /MemoryMaintenance (this PR, slice-2 PR-3)
 *   "2"             — full slice-2 (adds /ReflectMemories distillation + replay)
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

  // Step 6: log
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
    durationMs: Date.now() - startedMs,
    errors,
    // `consolidated` and `candidates` populate when slice-2 PR-4 (distillation)
    // lands; today they remain undefined so the row is honest about what ran.
  };
  appendLogRow(logPath, row);
  return { status: row.status, logRow: row, snapshotPath };
}
