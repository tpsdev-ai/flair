/**
 * request-target.ts — the raw request target the auth middleware decides on.
 *
 * Harper routes on the request target exactly as the client sent it: its
 * Request.url is the raw target, Request.pathname is everything before the
 * first `?`, and resource matching splits that raw path on `/`. A record id is
 * decoded only after the path has been split, so a percent-encoded `/` (`%2F`)
 * or `\` (`%5C`) inside a segment is part of that one segment — which is how an
 * id containing a reserved character addresses its record.
 *
 * The auth middleware (resources/auth-middleware.ts) reads the same raw path:
 * it splits on `/` FIRST and only then decodes a segment, so what it decides
 * about is exactly what Harper routes.
 *
 * And before any other request processing, it answers a target that is not in
 * canonical form with a named 400 (`non_canonical_request_target`). A raw
 * target is canonical unless its path (the part before the first `?`) has:
 *
 *   - a `.` or `..` segment, raw or percent-encoded as a whole segment
 *     (`%2e`, `%2E%2e`, `.%2e`, …);
 *   - an empty segment: `//` anywhere in the path;
 *   - a raw backslash.
 *
 * Everything else is canonical, including `%2F` and `%5C` inside a segment, a
 * dot inside a segment (`a.b`), and any query string.
 *
 * PURE: string logic only, imports nothing.
 */

/** The named error a non-canonical request target is refused with. */
export const NON_CANONICAL_REQUEST_TARGET_ERROR = "non_canonical_request_target";

/** A whole segment that is `.` or `..`, each dot raw or percent-encoded. */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * The path part of a raw request target: everything before the first `?`,
 * exactly as Harper's own Request.pathname reads it.
 */
export function requestPath(rawTarget: string): string {
  const q = rawTarget.indexOf("?");
  return q === -1 ? rawTarget : rawTarget.slice(0, q);
}

/** True when a raw request target is in canonical form (see the module header). */
export function isCanonicalRequestTarget(rawTarget: string): boolean {
  const path = requestPath(rawTarget);
  if (path.includes("\\")) return false;
  if (path.includes("//")) return false;
  return !path.split("/").some((segment) => DOT_SEGMENT.test(segment));
}

/** The named 400 for a non-canonical request target. HEAD gets no body. */
export function nonCanonicalRequestTargetRefusal(method?: string): Response {
  const body = JSON.stringify({
    error: NON_CANONICAL_REQUEST_TARGET_ERROR,
    message: "the request target must be in canonical form: no '.' or '..' path segment, no empty path segment, and no backslash",
  });
  return new Response(method === "HEAD" ? null : body, {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The raw path's segments, split on `/` FIRST and still percent-encoded.
 * Empty segments are dropped (a canonical path has none but the leading one).
 */
export function rawPathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** The last raw segment of a path (still percent-encoded). */
export function lastRawPathSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Decode one raw path segment; null when it is not valid percent-encoding. */
export function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * The decoded record-id segment of a `/<Collection>/<id>` path: the second raw
 * segment, decoded on its own. Null when there is none, or when it is not valid
 * percent-encoding.
 */
export function recordIdSegment(path: string): string | null {
  const segment = rawPathSegments(path)[1];
  return segment ? decodePathSegment(segment) : null;
}
