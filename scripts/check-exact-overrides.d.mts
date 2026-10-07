/** Types for scripts/check-exact-overrides.mjs (flair#2301). */

export interface OverrideViolation {
  /** The root `overrides` key (the package name). */
  name: string;
  /** The range the override declares. */
  declared: string;
  /** The version bun.lock resolves for the package, or null when it has none. */
  exact: string | null;
}

/**
 * Every root `overrides` entry whose key a workspace package declares under
 * `dependencies`, `devDependencies` or `optionalDependencies`, and whose value
 * is a version range rather than an exact version. Throws when a required input
 * (the root manifest, a workspace manifest) cannot be read or parsed.
 */
export function findExactOverrideViolations(repoRoot: string): OverrideViolation[];
