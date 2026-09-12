/**
 * stamp-outstanding.ts — CLI-side copy of the corpus-derived
 * "is embedding-stamp still pending?" helper (flair#1073).
 *
 * INLINED, not imported from resources/: cross-boundary imports from src/
 * into resources/ do not survive npm packaging. tsconfig.cli.json compiles
 * with `rootDir: "src"`, so dist/cli.js has no resources/ module it can
 * resolve at the same relative path. Same reason as entity-vocab-cli.ts
 * and the getModelId() literals in src/cli.ts.
 *
 * Canonical module: resources/migrations/stamp-outstanding.ts (Harper
 * HealthDetail / embedding-stamp). The two files MUST stay in sync —
 * test/unit/stamp-outstanding-cli-parity.test.ts pins export names and a
 * known-answer table. Drift fails CI rather than shipping.
 */

export const EMBEDDING_STAMP_ID = "embedding-stamp";

const NON_SPACE_STAMPS: ReadonlySet<string> = new Set(["hash-512d"]);
const DEFAULT_ENGINE = "gguf";

export function normalizeStampForOutstanding(stamp: string | null | undefined): string | null {
  if (stamp == null) return null;
  const s = String(stamp).trim();
  if (s === "" || NON_SPACE_STAMPS.has(s)) return null;
  return s.includes(":") ? s : `${DEFAULT_ENGINE}:${s}`;
}

/**
 * Current-space id for a client that only has `modelCounts` (no live
 * `getModelId()`). Prefers an existing `+searchprefix` stamp so a healthy
 * bare+`gguf:` pair of the SAME space does not invent a foreign current.
 * A uniformly pre-flip corpus has no suffix — append `+searchprefix` so
 * those rows read as stale.
 */
export function resolveCurrentModelId(modelCounts: Record<string, number>, explicit?: string): string {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  let prefixed: string | undefined;
  let anyReal: string | undefined;
  for (const [stamp, n] of Object.entries(modelCounts)) {
    if (NON_SPACE_STAMPS.has(stamp) || typeof n !== "number" || n <= 0) continue;
    anyReal ??= stamp;
    if (stamp.includes("+searchprefix")) {
      if (!prefixed || stamp.includes(":")) prefixed = stamp;
    }
  }
  if (prefixed) return prefixed;
  if (anyReal) {
    const bare = anyReal.includes(":") ? anyReal.slice(anyReal.indexOf(":") + 1) : anyReal;
    return `${DEFAULT_ENGINE}:${bare}+searchprefix`;
  }
  return `${DEFAULT_ENGINE}:nomic-embed-text-v1.5-Q4_K_M+searchprefix`;
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
  /**
   * Who is reading the warning. Default `process` is HealthDetail / the
   * Harper boot runner ("this process's next migration cycle"). `client`
   * is a CLI that is not that process (`flair quality`) — do not tell
   * the operator the CLI will apply the migration (Bugbot Low on #1606).
   */
  audience?: "process" | "client";
}

export interface StampOutstanding {
  outstanding: true;
  migrationId: typeof EMBEDDING_STAMP_ID;
  staleCount: number;
  currentCount: number;
  staleStamps: string[];
  warning: string;
}

export interface StampConverged {
  outstanding: false;
  staleCount: 0;
  currentCount: number;
}

export type StampOutstandingResult = StampOutstanding | StampConverged;

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
  if (input.audience === "client") {
    return " the Harper process applies it on its next migration cycle — this CLI does not";
  }
  return " it will apply automatically on this process's next migration cycle";
}

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
