/**
 * object-body-guard.ts — the shared shape check for a table's write body: a
 * write body must be a JSON object, and only the collection form of PUT may be
 * an array of them.
 *
 * A resource's post()/put()/patch() run their other checks against fields of
 * `content` (`content.id`, `content.authorId`, …). A body that is not an object
 * (an array, a string, a number, a boolean, null) has no such fields, so the
 * read, or a later property write, throws — the request answers 500 with an
 * unhandled TypeError instead of a named 4xx, before any other check can run.
 * This guard answers first, so that body-shape mistake is a named 400.
 *
 * The rule: `content` must be a non-null, non-array object. `allowArrayObjects`
 * additionally admits an array whose elements are all such objects — a
 * collection PUT body, which Harper dispatches to the resource one element at a
 * time. Anything else is refused with `body_must_be_object` (400).
 */

export const BODY_MUST_BE_OBJECT_ERROR = "body_must_be_object";

/** True for a write body that is one record: a non-null object that is not an array. */
function isObjectRecord(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 400 for a write body that is neither a JSON object nor an allowed array of them. Echoes nothing. */
export function bodyMustBeObject(): Response {
  return new Response(
    JSON.stringify({
      error: BODY_MUST_BE_OBJECT_ERROR,
      message: "the write body must be a JSON object, or an array of them for a collection write",
    }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Refuse a write body that is not a JSON object.
 *
 * @param content the parsed request body
 * @param opts    `allowArrayObjects: true` on a verb whose collection form takes
 *                an array of records (PUT); the array is admitted only when
 *                every element is an object, so an array of primitives is still
 *                refused
 * @returns the 400 `Response` to send, or null to proceed
 */
export function guardObjectBody(content: unknown, opts: { allowArrayObjects?: boolean } = {}): Response | null {
  if (isObjectRecord(content)) return null;
  if (opts.allowArrayObjects && Array.isArray(content) && content.every(isObjectRecord)) return null;
  return bodyMustBeObject();
}
