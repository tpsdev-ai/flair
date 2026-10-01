/**
 * agent-status-guard.ts — `Agent.status` may be written only by an
 * administrator or a trusted internal call.
 *
 * `status` is the principal's LIFECYCLE state: any value other than "active"
 * means deactivated (resources/agent-auth.ts's isPrincipalDeactivated), so a
 * principal that may write its own `status` can deactivate itself. Liveness
 * belongs on the Presence beacon, not on this column.
 *
 * A write is a STATUS WRITE when its body carries the `status` key, on any row,
 * including the caller's own. resources/Agent.ts admits such a write only from
 * an administrator or a trusted internal call; for every other caller this
 * module returns the refusal — the same answer whether the body sets `status`
 * alone or alongside other fields, so the other fields in that request are not
 * written either.
 *
 * Deliberately dependency-free (no `harper`, no resource) so resources/Agent.ts
 * and the unit lane decide this from one place.
 */

/** The lifecycle field this module guards. */
export const AGENT_STATUS_FIELD = "status";

/** The refusal text: names the field and points at Presence. */
export const AGENT_STATUS_ADMIN_ONLY_ERROR =
  "forbidden: status is administrator-only; report liveness through Presence";

/** True iff a write body carries the `status` field. */
export function writeIncludesStatus(content: unknown): boolean {
  return content != null && typeof content === "object" && Object.hasOwn(content, AGENT_STATUS_FIELD);
}

/**
 * The response for a write that includes `status` from a caller who is not an
 * administrator, or null when the write is admitted. An administrator passes;
 * a write without `status` passes.
 */
export function statusWriteRefusal(content: unknown, callerIsAdmin: boolean): Response | null {
  if (callerIsAdmin || !writeIncludesStatus(content)) return null;
  return new Response(JSON.stringify({ error: AGENT_STATUS_ADMIN_ONLY_ERROR }), {
    status: 403, headers: { "content-type": "application/json" },
  });
}
