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
  /** Rows recorded as unconfirmed and not since cleared: a write this
   *  migration made but could not verify, or a loopback re-embed that answered
   *  503 `write_outcome_unknown`, which can reflect an earlier writer's
   *  unresolved write. A listed id clears
   *  when a later batch verifies its write or a later read finds the row at
   *  the target or gone; the ids beyond `unconfirmedIds` are carried as a
   *  number that no later batch or read reduces (flair#2840). */
  rowsUnconfirmed?: number;
  /** Up to `UNCONFIRMED_IDS_LIMIT` of those row ids. */
  unconfirmedIds?: string[];
}

export type MigrationStateFile = Record<string, MigrationStateEntry>;

export function defaultStatePath(dataDir: string): string {
  return join(dataDir, ".migrations", "state.json");
}

export function readMigrationState(path: string): MigrationStateFile {
  try {
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (raw && typeof raw === "object") return raw;
    console.warn(
      `[flair-migrations] ${path} is not a JSON object — ignoring it and re-detecting every migration this boot`,
    );
    return {};
  } catch (err) {
    // Corrupt/unreadable state — treat as "nothing known yet", never throw.
    // Worst case this costs one extra (cheap, bounded) detect() call.
    //
    // flair#812: but SAY SO. This file is hand-edited in practice (the
    // documented remediation for a stuck migration), and a fat-fingered
    // edit silently discarding every recorded outcome is precisely the
    // class of quiet failure this issue is about. The behaviour is
    // unchanged and still safe — only the silence is fixed.
    console.warn(
      `[flair-migrations] could not read ${path} (${(err as Error)?.message ?? String(err)}) — ` +
        `treating migration state as empty and re-detecting every migration this boot`,
    );
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
