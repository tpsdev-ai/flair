/**
 * org-event-created-at.ts — an OrgEvent's createdAt is assigned by the server
 * on create and cannot be changed through the resource's write verbs.
 *
 * The timestamp is server-owned:
 *
 *   - the check reads the stored row under each record's id. A record that is
 *     not an object, or whose id is not a non-empty string or a non-empty
 *     array of strings, is not read: it is refused with `invalid_event_id`
 *     (400) before any write;
 *   - on create, createdAt is the server's time, whatever the body says;
 *   - on update, createdAt keeps its stored value. A body that omits it keeps
 *     the stored value; a write that reaches this check with a createdAt that
 *     differs from the stored one is refused with `created_at_immutable` (409),
 *     and nothing is written. Earlier checks in the resource (authentication,
 *     ownership, attribution, entity validation) answer first.
 *
 * resources/OrgEvent.ts applies this to every write from a verified agent,
 * admin agents included, on POST, PUT (single record, collection, and each
 * element of an array body) and PATCH, so a write that names an id the check
 * does not read is refused on each of them. Trusted in-process writers that supply
 * their own createdAt (the migration ledger, the graph-heal migration) write
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
 * write lands on (`stored` null/undefined = create). Mutates `content`.
 * Returns null to proceed, or the refusal to send.
 */
export function applyServerCreatedAt(
  content: Record<string, unknown>,
  stored: Record<string, unknown> | null | undefined,
  mode: CreatedAtWriteMode,
  now: Date = new Date(),
): Response | null {
  const storedAt = stored?.createdAt;
  if (stored == null || typeof storedAt !== "string" || storedAt === "") {
    // A create, or a stored row with no createdAt to keep: the server assigns it.
    content.createdAt = now.toISOString();
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(content, "createdAt") && content.createdAt !== storedAt) {
    return createdAtImmutable();
  }
  if (mode === "replace") content.createdAt = storedAt;
  return null;
}
