/**
 * status.ts — composes the in-process progress store (progress.ts) with the
 * on-disk state file (state.ts) into the single snapshot resources/health.ts
 * and `flair doctor` (via /HealthDetail) surface.
 *
 * Falls back to the on-disk state when the in-process progress map is empty
 * — a process can be asked for /HealthDetail before its boot's `setImmediate`
 * callback has fired at all (a very early poll), or after a restart where
 * this run's cycle hasn't started yet; the on-disk record of the LAST
 * completed/halted outcome is still genuinely useful in that window instead
 * of reporting nothing.
 */
import { listMigrationProgress, getCycleStatus, getStateFileStatus, type StateFileStatus } from "./progress.js";
import { readMigrationState, defaultStatePath } from "./state.js";
import type { MigrationProgress, MigrationState } from "./types.js";

export interface MigrationStatusSnapshot {
  cyclePhase: string;
  lastCycleError?: string;
  lastCycleAt?: string;
  migrations: MigrationProgress[];
  /**
   * flair#1800: the durable-record write status — the resolved state path and
   * the last write failure (null once a write succeeds). Surfaced so
   * `/HealthDetail` can distinguish "completed and recorded" from "completed,
   * record failed" (the in-memory outcome does not prove the durable one).
   */
  stateFile: StateFileStatus;
}

export function getMigrationStatusSnapshot(dataDir: string): MigrationStatusSnapshot {
  const cycle = getCycleStatus();
  let migrations = listMigrationProgress();

  if (migrations.length === 0) {
    const state = readMigrationState(defaultStatePath(dataDir));
    migrations = Object.entries(state).map(([id, entry]) => {
      const derivedState: MigrationState =
        entry.lastOutcome === "success" ? "completed" : entry.lastOutcome === "halted" ? "halted" : "failed";
      const row: MigrationProgress = {
        id,
        rowsDone: entry.rowsProcessed ?? 0,
        rowsRemaining: entry.rowsRemaining ?? 0,
        state: derivedState,
      };
      if (entry.reason) row.reason = entry.reason;
      return row;
    });
  }

  return {
    cyclePhase: cycle.phase,
    lastCycleError: cycle.lastCycleError,
    lastCycleAt: cycle.lastCycleAt,
    migrations,
    stateFile: getStateFileStatus(),
  };
}
