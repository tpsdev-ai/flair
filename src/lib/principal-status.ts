/**
 * principal-status.ts — the ONE "is this principal deactivated?" predicate
 * (flair#2378).
 *
 * `Agent.status` is a principal's lifecycle state. The auth path decides it
 * here: a principal is deactivated when `status` is present and is not exactly
 * "active". An ABSENT (undefined) `status` means active.
 *
 * The human-readable `flair principal show` and `principal list` outputs call
 * this function and read the principal as stored — `show` over REST, `list` from an
 * unprojected row — so an absent `status` (active) stays distinct from an
 * explicit `null`, which the gate treats as deactivated.
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
