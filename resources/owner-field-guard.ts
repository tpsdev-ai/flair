/**
 * owner-field-guard.ts — the single resource-layer delegate that enforces
 * owner-field immutability for principal-owning tables.
 *
 * ─── Why this is at the resource layer, not the middleware ────────────────────
 *
 * The shared record-ownership guard (record-owner-guard.ts, applied by
 * auth-middleware.ts) already refuses a non-owner mutating a stored row, on
 * every verb, reading ownership from stored state. What it CANNOT do is decide
 * whether a write CHANGES the owner field, because that needs the request body —
 * and Harper's middleware Request exposes no parsed body (no `.json()`, no
 * `.clone()`; `.body` is a single-consumption stream). So this rule lives one
 * layer down, where Harper hands the resource its parsed `content`.
 *
 * That is exactly why resources/Agent.ts enforces its analogous rule (a
 * principal's admin status) in the resource and not the middleware. This file is
 * the generalisation of that pattern for the ordinary owner field, kept in ONE
 * place so the per-resource put()/patch() overrides are a thin delegation rather
 * than N hand-written checks that could drift apart.
 *
 * ─── The rule ────────────────────────────────────────────────────────────────
 *
 *   A non-admin caller may not write a value into a stored record's owner field
 *   that differs from the value already there.
 *
 * Admin and internal callers pass through. A create (no stored record yet) is
 * not this rule's business — no-forge attribution on creation is each resource's
 * own job. The decision itself is the pure `isForbiddenOwnerFieldChange`
 * (record-owner-guard.ts), so it is unit-tested without a Harper instance.
 *
 * ─── Read-failure scope ─────────────────────────────────────────────────────
 *
 * For addressed single-record HTTP PUT/PATCH, Harper loads the row through
 * `Table.getResource` → `resource._loadRecord` before the resource method runs;
 * a no-argument `super.get()` then returns the cached row. If reached before
 * that load, the non-admin write guard checks body ids before stored ownership.
 * Its stored-row read failure returns `owner_check_unavailable`. The
 * real-Harper test injects an initial load failure: a non-admin agent gets that
 * named refusal, and an administrator gets Harper's own 500. It does not cover
 * collection paths.
 *
 * This guard returns `owner_check_unavailable` only when a non-admin agent's
 * `getExisting` thunk throws or rejects. Admin/internal callers return before
 * the thunk; unauthenticated callers receive 401 before it.
 *
 * Soul first reads through `resolveStoredRow` and passes an already-resolved row
 * to this guard. That resolver's `stored_row_lookup_failed` (500) is a separate
 * refusal for a read this guard does not backstop.
 */
import { resolveAgentAuth } from "./agent-auth.js";
import { isForbiddenOwnerFieldChange, ownerCheckUnavailable } from "./record-owner-guard.js";

// The named refusal and its constant live in record-owner-guard.ts, which has
// no authentication-module dependency, so the owner-scoped write guard can use
// them without importing this module;
// re-exported here for this module's existing importers.
export { OWNER_CHECK_UNAVAILABLE_ERROR, ownerCheckUnavailable } from "./record-owner-guard.js";

/**
 * Enforce owner-field immutability for one write.
 *
 * @param self        the resource instance (`this`)
 * @param getExisting a thunk returning stored state, e.g. `() => super.get()`
 *                    or Soul's already-resolved row
 * @param content     the write content (the caller's claim)
 * @param ownerField  the column naming the owning principal for this table
 * @returns a Response to send (401 unauthenticated, 403 owner-field change,
 *          400/503 non-admin agent's guard-thunk failure), or null to proceed
 */
export async function guardOwnerFieldImmutable(
  self: any,
  getExisting: () => unknown,
  content: any,
  ownerField: string,
): Promise<Response | null> {
  const auth = await resolveAgentAuth((self as any).getContext?.());
  if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) return null;

  // Any caller that is not a resolved agent (anonymous, or an identity that did
  // not resolve) has no owner identity to match against, so it may not proceed
  // on an owner-bearing write path — fail closed. The denial is 401, not 403:
  // an unresolved caller is unauthenticated, which is the same contract every
  // principal-owning resource already returns for anonymous writes, and the
  // owner-field rule only applies to a caller that HAS an owner identity. This
  // also narrows `auth` to the agent variant, so `auth.agentId` below is typed.
  if (auth.kind !== "agent") {
    return new Response(
      JSON.stringify({ error: "authentication required" }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }

  // A read that RESOLVED to null/undefined is "no stored row" (a create, which
  // this rule leaves to each resource). A read that THREW or rejected is a
  // FAILURE, and the guard refuses it rather than reading it as "no stored row".
  let existing: Record<string, unknown> | null;
  try {
    existing = ((await Promise.resolve(getExisting())) ?? null) as Record<string, unknown> | null;
  } catch (err) {
    return ownerCheckUnavailable(err);
  }

  if (isForbiddenOwnerFieldChange(existing, content, ownerField, auth.agentId)) {
    return new Response(
      JSON.stringify({ error: "forbidden: the owner of a record cannot be changed" }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }
  return null;
}
