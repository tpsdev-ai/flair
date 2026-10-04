/**
 * Type declarations for scripts/ci/select-migration-baseline.mjs (flair#1757).
 * The strict test-suite typecheck resolves the sibling .mjs through this file.
 */

/** Status string when no non-deprecated version qualifies. */
export const NO_BASELINE: "no baseline";

/** Package the lanes install as the baseline. */
export const DEFAULT_PACKAGE: string;

/** Strict x.y.z. Matches the install guard in the migration lanes. */
export const STRICT_XYZ: RegExp;

export interface SkippedVersion {
  version: string;
  reason: string;
}

export interface BaselineSelection {
  status: "ok" | "no baseline";
  baseline: string | null;
  skipped: SkippedVersion[];
  message: string;
}

export interface VersionRecord {
  version?: unknown;
  deprecated?: unknown;
}

/** True iff `version` is strict x.y.z. */
export function isStrictXyz(version: unknown): version is string;

/** Numeric x.y.z compare. Negative when `a` is older than `b`. */
export function compareStrictSemver(a: string, b: string): number;

/** The npm deprecation message, or null when the version is usable. */
export function deprecationReason(record: { deprecated?: unknown } | null | undefined): string | null;

/**
 * Newest non-deprecated strict x.y.z strictly below `headVersion`.
 * `skipped` lists deprecated versions that were passed over.
 */
export function selectMigrationBaseline(
  records: ReadonlyArray<VersionRecord | string>,
  headVersion: string,
): BaselineSelection;

/**
 * Versions strictly below HEAD, newest first, with `deprecated` filled in
 * until the first usable version (inclusive).
 */
export function collectCandidateRecords(
  versions: readonly string[],
  headVersion: string,
  readDeprecated: (version: string) => unknown,
): Array<{ version: string; deprecated: unknown }>;

/** stderr lines: skip notes, then either the chosen baseline or `no baseline`. */
export function formatSelection(selection: BaselineSelection): string[];

/** Parse `npm view <pkg> versions --json` stdout into a version list. */
export function parseNpmVersions(stdout: string): string[];

/** Parse `npm view <pkg>@<version> deprecated --json` stdout. */
export function parseDeprecatedField(stdout: string): string | null;

export function parseArgs(
  argv: string[],
): { fixture: string | null; head: string } | { error: string };

/** Process exit code: 0 when a baseline was printed, 1 otherwise. */
export function main(argv: string[]): number;
