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
import type { MigrationProgress } from "./types.js";

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

/**
 * Marks every migration that never got off the starting line as `failed`
 * with `reason` — and ONLY those (flair#812).
 *
 * The boot path calls this when a cycle couldn't run, so that a condition
 * which is really instance-wide (no writable data dir, tables never ready,
 * the lock itself unobtainable) shows up per-migration, which is the shape
 * `flair doctor` and `flair quality`'s `instance.migrationsClean` actually
 * read.
 *
 * Restricting it to `idle` entries is load-bearing, not tidiness: a cycle
 * can fail AFTER some migrations already reached a terminal state — the
 * pre-hash path, for instance, halts each candidate with its own precise
 * reason and THEN reports cycle failure. Overwriting those would replace a
 * specific `halted` (which the runner retries on the next boot, per its
 * documented contract) with a blanket `failed`, and would flip migrations
 * that genuinely completed this cycle to failed. Only an entry still `idle`
 * is one nothing has said anything about yet.
 *
 * Returns the ids actually marked, so a caller can tell "nothing had
 * started" from "the cycle died partway".
 */
export function markIdleMigrationsFailed(ids: readonly string[], reason: string): string[] {
  const marked: string[] = [];
  for (const id of ids) {
    const current = progressById.get(id);
    if (current && current.state !== "idle") continue;
    progressById.set(id, { id, rowsDone: 0, rowsRemaining: 0, state: "failed", reason });
    marked.push(id);
  }
  return marked;
}

export function _resetProgressForTests(): void {
  progressById.clear();
  cycleStatus = { phase: "idle" };
}
