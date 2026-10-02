/**
 * record-id-path.ts — build a request path from a record id (flair#1970).
 *
 * An id is arbitrary data; a URL path segment is not. Interpolating an id raw
 * changes the request: `/` splits it into two segments, `?` and `#` start a
 * query or fragment, `%` is read as an escape, and URL normalization folds a
 * `.` or `..` segment away (RFC 3986 §5.2.4). `encodeURIComponent` keeps the id
 * one segment that decodes back to it — the same rule flair-client has applied
 * since #1969.
 *
 * `.` and `..` are refused rather than sent: no encoding makes them address a
 * record as one segment, because normalization removes them first. A caller
 * gets an error instead of a request to the wrong path.
 */
export function encodeRecordId(id: string): string {
  if (id === "." || id === "..") {
    throw new Error(
      `record id ${JSON.stringify(id)} is a URL path dot-segment ("." or ".."); ` +
        "it cannot be addressed as one path segment. Use a different id.",
    );
  }
  return encodeURIComponent(id);
}

/** `/<collection>/<encoded id>` — the record's own path, one id segment. */
export function recordIdPath(collection: string, id: string): string {
  return `/${collection}/${encodeRecordId(id)}`;
}
