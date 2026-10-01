/**
 * agent-status-guard.ts — the `Agent.status` write rule for the Agent resource.
 *
 * `status` is the principal's LIFECYCLE state: any present value other than
 * "active" means deactivated, and a missing or undefined `status` is treated as
 * active (resources/agent-auth.ts's isPrincipalDeactivated). So a principal that
 * may write its own `status` can deactivate itself. Liveness belongs on the
 * Presence beacon, not on this column.
 *
 * resources/Agent.ts's PUT and PATCH admit a trusted internal call and an
 * administrator, and refuse anonymous and any verdict kind the auth resolver
 * does not define. A non-admin agent's PUT or PATCH whose body carries the
 * `status` key is refused whole, on any row including its own, so the other
 * fields in that request are not written either; without `status`, it goes on
 * to Agent.ts's other per-record rules. A non-admin agent's POST (create) is
 * refused earlier, at allowCreate(). (A federation peer's record is merged
 * through the raw table, not this resource; resources/Federation.ts skips an
 * inbound Agent record whose `status` differs from an existing local
 * principal's stored value.)
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
 * How resources/Agent.ts's PUT and PATCH classify a caller verdict: `internal`
 * and `admin` are admitted, `non-admin` goes on to the per-record rules, and
 * anything else — anonymous, or a verdict kind the auth resolver does not
 * define — is `deny`, refused before any mutation.
 */
export type PrincipalWriteAdmission = "internal" | "admin" | "non-admin" | "deny";

export function admitPrincipalWrite(auth: { kind?: unknown; isAdmin?: unknown } | null | undefined): PrincipalWriteAdmission {
  if (auth == null || typeof auth !== "object") return "deny";
  if (auth.kind === "internal") return "internal";
  if (auth.kind === "agent") return auth.isAdmin === true ? "admin" : "non-admin";
  return "deny";
}

/**
 * The 403 for a write whose body includes `status` from a caller who is not an
 * administrator, or null when the caller is an administrator or the body has no
 * `status`. resources/Agent.ts admits a trusted internal call without calling
 * this helper.
 */
export function statusWriteRefusal(content: unknown, callerIsAdmin: boolean): Response | null {
  if (callerIsAdmin || !writeIncludesStatus(content)) return null;
  return new Response(JSON.stringify({ error: AGENT_STATUS_ADMIN_ONLY_ERROR }), {
    status: 403, headers: { "content-type": "application/json" },
  });
}
