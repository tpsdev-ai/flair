/**
 * progress.ts — in-process, module-scope migration status. The runner
 * writes here as it works; resources/health.ts and resources/MigrationBoot.ts
 * read from here — both live in the SAME Node process, so a plain module-
 * scope store (same idiom as resources/instance-identity.ts's cache) is
 * sufficient; no cross-process synchronization is needed for what `health`
 * reports about THIS process's own run.
 *
 * Reset to empty on every process restart by construction (module state) —
 * that's correct: after a restart, the durable source of truth for "did a
 * migration already complete" is the on-disk state file (state.ts), which
 * the runner re-derives progress from before its next cycle either way.
 */
import type { MigrationProgress, MigrationState } from "./types.js";
import { readMigrationState, type MigrationStateEntry } from "./state.js";

/**
 * `scheduled` (flair#812) is set SYNCHRONOUSLY by
 * `resources/migration-boot.ts`'s module-level `scheduleMigrationBoot()`,
 * before the deferred cycle runs. It exists so that `idle` carries real
 * information: after this change, an instance still reporting `idle` is one
 * where migration-boot.js never loaded at all. Without it, "the trigger
 * never fired" and "the trigger fired and the cycle hasn't reached a phase
 * transition yet" were the same observation — which is why flair#812 could
 * not be diagnosed from `/HealthDetail`.
 */
export type CyclePhase = "idle" | "scheduled" | "pre-hash" | "running" | "done";

export interface CycleStatus {
  phase: CyclePhase;
  lastCycleError?: string;
  lastCycleAt?: string;
}

let cycleStatus: CycleStatus = { phase: "idle" };
const progressById = new Map<string, MigrationProgress>();
/** Ids whose entry `seedProgressFromState` built from the state file and
 *  `setMigrationProgress` has not written since (flair#2840). */
const seededFromState = new Set<string>();

/**
 * flair#1800 — the last state-file WRITE outcome, for `/HealthDetail`.
 *
 * `state.json` is the only DURABLE record that a migration ran;
 * `/HealthDetail` is in-memory and resets on restart. So when a write fails and
 * is swallowed, a completed migration becomes indistinguishable from one that
 * never ran the moment the process restarts. The runner reports every write
 * attempt here (`path` + the last failure) and `resources/health.ts` surfaces
 * it, so a reader can tell "completed and recorded" from "completed, record
 * failed".
 *
 * In-memory by construction (same rationale as the rest of this module): the
 * durable source of truth is the state file itself — which is exactly what
 * failed to update. `lastWriteError` is cleared on the next successful write.
 */
export interface StateFileWriteError {
  migrationId: string;
  /** ISO timestamp of the failed attempt. */
  at: string;
  message: string;
}

export interface StateFileStatus {
  /** The resolved state path of the most recent write attempt, or null if none has run yet. */
  path: string | null;
  lastWriteError: StateFileWriteError | null;
}

let stateFileStatus: StateFileStatus = { path: null, lastWriteError: null };

/** Records the resolved state path on each write ATTEMPT (success or failure). */
export function noteStateWriteAttempt(path: string): void {
  stateFileStatus.path = path;
}

/** Records a failed write; cleared by the next successful write. */
export function noteStateWriteFailure(err: StateFileWriteError): void {
  stateFileStatus.lastWriteError = err;
}

/** Clears the recorded failure after a successful write. */
export function noteStateWriteSuccess(): void {
  stateFileStatus.lastWriteError = null;
}

export function getStateFileStatus(): StateFileStatus {
  return { path: stateFileStatus.path, lastWriteError: stateFileStatus.lastWriteError };
}

export function setCyclePhase(phase: CyclePhase, error?: string): void {
  cycleStatus = { phase, lastCycleError: error, lastCycleAt: new Date().toISOString() };
}

export function getCycleStatus(): CycleStatus {
  return { ...cycleStatus };
}

export function setMigrationProgress(p: MigrationProgress): void {
  progressById.set(p.id, p);
  seededFromState.delete(p.id);
}

export function getMigrationProgress(id: string): MigrationProgress | undefined {
  return progressById.get(id);
}

export function listMigrationProgress(): MigrationProgress[] {
  return Array.from(progressById.values());
}

/** Seeds an "idle" entry for every registered migration id — called once at
 * boot-trigger registration time, synchronously, so `health` always has a
 * row per registered migration even before the async cycle has run at all. */
export function seedIdleProgress(ids: readonly string[]): void {
  for (const id of ids) {
    if (!progressById.has(id)) {
      progressById.set(id, { id, rowsDone: 0, rowsRemaining: 0, state: "idle" });
    }
  }
}

/** The progress row for one durable state entry. Shared with status.ts's
 *  fallback so a boot-seeded row and a fallback row read the same. */
export function progressFromStateEntry(id: string, entry: MigrationStateEntry): MigrationProgress {
  const derivedState: MigrationState =
    entry.lastOutcome === "success" ? "completed" : entry.lastOutcome === "halted" ? "halted" : "failed";
  const row: MigrationProgress = {
    id,
    rowsDone: entry.rowsProcessed ?? 0,
    rowsRemaining: entry.rowsRemaining ?? 0,
    state: derivedState,
  };
  if (entry.reason) row.reason = entry.reason;
  if (entry.rowsUnconfirmed) {
    row.rowsUnconfirmed = entry.rowsUnconfirmed;
    if (entry.unconfirmedIds?.length) row.unconfirmedIds = entry.unconfirmedIds;
  }
  return row;
}

/**
 * Seeds the in-process progress store from the state file at boot
 * (flair#2840). A migration the state file records keeps that record —
 * including unconfirmed ids, their count and the status its last outcome maps
 * to — instead of being replaced by `idle`; one with no entry starts `idle`.
 * An existing entry is never overwritten. A seeded entry counts as not started
 * this boot until `setMigrationProgress` writes its id (see
 * {@link markUnstartedMigrationsFailed}).
 */
export function seedProgressFromState(statePath: string, ids: readonly string[]): void {
  const state = readMigrationState(statePath);
  for (const id of ids) {
    if (progressById.has(id)) continue;
    const entry = state[id];
    if (entry) {
      progressById.set(id, progressFromStateEntry(id, entry));
      seededFromState.add(id);
    } else {
      progressById.set(id, { id, rowsDone: 0, rowsRemaining: 0, state: "idle" });
    }
  }
}

/**
 * Marks every migration that did not start this boot as `failed` with
 * `reason` (flair#812): an id with no entry, an `idle` entry, or an entry
 * `seedProgressFromState` built from the state file that `setMigrationProgress`
 * has not written since (flair#2840). A seeded entry keeps its recorded
 * `rowsUnconfirmed` and `unconfirmedIds`; the rest of its row is replaced as
 * for an idle entry.
 *
 * The boot path calls this when a cycle couldn't run, so that a condition
 * which is really instance-wide (no writable data dir, tables never ready,
 * the lock itself unobtainable) shows up per-migration, which is the shape
 * `flair doctor` and `flair quality`'s `instance.migrationsClean` actually
 * read.
 *
 * Skipping an entry the runner wrote this boot is load-bearing, not tidiness:
 * a cycle can fail AFTER some migrations already reached a terminal state —
 * the pre-hash path, for instance, halts each candidate with its own precise
 * reason and THEN reports cycle failure. Overwriting those would replace a
 * specific `halted` (which the runner retries on the next boot, per its
 * documented contract) with a blanket `failed`, and would flip migrations
 * that genuinely completed this cycle to failed.
 *
 * Returns the ids actually marked, so a caller can tell "nothing had
 * started" from "the cycle died partway".
 */
export function markUnstartedMigrationsFailed(ids: readonly string[], reason: string): string[] {
  const marked: string[] = [];
  for (const id of ids) {
    const current = progressById.get(id);
    const seeded = seededFromState.has(id);
    if (current && current.state !== "idle" && !seeded) continue;
    const row: MigrationProgress = { id, rowsDone: 0, rowsRemaining: 0, state: "failed", reason };
    if (seeded && current?.rowsUnconfirmed) {
      row.rowsUnconfirmed = current.rowsUnconfirmed;
      if (current.unconfirmedIds?.length) row.unconfirmedIds = current.unconfirmedIds;
    }
    progressById.set(id, row);
    seededFromState.delete(id);
    marked.push(id);
  }
  return marked;
}

export function _resetProgressForTests(): void {
  progressById.clear();
  seededFromState.clear();
  cycleStatus = { phase: "idle" };
  stateFileStatus = { path: null, lastWriteError: null };
}
