export interface OverrideViolation {
  name: string;
  /** The declared non-exact specifier. */
  declared: string;
  /** Lockfile version suggestion, or null. */
  exact: string | null;
}

/**
 * Check declared direct override keys matching workspace dependencies,
 * devDependencies or optionalDependencies; workspace: values are exempt.
 * Throws on input/checker errors, including no workspace manifests.
 */
export function findExactOverrideViolations(
  repoRoot: string,
  options?: { staged?: boolean },
): OverrideViolation[];
