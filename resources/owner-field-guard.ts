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
 */
import { resolveAgentAuth } from "./agent-auth.js";
import { isForbiddenOwnerFieldChange } from "./record-owner-guard.js";

/**
 * Enforce owner-field immutability for one write.
 *
 * @param self        the resource instance (`this`)
 * @param getExisting a thunk that returns the STORED record — pass `() => super.get()`
 *                    so the raw base-table read is used rather than any get() override
 * @param content     the write content (the caller's claim)
 * @param ownerField  the column naming the owning principal for this table
 * @returns a 403 Response to send, or null to proceed
 */
export async function guardOwnerFieldImmutable(
  self: any,
  getExisting: () => unknown,
  content: any,
  ownerField: string,
): Promise<Response | null> {
  const auth = await resolveAgentAuth((self as any).getContext?.());
  if (auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin)) return null;

  const existing = (await Promise.resolve(getExisting()).catch(() => null)) as
    | Record<string, unknown>
    | null;

  if (isForbiddenOwnerFieldChange(existing, content, ownerField, auth.agentId)) {
    return new Response(
      JSON.stringify({ error: "forbidden: the owner of a record cannot be changed" }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }
  return null;
}
