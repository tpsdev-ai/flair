/**
 * stamp-outstanding.ts — corpus-derived "is embedding-stamp still pending?"
 * (flair#1073). Harper-free, no embedding-space-guard import: that module
 * schedules a boot pre-warm at load, and this file is imported by the CLI
 * verify path as well as /HealthDetail.
 *
 * THE point of this module: runner bookkeeping (`state: completed`,
 * `rowsDone: 0`) is not the signal. A Fabric boot that detect()'d empty,
 * or a version-keyed short-circuit, can mark embedding-stamp done while
 * the corpus is still split. Outstanding is derived from modelCounts vs
 * the current space, then annotated with whatever the runner last said
 * so the warning can name the migration AND the consequences (search
 * unreliable, dedup inactive) instead of a generic mixed-models symptom
 * with a manual `flair reembed` remedy.
 */

/** Stable id — kept here so CLI verify can import this file without loading
 *  embedding-stamp.ts (which statically imports `harper`). Re-exported from
 *  embedding-stamp.ts so existing imports keep working. */
export const EMBEDDING_STAMP_ID = "embedding-stamp";

/** Mirrors embedding-space-guard's normalizeStamp / NON_SPACE_STAMPS —
 *  inlined so this file never loads that module's boot side effect. */
const NON_SPACE_STAMPS: ReadonlySet<string> = new Set(["hash-512d"]);
const DEFAULT_ENGINE = "gguf";

export function normalizeStampForOutstanding(stamp: string | null | undefined): string | null {
  if (stamp == null) return null;
  const s = String(stamp).trim();
  if (s === "" || NON_SPACE_STAMPS.has(s)) return null;
  return s.includes(":") ? s : `${DEFAULT_ENGINE}:${s}`;
}

export interface StampMigrationProgress {
  id: string;
  state: string;
  rowsDone?: number;
  rowsRemaining?: number;
  reason?: string;
}

export interface StampOutstandingInput {
  modelCounts: Record<string, number>;
  currentModelId: string;
  migration?: StampMigrationProgress;
  cyclePhase?: string;
  lastCycleError?: string | null;
}

export interface StampOutstanding {
  outstanding: true;
  migrationId: typeof EMBEDDING_STAMP_ID;
  staleCount: number;
  currentCount: number;
  /** Distinct raw stamps that are not the current space (for the warning). */
  staleStamps: string[];
  warning: string;
}

export interface StampConverged {
  outstanding: false;
  staleCount: 0;
  currentCount: number;
}

export type StampOutstandingResult = StampOutstanding | StampConverged;

/**
 * Split the corpus into current-space vs foreign-space counts. A bare
 * stamp and its `gguf:` equivalent are the SAME space; `+searchprefix`
 * vs bare-without-suffix are NOT (that split is this migration's payload).
 */
export function countStampSpaces(
  modelCounts: Record<string, number>,
  currentModelId: string,
): { currentCount: number; staleCount: number; staleStamps: string[]; currentSpace: string | null } {
  const currentSpace = normalizeStampForOutstanding(currentModelId);
  let currentCount = 0;
  let staleCount = 0;
  const staleStamps: string[] = [];
  for (const [raw, n] of Object.entries(modelCounts)) {
    if (typeof n !== "number" || n <= 0) continue;
    const space = normalizeStampForOutstanding(raw);
    if (space === null) continue;
    if (currentSpace !== null && space === currentSpace) {
      currentCount += n;
    } else {
      staleCount += n;
      staleStamps.push(`${raw}:${n}`);
    }
  }
  return { currentCount, staleCount, staleStamps, currentSpace };
}

function runnerAnnotation(input: StampOutstandingInput): string {
  const mig = input.migration;
  const phase = input.cyclePhase;
  if (input.lastCycleError) {
    return ` last boot cycle failed (${input.lastCycleError})`;
  }
  if (phase === "idle") {
    return " migration boot cycle never fired on this instance — no migration will run until this is resolved";
  }
  if (mig?.state === "running" || mig?.state === "checking" || mig?.state === "preflight" || mig?.state === "snapshotting" || mig?.state === "completing") {
    const rem = typeof mig.rowsRemaining === "number" ? `, ${mig.rowsRemaining} remaining` : "";
    return ` in progress (${mig.state}${rem})`;
  }
  if (mig?.state === "halted" || mig?.state === "failed") {
    return ` ${mig.state}${mig.reason ? `: ${mig.reason}` : ""} — see \`flair doctor\``;
  }
  if (mig?.state === "completed" || phase === "done") {
    return " the last cycle marked it complete without converging; it will retry automatically";
  }
  return " it will apply automatically on this process's next migration cycle";
}

/**
 * Corpus-derived outstanding check. Returns `outstanding: false` when every
 * real-space stamp matches the current space (or the store is empty of
 * real embeddings). Runner bookkeeping cannot override a split corpus.
 */
export function describeStampOutstanding(input: StampOutstandingInput): StampOutstandingResult {
  const { currentCount, staleCount, staleStamps } = countStampSpaces(input.modelCounts, input.currentModelId);
  if (staleCount === 0) {
    return { outstanding: false, staleCount: 0, currentCount };
  }
  const list = staleStamps.join(", ");
  const warning =
    `migration '${EMBEDDING_STAMP_ID}' is outstanding ` +
    `(${staleCount} row${staleCount === 1 ? "" : "s"} still on ${list}` +
    `${currentCount > 0 ? `, ${currentCount} already current` : ""}) — ` +
    `cross-model search is unreliable and duplicate detection is inactive ` +
    `until the re-embed completes;` +
    runnerAnnotation(input);
  return {
    outstanding: true,
    migrationId: EMBEDDING_STAMP_ID,
    staleCount,
    currentCount,
    staleStamps,
    warning,
  };
}

/**
 * Convergence predicate for `upgrade --target` / `deploy` post-verify
 * (flair#1073). A split corpus is not converged. A halted/failed
 * embedding-stamp is not converged. A still-running cycle is not
 * converged. Missing migration state on a split corpus is not converged.
 * An empty / already-current corpus is converged.
 */
export function stampMigrationConverged(input: StampOutstandingInput): { converged: boolean; detail: string } {
  const described = describeStampOutstanding(input);
  if (described.outstanding) {
    return { converged: false, detail: described.warning };
  }
  const mig = input.migration;
  if (mig?.state === "halted" || mig?.state === "failed") {
    return {
      converged: false,
      detail: `migration '${EMBEDDING_STAMP_ID}' ${mig.state}${mig.reason ? `: ${mig.reason}` : ""}`,
    };
  }
  if (
    mig &&
    (mig.state === "running" ||
      mig.state === "checking" ||
      mig.state === "preflight" ||
      mig.state === "snapshotting" ||
      mig.state === "completing")
  ) {
    return { converged: false, detail: `migration '${EMBEDDING_STAMP_ID}' still ${mig.state}` };
  }
  return { converged: true, detail: "embedding-stamp converged (corpus is a single current space)" };
}
