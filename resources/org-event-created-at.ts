/**
 * org-event-created-at.ts — the createdAt check for OrgEvent writes: the server
 * assigns an event's createdAt on create, and a write that reaches this check
 * cannot change a stored row's createdAt.
 *
 * The check runs after the resource's earlier checks (authentication,
 * ownership, attribution, entity validation), which answer first with their own
 * responses, as Harper's own validation does for input it refuses before the
 * resource runs. For each record that reaches it:
 *
 *   - a record that is not an object, or whose id is not a non-empty string or
 *     a non-empty array of strings, is not read: it is refused with
 *     `invalid_event_id` (400) before any write. (At the root collection, POST
 *     generates an id when the body's id is missing, null or empty; on any
 *     path, POST refuses an id that is not one of those two shapes with the
 *     same 400 before its ownership lookup.);
 *   - otherwise the check reads the stored row under that id. With no stored
 *     row (a create), createdAt is the server's time, whatever the body says;
 *   - with a stored row, its createdAt is authoritative whatever its value, an
 *     empty string included. A body that omits createdAt keeps the stored
 *     value; a body whose createdAt differs from it is refused with
 *     `created_at_immutable` (409), and nothing is written.
 *
 * resources/OrgEvent.ts runs this check for writes from verified agents and
 * administrators on POST, PUT (single record, an administrator's collection
 * PUT, and each element of an array body) and PATCH. A non-admin agent's
 * collection PUT or PATCH is refused before this check by the owner-scoped
 * write guard (resources/owner-scoped-write-policy.ts). Trusted in-process
 * writers that supply their own createdAt (the migration ledger, the graph-heal migration) write
 * through the raw `databases.flair.OrgEvent` table, not the resource's verbs,
 * and an `internal` verdict on the resource passes through unchanged.
 *
 * The stored row is read before the write and the two are not atomic: a row
 * first written between the read and the write is treated as a create, so its
 * createdAt becomes this write's server time.
 *
 * The decision is pure and has no Harper import, so it is unit-tested directly.
 */

export const CREATED_AT_IMMUTABLE_ERROR = "created_at_immutable";
export const CREATED_AT_CHECK_UNAVAILABLE_ERROR = "created_at_check_unavailable";
export const INVALID_EVENT_ID_ERROR = "invalid_event_id";

/**
 * How the write applies its content: "replace" stores the content as the whole
 * row (POST and PUT), so an omitted createdAt is filled from the stored row;
 * "merge" changes only the fields the content names (PATCH), so an omitted
 * createdAt is left out and the stored value stays.
 */
export type CreatedAtWriteMode = "replace" | "merge";

/** 409 for a write that reaches the check and would change a stored event's createdAt. Echoes nothing. */
export function createdAtImmutable(): Response {
  return new Response(
    JSON.stringify({
      error: CREATED_AT_IMMUTABLE_ERROR,
      message: "this write would change the stored event's createdAt, which the server assigns on create",
    }),
    { status: 409, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * 503 when this check's own stored-event read fails, so the write was refused.
 * Read failures in earlier checks keep their own responses.
 */
export function createdAtCheckUnavailable(err: unknown): Response {
  console.error(
    "org-event-created-at: the stored event could not be read, so the write was refused",
    { err },
  );
  return new Response(
    JSON.stringify({
      error: CREATED_AT_CHECK_UNAVAILABLE_ERROR,
      message: "the stored event could not be read; the write was refused",
    }),
    { status: 503, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * 400 for a record the check does not read: one that is not an object, or whose
 * id is not a key the check reads (see isReadableEventId). Echoes nothing.
 */
export function invalidEventId(): Response {
  return new Response(
    JSON.stringify({
      error: INVALID_EVENT_ID_ERROR,
      message: "each OrgEvent a write stores must be an object whose id is a non-empty string or a non-empty array of strings",
    }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Whether the check reads the stored row under `id`: a non-empty string, or a
 * non-empty array of strings (a composite key). The check refuses every other
 * id with `invalid_event_id` before any write. Harper accepts some of those ids
 * as keys (the empty string is one), so the refusal is this check's own rule,
 * not something left to Harper's validation.
 */
export function isReadableEventId(id: unknown): id is string | string[] {
  if (typeof id === "string") return id !== "";
  return Array.isArray(id) && id.length > 0 && id.every((part) => typeof part === "string");
}

/**
 * Assign or keep `content.createdAt` for one write, given the stored row the
 * write lands on (`stored` null/undefined = no stored row, a create). Mutates
 * `content`. Returns null to proceed, or the refusal to send.
 *
 * For a stored row, the stored createdAt is authoritative whatever its value,
 * an empty string included: a body that names a different value is refused,
 * and a body that omits it keeps the stored value.
 */
export function applyServerCreatedAt(
  content: Record<string, unknown>,
  stored: Record<string, unknown> | null | undefined,
  mode: CreatedAtWriteMode,
  now: Date = new Date(),
): Response | null {
  if (stored == null) {
    // No stored row: a create, so the server assigns createdAt.
    content.createdAt = now.toISOString();
    return null;
  }
  const storedAt = stored.createdAt;
  if (Object.prototype.hasOwnProperty.call(content, "createdAt") && content.createdAt !== storedAt) {
    return createdAtImmutable();
  }
  if (mode === "replace") content.createdAt = storedAt;
  return null;
}
