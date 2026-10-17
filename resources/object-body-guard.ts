/**
 * object-body-guard.ts — the shared write-body shape check.
 *
 * `content` must be a non-null, non-array object. Arrays of records are admitted
 * when `allowArrayObjects` is enabled. Anything else reaching this guard is
 * refused with `body_must_be_object` (400).
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
 * Refuse a write body that is neither an object nor an allowed array of records.
 *
 * @param content the parsed request body
 * @param opts    `allowArrayObjects: true` admits arrays of records
 * @returns the 400 `Response` to send, or null to proceed
 */
export function guardObjectBody(content: unknown, opts: { allowArrayObjects?: boolean } = {}): Response | null {
  if (isObjectRecord(content)) return null;
  if (opts.allowArrayObjects && Array.isArray(content) && content.every(isObjectRecord)) return null;
  return bodyMustBeObject();
}
