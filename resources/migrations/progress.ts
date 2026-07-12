/**
 * progress.ts — in-process, module-scope migration status. The runner
 * writes here as it works; resources/health.ts and resources/MigrationBoot.ts
 * read from here — both live in the SAME Node process, so a plain module-
 * scope store (same idiom as resources/instance-identity.ts's cache, or
 * resources/rerank-provider.ts's status counters) is sufficient; no cross-
 * process synchronization is needed for what `health` reports about THIS
 * process's own run.
 *
 * Reset to empty on every process restart by construction (module state) —
 * that's correct: after a restart, the durable source of truth for "did a
 * migration already complete" is the on-disk state file (state.ts), which
 * the runner re-derives progress from before its next cycle either way.
 */
import type { MigrationProgress } from "./types.js";

export type CyclePhase = "idle" | "pre-hash" | "running" | "done";

export interface CycleStatus {
  phase: CyclePhase;
  lastCycleError?: string;
  lastCycleAt?: string;
}

let cycleStatus: CycleStatus = { phase: "idle" };
const progressById = new Map<string, MigrationProgress>();

export function setCyclePhase(phase: CyclePhase, error?: string): void {
  cycleStatus = { phase, lastCycleError: error, lastCycleAt: new Date().toISOString() };
}

export function getCycleStatus(): CycleStatus {
  return { ...cycleStatus };
}

export function setMigrationProgress(p: MigrationProgress): void {
  progressById.set(p.id, p);
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

export function _resetProgressForTests(): void {
  progressById.clear();
  cycleStatus = { phase: "idle" };
}
