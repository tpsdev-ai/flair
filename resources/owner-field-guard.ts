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
 * ─── Scope: this guard is a fail-closed BACKSTOP, not the first line ─────────
 *
 * On the HTTP path, the stored row is normally read by Harper BEFORE this guard
 * runs. Harper's REST layer resolves a `/<Table>/<id>` request through
 * `Table.getResource` → `resource._loadRecord` (harper 5.3.1,
 * dist/resources/Table.js ~1631/1640), which loads the row and binds it to the
 * instance's `#record`. A no-argument `super.get()` (the thunk every caller here
 * passes) then returns that cached record and performs NO fresh read. So an
 * unreadable row is refused One Layer Up, at the load: measured on real Harper
 * 5.3.1 (test/integration/owner-guard-2468-real-harper-load.test.ts), a forced
 * failure of `_loadRecord` on an existing owner-guarded row answers the client
 * Harper's own 500 (an RFC 9457 problem detail) for every owner-guarded PUT and
 * PATCH — the resource method never runs and this guard's named refusal never
 * appears.
 *
 * This guard's own read is therefore the read that fails only off the HTTP
 * dispatch path: an in-process call, or a resource that reads the row itself
 * (Memory, Integration, Relationship and friends call `resolveStoredRow` for
 * the create/update decision, and Soul reaches that resolver FIRST — see
 * below). It exists so that a failed read can never be mistaken for "no stored
 * row" and read as permission to write. That is defence in depth behind
 * Harper's load, and the unit tests below exercise exactly the seam real Harper
 * cannot reach over HTTP.
 *
 * ─── Two callers do not read through this guard's thunk ─────────────────────
 *
 * `Soul` resolves the stored row through `resolveStoredRow`
 * (resources/originator-instance.ts) before it calls this guard, and passes the
 * ALREADY-RESOLVED row (`() => existing`), not a fresh read. A failure there is
 * refused even earlier with the resolver's own named `stored_row_lookup_failed`
 * (500) — this guard never sees it. Callers that read the row themselves
 * (Memory, Integration, Relationship, OrgSkillAssignment via
 * `resolveStoredRow`) likewise hit that resolver's refusal before this guard's.
 *
 * Admin and internal callers bypass this guard entirely (it returns null before
 * reading anything), so an unreadable row does not refuse them HERE — they pass
 * through and any refusal is Harper's own load or the resolver's.
 */
import { resolveAgentAuth } from "./agent-auth.js";
import { isForbiddenOwnerFieldChange } from "./record-owner-guard.js";

/** The named refusal for a write whose stored record could not be READ. */
export const OWNER_CHECK_UNAVAILABLE_ERROR = "owner_check_unavailable";

/**
 * The refusal a write gets when the stored row could not be READ.
 *
 * A read ERROR is not the same as "no stored row" (a `null`/`undefined`
 * result). The owner-field rule reads a `null` record as a create and lets the
 * write through, so collapsing a failed read into `null` would make a
 * stored-row read failure permission to write. Without the stored record there
 * is no way to tell a re-pointed owner field from a legitimate one, so the write
 * is refused.
 *
 * A client error from the read answers 400 (the caller's request was bad and a
 * retry with the same input will fail the same way); anything else 503, since a
 * retry can succeed. The write does not happen.
 *
 * On the HTTP path this refusal is a backstop: Harper's `_loadRecord` already
 * loads the row before the resource runs, so a genuinely unreadable row is
 * refused one layer up with Harper's own error (see the file header). This
 * answers the reads Harper's load does not perform — in-process calls, or a
 * resource whose own read is the one that fails. Admin and internal callers
 * return from `guardOwnerFieldImmutable` before the read, so they never reach
 * here.
 */
export function ownerCheckUnavailable(err: unknown): Response {
  console.error(
    "owner-field-guard: the stored record could not be read, so the write was refused",
    { err },
  );
  const code = (err as { statusCode?: unknown } | null | undefined)?.statusCode;
  const status = typeof code === "number" && code >= 400 && code < 500 ? 400 : 503;
  return new Response(
    JSON.stringify({
      error: OWNER_CHECK_UNAVAILABLE_ERROR,
      message: "the stored record could not be read; the write was refused",
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/**
 * Enforce owner-field immutability for one write.
 *
 * @param self        the resource instance (`this`)
 * @param getExisting a thunk that returns the STORED record — pass `() => super.get()`
 *                    so the raw base-table read is used rather than any get() override
 * @param content     the write content (the caller's claim)
 * @param ownerField  the column naming the owning principal for this table
 * @returns a Response to send (401 unauthenticated, 403 owner-field change,
 *          400/503 stored-row read failure), or null to proceed
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
