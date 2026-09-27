/**
 * record-id-path.ts — the one rule for a record id used as the single dynamic
 * path segment of a `/Memory/<id>` request built inside flair-mcp (flair#1970).
 *
 * Self-contained on purpose: this module must load and typecheck WITHOUT
 * @tpsdev-ai/flair-client's built dist present (the root `bun test` and strict
 * test-suite typecheck lanes run before the client is built), so it does not
 * import the client's own `encodeRecordId` — it states the same rule here.
 */

/**
 * Percent-encode an id so it reaches the server as ONE path segment that
 * decodes back to the id, addressing exactly that record. REFUSES an id that is
 * exactly `.` or `..`: percent-encoding leaves those unchanged and URL
 * normalization collapses `/Memory/.` to `/Memory/` and `/Memory/..` to `/`, so
 * the sent path would not be the id (nor the signed path). Such an id cannot
 * address its record, so it is an error, not a request.
 */
export function encodeRecordId(id: string): string {
  if (id === "." || id === "..") {
    throw new Error(
      `record id ${JSON.stringify(id)} is a URL path dot-segment ("." or ".."); ` +
        `it cannot be addressed as one path segment of /Memory/<id>. Use a different id.`,
    );
  }
  return encodeURIComponent(id);
}

/** The PUT path for a row: its id as ONE percent-encoded path segment. */
export function memoryPutPath(id: string): string {
  return `/Memory/${encodeRecordId(id)}`;
}
