export interface OverrideViolation {
  name: string;
  /** The declared non-exact specifier. */
  declared: string;
  /** Exact semver from the lockfile, or null. */
  exact: string | null;
}

/**
 * Check declared direct override keys matching workspace dependencies,
 * devDependencies or optionalDependencies; workspace: values are exempt.
 * Throws on invalid manifests or a present unreadable/unparsable bun.lock.
 */
export function findExactOverrideViolations(
  repoRoot: string,
  options?: { staged?: boolean },
): OverrideViolation[];
