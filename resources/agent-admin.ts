/**
 * agent-admin.ts — the ONE answer to "is this principal an administrator?".
 *
 * The Agent (Principal) record carries two fields that both read as if they
 * answered that question:
 *
 *   role: String       — administrator when the value is exactly "admin"
 *   admin: Boolean     — "admin principals can manage other principals"
 *
 * They used to be consulted by DIFFERENT consumers, which is the whole defect
 * (flair#941):
 *
 *   - resources/agent-auth.ts's isAdmin() — the single gate behind allowAdmin(),
 *     and therefore behind every admin-only resource — searched `role` and
 *     ignored `admin` completely.
 *   - resources/mcp-handler.ts OR-ed the two together.
 *   - Every reporter (flair principal show/list, the admin dashboard) displayed
 *     `admin`, and every writer except AgentSeed wrote `admin`.
 *
 * So the field the product wrote and displayed was not the field the gate read.
 * `flair principal add --admin` stored `admin: true` and granted nothing, while
 * the dashboard confidently printed "admin: yes" for a principal that
 * allowAdmin() rejects. Both directions are silent, and one of them is silent in
 * the direction that flatters the operator.
 *
 * ─── The rule ────────────────────────────────────────────────────────────────
 *
 * `role === ADMIN_ROLE` is the AUTHORITY. `admin` is a SERVER-MAINTAINED MIRROR
 * of it and is never read to reach an authorization decision again.
 *
 * Every decider and every reporter calls {@link agentRecordIsAdmin}, so no two
 * surfaces can answer this question differently. Every write through a flair
 * write path calls {@link reconcileAdminFields}, so a record that says one thing
 * in one field and the opposite in the other cannot be STORED by any path flair
 * offers.
 *
 * ─── Why `role` is the authority and not `admin` ─────────────────────────────
 *
 * `admin: Boolean` is honestly the better-shaped field: typed, indexed,
 * unambiguous, and already the one every creation path and every UI uses.
 * Making it the authority would nonetheless GRANT admin, on the primary HTTP
 * gate, to every record that currently carries `admin: true` with a non-admin
 * `role` — the records `flair principal add --admin` has been producing all
 * along, which have never been admins. That is a widening of live access as a
 * side effect of a consistency fix, decided by data nobody has audited. Keeping
 * `role` as the authority changes no existing principal's rights on the gate:
 * every principal that is an admin today is an admin after this change, and
 * every principal that is not, is not.
 *
 * Switching the authority to `admin` is a reasonable follow-up, but it is a
 * deliberate privilege migration with an audit of existing records — not
 * something to slip in underneath a naming fix.
 *
 * ─── Records that already carry a mismatch ───────────────────────────────────
 *
 * Nothing is rewritten in bulk; no migration runs. What happens to each shape:
 *
 *   role:"admin" + admin:false|absent  — an admin today, an admin after. The
 *     mirror is stale, so the CLI and dashboard used to report "not an admin"
 *     for a principal holding admin rights; they now report the truth. The
 *     stored mirror is repaired the next time the record is written through the
 *     Agent resource.
 *
 *   admin:true + role not "admin"  — NOT an admin today on the gate, and not
 *     after. This is what `flair principal add --admin` produced. The CLI and
 *     dashboard used to report "admin: yes"; they now report the truth, which is
 *     how an operator finds out the grant never took. The remedy is to re-issue
 *     the grant (which now writes both fields). The one behaviour that does
 *     change is the native MCP surface, which used to honour this field on its
 *     own — see resources/mcp-handler.ts. That surface is gated behind
 *     FLAIR_MCP_OAUTH and is default-OFF, so no instance running the shipped
 *     defaults is affected.
 *
 * Deliberately dependency-free — pure predicates over a plain record, importing
 * neither `harper` nor any resource, so the auth gate, the resources, the
 * reporters and the tests can all share it without an import cycle.
 */

/** The exact `role` value that denotes a flair administrator. */
export const ADMIN_ROLE = "admin";

/**
 * THE admin predicate. Every authorization decision and every report of a
 * principal's admin status resolves through this one function.
 *
 * Total over every field combination: a record with a contradictory `admin`
 * mirror gets the SAME answer here as it does at the gate, so a contradiction
 * can never produce two different answers on two different surfaces. It is
 * deliberately NOT an OR over the two fields — see the module header.
 *
 * Note this covers Agent RECORDS only. `FLAIR_ADMIN_AGENTS` is a separate,
 * env-configured admin source union-ed in by resources/agent-auth.ts's
 * getAdminAgents(); it names agent ids and never touches a record.
 */
export function agentRecordIsAdmin(record: unknown): boolean {
  return (record as { role?: unknown } | null | undefined)?.role === ADMIN_ROLE;
}

/**
 * Make a record about to be written self-consistent, so the two fields can
 * never be STORED disagreeing.
 *
 * Admin is requested by EITHER spelling — `role: "admin"` or `admin: true` —
 * because both have been documented and both are what an operator reaches for.
 * Whichever they used, both fields come out of here agreeing. That is what
 * makes `flair principal add --admin` finally do what it says: it writes the
 * Boolean, and the Boolean now carries the record into the authority field.
 *
 * **Honouring `admin: true` here is not a privilege widening.** Every call site
 * is already admin-gated — Agent.post() is allowCreate()=allowAdmin, Agent's
 * update path refuses a privilege change from a non-admin, and AgentSeed is
 * admin-only and re-checks. A caller that can reach this could have written
 * `role: "admin"` directly; this only means they no longer have to know which
 * of the two fields is the real one.
 *
 * A non-admin `role` is free text (a human label — "researcher", "COO") and is
 * left exactly as supplied; only the admin sentinel is normalised.
 *
 * Mutates `content` in place and returns it, matching the surrounding
 * defaults-stamping style in resources/Agent.ts's post().
 */
export function reconcileAdminFields<T extends Record<string, any>>(content: T): T {
  if (!content || typeof content !== "object") return content;
  if (content.role === ADMIN_ROLE || content.admin === true) {
    content.role = ADMIN_ROLE;
    content.admin = true;
  } else {
    content.admin = false;
  }
  return content;
}

/**
 * True when a stored record's two fields disagree — i.e. it was written by
 * something other than a flair write path (a raw table write, an ops-API
 * insert, a federation merge) and now claims one thing to a reader of `admin`
 * and the opposite to the gate.
 *
 * Reporting-only. Nothing authorizes on this; it exists so a surface can SAY
 * that a record is inconsistent instead of silently picking a side.
 */
export function adminFieldsDisagree(record: unknown): boolean {
  const r = record as { role?: unknown; admin?: unknown } | null | undefined;
  if (!r || typeof r !== "object") return false;
  return agentRecordIsAdmin(r) !== (r.admin === true);
}
