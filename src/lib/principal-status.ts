/**
 * principal-status.ts — the ONE "is this principal deactivated?" predicate
 * (flair#2378).
 *
 * `Agent.status` is a principal's lifecycle state. The auth path decides it
 * here: a principal is deactivated when `status` is present and is not exactly
 * "active". An ABSENT (undefined) `status` means active, and a null/undefined
 * principal is not deactivated — such a request fails later on a missing
 * public key or an unknown user, not on this check.
 *
 * `flair principal show` and `principal list` report the same verdict and call
 * THIS function rather than re-deriving it. That matters because the operations
 * API materialises a cleared column as an explicit `null`: the two reporters
 * used to fold it into "active", so a deactivated principal displayed as active
 * while the gate refused it. Calling the shared predicate makes an explicit
 * null read as deactivated rather than active.
 *
 * Deliberately dependency-free (no `harper`, no resource) so both the CLI
 * (`src/`) and the server (`resources/`) import it: `src/` must not import
 * `resources/`, because those imports do not survive npm packaging.
 */

/**
 * True iff this principal is deactivated: its `status` is present and is not
 * exactly the string "active". A null/undefined principal, or one whose
 * `status` is undefined, is not deactivated.
 */
export function isPrincipalDeactivated(agent: { status?: unknown } | null | undefined): boolean {
  if (agent == null) return false;
  if (agent.status === undefined) return false;
  return agent.status !== "active";
}
