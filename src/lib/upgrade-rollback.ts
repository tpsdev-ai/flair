/**
 * upgrade-rollback.ts — when a post-upgrade restart failure is evidence
 * against the new version (flair#1740).
 *
 * "Restart failed" and "there was nothing running to restart" are not the
 * same condition. Confirmed-stopped (connection refused) keeps the new
 * package. A running instance still rolls back. An indeterminate /Health
 * probe is not "stopped" — rollback is not waived.
 *
 * Pure: no I/O. The command classifies prior liveness and asks the registry
 * whether the rollback target is deprecated. This module only decides.
 */

const FLAIR_PKG = "@tpsdev-ai/flair";

/** Matches classifyUpgradePriorLiveness. Indeterminate is not stopped. */
export type PriorLivenessKind = "running" | "stopped" | "indeterminate";

export interface RestartFailureInput {
  priorLiveness: PriorLivenessKind;
  /** True when this upgrade actually replaced @tpsdev-ai/flair. */
  flairWasSwapped: boolean;
  /** Previously installed version, or null when it could not be read. */
  previousVersion: string | null;
  /** Version now on disk (the upgrade target), when known. */
  installedVersion: string | null;
  /** The restart error, without a "restart failed:" prefix. */
  startError: string;
}

export type RestartFailureDecision =
  | { kind: "rollback"; toVersion: string; reason: string }
  /** Upgrade stands. The new version stays installed; start is a follow-up. */
  | { kind: "keep"; lines: string[] }
  /** @tpsdev-ai/flair was not swapped, or (when not confirmed-stopped) the previous version is unknown. */
  | { kind: "no-target" };

/**
 * What to do when the post-upgrade restart throws.
 *
 * Confirmed-stopped keeps the new version even when the previous version
 * string is unreadable — there is nothing healthy to restore, and a failed
 * start is not evidence against the install. Running and indeterminate both
 * roll back when a previous version is known. Indeterminate does not take
 * the keep path.
 */
export function decideAfterRestartFailure(input: RestartFailureInput): RestartFailureDecision {
  if (!input.flairWasSwapped) return { kind: "no-target" };
  if (input.priorLiveness === "stopped") {
    return {
      kind: "keep",
      lines: formatNotRunningRestartFailure({
        installedVersion: input.installedVersion,
        startError: input.startError,
      }),
    };
  }
  if (!input.previousVersion) return { kind: "no-target" };
  const priorNote = input.priorLiveness === "indeterminate"
    ? " (prior /Health was indeterminate, not confirmed stopped)"
    : "";
  return {
    kind: "rollback",
    toVersion: input.previousVersion,
    reason: `restart failed: ${input.startError}${priorNote}`,
  };
}

/** Lines for a confirmed-stopped restart failure that must not undo the install. */
export function formatNotRunningRestartFailure(input: {
  installedVersion: string | null;
  startError: string;
}): string[] {
  const installed = input.installedVersion
    ? `${FLAIR_PKG}@${input.installedVersion}`
    : FLAIR_PKG;
  return [
    `   ${installed} is installed.`,
    `   Before this upgrade, /Health refused the connection: no listener accepted it. That does not show that no process was running. This start failure is not evidence against the new version — nothing was rolled back.`,
    `   Start error: ${input.startError}`,
    `   Next: flair start`,
  ];
}

/**
 * Registry answer for "does npm mark this exact version deprecated?".
 * `unknown` is a failed or unusable lookup — not evidence of deprecation —
 * so rollback proceeds. Only a positive `deprecated` string refuses.
 */
export type DeprecationLookup =
  | { kind: "deprecated"; message: string }
  | { kind: "active" }
  | { kind: "unknown" };

export type DeprecatedRollbackDecision =
  | { kind: "proceed" }
  | { kind: "refuse"; lines: string[] };

/** Drop C0/C1 controls and DEL so a registry string cannot rewrite the terminal. */
export function stripControlChars(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F\u0080-\u009F]/g, "");
}

/**
 * Refuse rollback when the registry reports a deprecation. A failed lookup
 * (`unknown`) is not a deprecation and does not refuse — offline still rolls
 * back. The printed message is control-stripped.
 */
export function decideDeprecatedRollback(input: {
  toVersion: string;
  lookup: DeprecationLookup;
  installedVersion: string | null;
  reason: string;
}): DeprecatedRollbackDecision {
  if (input.lookup.kind !== "deprecated") return { kind: "proceed" };
  const cleaned = stripControlChars(input.lookup.message).trim();
  const message = cleaned || "npm marked this version deprecated";
  const installed = input.installedVersion
    ? `${FLAIR_PKG}@${input.installedVersion}`
    : "the upgraded version";
  return {
    kind: "refuse",
    lines: [
      `❌ Not rolling back to ${FLAIR_PKG}@${input.toVersion}: npm marks that version deprecated.`,
      `   Deprecation: ${message}`,
      `   ${installed} stays installed (not rolled back).`,
      `   Original failure: ${input.reason}`,
      `   Do not reinstall ${FLAIR_PKG}@${input.toVersion}.`,
      `   Check the instance: flair status`,
      `   If you need a different release, check a candidate (\`npm view ${FLAIR_PKG} version\` — not guaranteed non-deprecated) instead of returning to ${input.toVersion}.`,
    ],
  };
}

export type RollbackRecoveryLane =
  | { kind: "npm-global" }
  | {
      kind: "plain-tree";
      treeDir: string;
      failedDir: string;
      /** Where the pre-swap tree would have been. */
      previousDir: string;
      /** True only when that previous tree was actually moved back onto treeDir. */
      restored: boolean;
      /** True only when a live tree was renamed onto failedDir during that restore. */
      liveTreeSetAside: boolean;
    };

/**
 * The rollback's own restart failed on this attempt. When a previous version
 * was actually put back, `flair start` on it is not a recovery for that
 * attempt, and the headline says known-broken. When no previous tree was
 * restored, the headline stays neutral: nothing was put back to call
 * known-broken. Plain-tree text reports two filesystem results separately:
 * whether the previous tree was restored, and whether a live tree was renamed
 * to `.upgrade-failed`. Say whether a pre-upgrade data snapshot was restored.
 */
export function formatKnownBrokenRollbackRestart(input: {
  toVersion: string;
  error: string;
  /** Version the upgrade had reached before this rollback, when it differs. */
  recoveryVersion: string | null;
  lane: RollbackRecoveryLane;
  snapshotRestored: boolean;
  snapshotPath?: string | null;
}): string[] {
  const installed = `${FLAIR_PKG}@${input.toVersion}`;
  const lines: string[] = [];
  if (input.lane.kind === "plain-tree" && !input.lane.restored) {
    lines.push(
      `❌ Restart failed. No previous tree was restored: ${input.error}`,
      `   The previous tree was not restored (nothing at ${input.lane.previousDir}), so ${installed} is not what this rollback installed.`,
      `   The live tree is still at ${input.lane.treeDir}. It was not moved to ${input.lane.failedDir}.`,
      `   Do not run \`flair start\` expecting ${installed}; that version was not restored.`,
      `   Recovery (plain-tree): do not npm install -g. There is no previous tree to move back onto ${input.lane.treeDir}.`,
      `   Inspect the tree at ${input.lane.treeDir}, then run \`flair doctor\`.`,
    );
  } else {
    lines.push(
      `❌❌ KNOWN-BROKEN: rollback restart failed: ${input.error}`,
      `   ${installed} is installed and known-broken — it did not start on this attempt.`,
      `   Do not run \`flair start\` on ${installed}; it did not start on this attempt.`,
    );
    if (input.lane.kind === "plain-tree") {
      lines.push(
        `   Recovery (plain-tree): the previous tree was restored to ${input.lane.treeDir}. Do not npm install -g.`,
      );
      if (input.lane.liveTreeSetAside) {
        lines.push(`   The live tree was set aside at ${input.lane.failedDir}.`);
        if (input.recoveryVersion && input.recoveryVersion !== input.toVersion) {
          lines.push(
            `   Move ${input.lane.failedDir} back onto ${input.lane.treeDir} to return to ${FLAIR_PKG}@${input.recoveryVersion}.`,
          );
        } else {
          lines.push(
            `   Move ${input.lane.failedDir} back onto ${input.lane.treeDir} to return to the version this upgrade had reached.`,
          );
        }
      } else {
        lines.push(
          `   No live tree was moved to ${input.lane.failedDir}. Nothing was at ${input.lane.treeDir} to move.`,
        );
      }
    } else if (input.recoveryVersion && input.recoveryVersion !== input.toVersion) {
      lines.push(
        `   Recovery (npm-global): reinstall the version this upgrade had reached (it failed restart or verification in this run — check \`flair doctor\` after installing):`,
        `   npm install -g ${FLAIR_PKG}@${input.recoveryVersion}`,
        `   Or check a candidate (not guaranteed non-deprecated): npm view ${FLAIR_PKG} version`,
      );
    } else {
      lines.push(
        `   Recovery (npm-global): install another release (this installed version did not start on this attempt):`,
        `   npm view ${FLAIR_PKG} version`,
        `   Check that candidate (not guaranteed non-deprecated), then: npm install -g ${FLAIR_PKG}@<that-version>`,
      );
    }
  }
  if (input.snapshotRestored) {
    lines.push(`   A pre-upgrade data snapshot was restored before this restart failed.`);
    if (input.snapshotPath) lines.push(`   Snapshot: ${input.snapshotPath}`);
  } else {
    lines.push(`   No pre-upgrade data snapshot was restored by this rollback.`);
  }
  return lines;
}
