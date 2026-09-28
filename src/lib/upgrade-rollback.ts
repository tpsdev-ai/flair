/**
 * upgrade-rollback.ts — when a post-upgrade restart failure is evidence
 * against the new version (flair#1740).
 *
 * "Restart failed" and "there was nothing running to restart" are not the
 * same condition. The first, on an instance that was up before the upgrade,
 * means the new version is bad and rolling back is right. The second means
 * the upgrade succeeded and the pre-existing state was already down — rolling
 * back can return the operator to a known-broken publish (0.54.1).
 *
 * Pure: no I/O. The command records whether /Health answered before the
 * package swap, and asks the registry whether the rollback target is
 * deprecated. This module only decides.
 */

const FLAIR_PKG = "@tpsdev-ai/flair";

export interface RestartFailureInput {
  /** True when the pre-upgrade /Health probe got a 2xx. False when nothing was up. */
  wasRunning: boolean;
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
  /** @tpsdev-ai/flair was not swapped, or the previous version is unknown. */
  | { kind: "no-target" };

/**
 * What to do when the post-upgrade restart throws.
 *
 * A stopped or never-started install does not roll back: the start failure
 * is not evidence against the version that was just installed. An instance
 * that was running keeps today's rollback (subject to the deprecation gate
 * inside the rollback itself).
 */
export function decideAfterRestartFailure(input: RestartFailureInput): RestartFailureDecision {
  if (!input.flairWasSwapped || !input.previousVersion) return { kind: "no-target" };
  if (!input.wasRunning) {
    return {
      kind: "keep",
      lines: formatNotRunningRestartFailure({
        installedVersion: input.installedVersion,
        startError: input.startError,
      }),
    };
  }
  return {
    kind: "rollback",
    toVersion: input.previousVersion,
    reason: `restart failed: ${input.startError}`,
  };
}

/** Lines for a restart failure that must not undo the install (flair#1740). */
export function formatNotRunningRestartFailure(input: {
  installedVersion: string | null;
  startError: string;
}): string[] {
  const installed = input.installedVersion
    ? `${FLAIR_PKG}@${input.installedVersion}`
    : FLAIR_PKG;
  return [
    `   ${installed} is installed.`,
    `   The instance was not running before this upgrade, so this start failure is not evidence against the new version — nothing was rolled back.`,
    `   Start error: ${input.startError}`,
    `   Next: flair start`,
  ];
}

/**
 * Registry answer for "does npm mark this exact version deprecated?".
 * `unknown` is a failed lookup — not evidence of deprecation — so rollback
 * proceeds as it does today. Only a positive `deprecated` string refuses.
 */
export type DeprecationLookup =
  | { kind: "deprecated"; message: string }
  | { kind: "active" }
  | { kind: "unknown" };

export type DeprecatedRollbackDecision =
  | { kind: "proceed" }
  | { kind: "refuse"; lines: string[] };

/**
 * Never roll back onto a version npm has marked deprecated (flair#1740).
 * Called from every rollback, including post-restart verification failure,
 * not only the restart-threw path.
 */
export function decideDeprecatedRollback(input: {
  toVersion: string;
  lookup: DeprecationLookup;
  installedVersion: string | null;
  reason: string;
}): DeprecatedRollbackDecision {
  if (input.lookup.kind !== "deprecated") return { kind: "proceed" };
  const message = input.lookup.message.trim() || "npm marked this version deprecated";
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
      `   If you need a different release, install a non-deprecated version (\`npm view ${FLAIR_PKG} version\`) instead of returning to ${input.toVersion}.`,
    ],
  };
}

/**
 * The rollback's own restart failed. The version now on disk is known-broken:
 * telling the operator to `flair start` it is not a recovery that can succeed.
 * Exit nonzero around these lines.
 */
export function formatKnownBrokenRollbackRestart(input: {
  toVersion: string;
  error: string;
  /** Version the upgrade had reached before this rollback, when it differs. */
  recoveryVersion: string | null;
}): string[] {
  const installed = `${FLAIR_PKG}@${input.toVersion}`;
  const lines = [
    `❌❌ KNOWN-BROKEN: rollback restart failed: ${input.error}`,
    `   ${installed} is installed and known-broken — it failed to start after the rollback.`,
    `   Do not run \`flair start\` on ${installed}; this version cannot start.`,
  ];
  if (input.recoveryVersion && input.recoveryVersion !== input.toVersion) {
    lines.push(
      `   Recovery: reinstall the version this upgrade had reached before the rollback:`,
      `   npm install -g ${FLAIR_PKG}@${input.recoveryVersion}`,
    );
  } else {
    lines.push(
      `   Recovery: install a non-deprecated release (this installed version cannot start):`,
      `   npm view ${FLAIR_PKG} version`,
      `   npm install -g ${FLAIR_PKG}@<that-version>`,
    );
  }
  lines.push(`   Your data in ~/.flair was not touched by the package rollback.`);
  return lines;
}
