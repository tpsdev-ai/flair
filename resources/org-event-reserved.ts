/**
 * org-event-reserved.ts — the reserved-event contract for OrgEvent writes
 * (flair#2139 slice 3a).
 *
 * Two event kinds and one id prefix belong to the instruction-version
 * appender. The resource's verb guards refuse a client mutation that carries
 * either marker, proposed or already stored: on POST (collection or addressed,
 * including a body with no id), on PUT/PATCH whose body proposes a marker, on a
 * PATCH that would create a row at a reserved addressed id, on addressed
 * DELETE, and on collection PUT/DELETE (any reserved element or selected row
 * refuses the request; the DELETE pre-scan reads id and kind whatever
 * projection the caller asked for). The allow hooks refuse a marker visible in
 * their own arguments: allowCreate/allowUpdate see the proposed records and
 * allowDelete sees the target id prefix, not a stored kind at an ordinary id.
 * Anonymous callers are refused with 401; a malformed POST/PATCH/PUT body is
 * refused 400 by the body-shape guard first. The Harper operations API
 * (raw upsert/delete under admin auth) is the documented exception.
 *
 * The predicate is pure so both the resource guards and the doctor check share
 * one definition. A record is reserved when its `kind` is `soul.changed` or
 * `skill.changed`, or its `id` starts with `instruction-change:`.
 */

import {
  RESERVED_EVENT_ID_PREFIX,
  RESERVED_EVENT_KINDS,
  isReservedEventRecord,
} from "../src/lib/instruction-event-contract.js";

export { RESERVED_EVENT_ID_PREFIX, RESERVED_EVENT_KINDS, isReservedEventRecord };

export const RESERVED_EVENT_ERROR = "reserved_event";
export const RESERVED_EVENT_CHECK_UNAVAILABLE_ERROR = "reserved_event_check_unavailable";

/** 403 for a mutation of a reserved event. Echoes no submitted value. */
export function reservedEventRefusal(): Response {
  return new Response(
    JSON.stringify({
      error: RESERVED_EVENT_ERROR,
      message: "reserved events cannot be written through this API; this write is refused",
    }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * 503 when the stored-record read this guard depends on fails. Unknown evidence
 * never admits a write: the refusal names the failed check.
 */
export function reservedEventCheckUnavailable(err: unknown): Response {
  console.error("org-event-reserved: the stored event could not be read, so the write was refused", { err });
  return new Response(
    JSON.stringify({
      error: RESERVED_EVENT_CHECK_UNAVAILABLE_ERROR,
      message: "the stored event could not be read; the write was refused",
    }),
    { status: 503, headers: { "Content-Type": "application/json" } },
  );
}

/** The stored row under one readable id, or null when there is none. */
export type StoredEventRead = (id: string | string[]) => Promise<unknown>;

/** Whether `id` is a key the stored-record read can address (the shared id rule). */
function readableId(id: unknown): id is string | string[] {
  if (typeof id === "string") return id !== "";
  return Array.isArray(id) && id.length > 0 && id.every((part) => typeof part === "string");
}

/** Refuse a write whose proposed records already carry a reserved marker. */
export function reservedEventProposedRefusal(content: unknown): Response | null {
  const records = Array.isArray(content) ? content : [content];
  for (const record of records) {
    if (isReservedEventRecord(record)) return reservedEventRefusal();
  }
  return null;
}

/**
 * Refuse a write whose proposed records, or the stored rows they land on, are
 * reserved. Iterates the whole body first: any reserved element refuses the
 * request before anything is written. Non-record elements are skipped here; the
 * id and body-shape checks own their own refusals.
 */
export async function reservedEventWriteRefusal(
  content: unknown,
  readStored: StoredEventRead,
): Promise<Response | null> {
  const proposed = reservedEventProposedRefusal(content);
  if (proposed) return proposed;
  const records = Array.isArray(content) ? content : [content];
  for (const record of records) {
    if (record == null || typeof record !== "object" || Array.isArray(record)) continue;
    const id = (record as { id?: unknown }).id;
    if (!readableId(id)) continue;
    let stored: unknown;
    try {
      stored = await readStored(id);
    } catch (err) {
      return reservedEventCheckUnavailable(err);
    }
    if (isReservedEventRecord(stored)) return reservedEventRefusal();
  }
  return null;
}

/** Refuse a write that lands on one already-stored reserved row. */
export async function reservedEventStoredRefusal(
  id: unknown,
  readStored: StoredEventRead,
): Promise<Response | null> {
  if (!readableId(id)) return null;
  let stored: unknown;
  try {
    stored = await readStored(id);
  } catch (err) {
    return reservedEventCheckUnavailable(err);
  }
  return isReservedEventRecord(stored) ? reservedEventRefusal() : null;
}
