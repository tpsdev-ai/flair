/**
 * state.ts — the health-tracked "last migration completed at version X"
 * marker (Kern verdict, detect() fallback): "detect() cheap + read-only —
 * bounded query (limit=1 style), never O(corpus) on boot; answers 'is there
 * work,' not 'how much.' Fallback: a health-tracked 'last migration
 * completed at version X' short-circuit."
 *
 * A small on-disk JSON sidecar (same idiom as the REM nightly log / PID
 * file / version-check cache — plain files under the instance's own
 * footprint, not a Harper table: adding a new table to record migration
 * state would itself be a migration, a chicken-and-egg this avoids
 * entirely). Lives under `<dataDir>/.migrations/state.json` — co-located
 * with the data it protects rather than under a fixed `~/.flair`, since
 * HDB_ROOT can point anywhere per-instance (matches resources/health.ts's
 * own dataDir resolution).
 *
 * Once a migration's entry shows `completedAtVersion === <the currently
 * running version>` and `lastOutcome === "success"`, the runner skips
 * calling that migration's detect() ENTIRELY on this and every subsequent
 * boot at the same version — zero query cost, not just a cheap one.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureSecureDir, writeSecureFile } from "./dir-safety.js";

export type MigrationOutcome = "success" | "halted" | "failed";

export interface MigrationStateEntry {
  completedAtVersion?: string;
  completedAt?: string;
  lastOutcome: MigrationOutcome;
  reason?: string;
  rowsProcessed?: number;
  rowsRemaining?: number;
}

export type MigrationStateFile = Record<string, MigrationStateEntry>;

export function defaultStatePath(dataDir: string): string {
  return join(dataDir, ".migrations", "state.json");
}

export function readMigrationState(path: string): MigrationStateFile {
  try {
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    // Corrupt/unreadable state — treat as "nothing known yet", never throw.
    // Worst case this costs one extra (cheap, bounded) detect() call.
    return {};
  }
}

export function writeMigrationStateEntry(path: string, id: string, entry: MigrationStateEntry): void {
  const dir = dirname(path);
  ensureSecureDir(dir);
  const current = readMigrationState(path);
  current[id] = entry;
  writeSecureFile(path, JSON.stringify(current, null, 2) + "\n", dir);
}

/**
 * True when this migration can be skipped WITHOUT calling detect() at all —
 * it already completed successfully at the currently running version.
 */
export function isShortCircuited(state: MigrationStateFile, migrationId: string, runningVersion: string): boolean {
  const entry = state[migrationId];
  return !!entry && entry.lastOutcome === "success" && entry.completedAtVersion === runningVersion;
}

/** For health/doctor: the most recent state-file mtime, if any (cheap "when did anything last change" signal). */
export function statePathMtime(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}
