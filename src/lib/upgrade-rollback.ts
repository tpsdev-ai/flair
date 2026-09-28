/** Pure decisions and diagnostic formatting for upgrade rollback. */

const FLAIR_PKG = "@tpsdev-ai/flair";

/** Liveness labels consumed by decideAfterRestartFailure. */
export type PriorLivenessKind = "running" | "stopped" | "indeterminate";

export interface RestartFailureInput {
  priorLiveness: PriorLivenessKind;
  /** False makes decideAfterRestartFailure return no-target. */
  flairWasSwapped: boolean;
  /** Rollback target; a falsy value cannot select rollback. */
  previousVersion: string | null;
  /** Optional version label for the keep diagnostic. */
  installedVersion: string | null;
  /** Error text included in the reason or keep diagnostic. */
  startError: string;
}

export type RestartFailureDecision =
  | { kind: "rollback"; toVersion: string; reason: string }
  /** Selected when flairWasSwapped is true and priorLiveness is stopped. */
  | { kind: "keep"; lines: string[] }
  /** No swap, or no previous version after running/indeterminate. */
  | { kind: "no-target" };

/**
 * No swap yields no-target. Otherwise stopped yields keep, regardless of the
 * previous version. Running/indeterminate yields rollback for a nonempty
 * previous version, or no-target without one.
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

/** Format the installed-version label, refused-connection note, error and start command. */
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

/** Lookup input to decideDeprecatedRollback; only deprecated selects refuse. */
export type DeprecationLookup =
  | { kind: "deprecated"; message: string }
  | { kind: "active" }
  | { kind: "unknown" };

export type DeprecatedRollbackDecision =
  | { kind: "proceed" }
  | { kind: "refuse"; lines: string[] };

/** Remove characters in U+0000-U+001F and U+007F-U+009F. */
export function stripControlChars(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F\u0080-\u009F]/g, "");
}

/**
 * Return refuse only for lookup.kind === "deprecated"; otherwise proceed.
 * Remove control characters from the deprecation message before formatting it.
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
      /** Saved-tree path used in the missing-tree diagnostic. */
      previousDir: string;
      /** Selects the restored-tree diagnostic when true. */
      restored: boolean;
      /** True selects the set-aside-tree diagnostic after a restore. */
      liveTreeSetAside: boolean;
    };

/**
 * Plain-tree with restored: false gets a neutral restart-failure headline;
 * other lanes get KNOWN-BROKEN for this attempt. Recovery text uses the lane,
 * liveTreeSetAside and recoveryVersion. Snapshot text uses snapshotRestored.
 */
export function formatKnownBrokenRollbackRestart(input: {
  toVersion: string;
  error: string;
  /** Candidate recovery version; used when nonempty and different from toVersion. */
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
