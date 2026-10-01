/**
 * agent-status-guard.ts — the `Agent.status` write rule for the Agent resource.
 *
 * `status` is the principal's LIFECYCLE state: any value other than "active"
 * means deactivated (resources/agent-auth.ts's isPrincipalDeactivated), so a
 * principal that may write its own `status` can deactivate itself. Liveness
 * belongs on the Presence beacon, not on this column.
 *
 * Through the Agent resource a write is a STATUS WRITE when its body carries the
 * `status` key, on any row, including the caller's own. resources/Agent.ts admits
 * such a write only from a trusted internal call or an administrator; an
 * authenticated non-admin agent's write is refused whole — the same answer
 * whether the body sets `status` alone or alongside other fields, so the other
 * fields in that request are not written either. (A federation peer's record is
 * merged through the raw table, not this resource; it separately refuses an
 * inbound status change on an existing principal — see resources/Federation.ts.)
 *
 * Deliberately dependency-free (no `harper`, no resource) so resources/Agent.ts
 * and the unit lane decide this from one place.
 */

/** The lifecycle field this module guards. */
export const AGENT_STATUS_FIELD = "status";

/** The refusal text: names the field, the internal exception, and Presence. */
export const AGENT_STATUS_ADMIN_ONLY_ERROR =
  "forbidden: status is administrator-only (a trusted internal call is excepted); report liveness through Presence";

/** True iff a write body carries the `status` field. */
export function writeIncludesStatus(content: unknown): boolean {
  return content != null && typeof content === "object" && Object.hasOwn(content, AGENT_STATUS_FIELD);
}

/**
 * Which caller verdicts an Agent-resource write admits. Anything this function
 * does not name — anonymous, or a verdict kind the auth resolver does not
 * define — is `deny`, so an unexpected verdict is refused before any mutation.
 */
export type PrincipalWriteAdmission = "internal" | "admin" | "non-admin" | "deny";

export function admitPrincipalWrite(auth: { kind?: unknown; isAdmin?: unknown } | null | undefined): PrincipalWriteAdmission {
  if (auth == null || typeof auth !== "object") return "deny";
  if (auth.kind === "internal") return "internal";
  if (auth.kind === "agent") return auth.isAdmin === true ? "admin" : "non-admin";
  return "deny";
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
