/**
 * request-target.ts — the raw request target the auth middleware decides on.
 *
 * Before any other request processing, the middleware answers a target that is not in
 * canonical form with a named 400 (`non_canonical_request_target`). A raw
 * target is canonical unless its path (the part before the first `?`) has:
 *
 *   - a `.` or `..` segment, raw or percent-encoded as a whole segment
 *     (`%2e`, `%2E%2e`, `.%2e`, …);
 *   - repeated slashes (`//`) anywhere in the path;
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
 * The path part of a raw request target: everything before the first `?`.
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
    message: "the request target must be in canonical form: no '.' or '..' path segment, no repeated slashes (`//`), and no backslash",
  });
  return new Response(method === "HEAD" ? null : body, {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The raw path's segments, split on `/` FIRST and still percent-encoded.
 * Empty segments are dropped.
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
 * For a plain one-level resource path, return the first segment and the
 * still-encoded remainder after it, removing one leading slash.
 */
export function routedResourceAndRemainder(path: string): { resource: string; remainder: string } {
  const p = path.startsWith("/") ? path.slice(1) : path;
  const slash = p.indexOf("/");
  if (slash === -1) return { resource: p, remainder: "" };
  return { resource: p.slice(0, slash), remainder: p.slice(slash + 1) };
}

/**
 * Return the resource segment and fully decoded remainder (the initial
 * RequestTarget id for a plain one-level resource path). `parsePath` can change
 * the final row id. Null for an empty, trailing-slash or malformed remainder.
 */
export function routedRecordId(path: string): { resource: string; id: string } | null {
  const { resource, remainder } = routedResourceAndRemainder(path);
  if (remainder === "" || remainder.endsWith("/")) return null;
  let id: string;
  try {
    id = decodeURIComponent(remainder);
  } catch {
    return null;
  }
  if (id === "") return null;
  return { resource, id };
}

/**
 * Return the prefix before the first dot when its suffix is in
 * `declaredAttributes`; otherwise return the id unchanged.
 */
export function routedIdAfterPropertyRule(id: string, declaredAttributes: ReadonlySet<string>): string {
  const dot = id.indexOf(".");
  if (dot > -1 && declaredAttributes.has(id.slice(dot + 1))) return id.slice(0, dot);
  return id;
}

/**
 * Return the first nonempty segment if `isKnown` accepts it, otherwise its
 * prefix before the first dot if accepted, otherwise the segment unchanged.
 */
export function routedFirstResourceName(path: string, isKnown: (name: string) => boolean): string {
  const seg = rawPathSegments(path)[0] ?? "";
  if (isKnown(seg)) return seg;
  const dot = seg.indexOf(".");
  if (dot > -1 && isKnown(seg.slice(0, dot))) return seg.slice(0, dot);
  return seg;
}

/**
 * For a path with one leading slash, return it with the first segment replaced
 * by `routedFirstResourceName`; unchanged when that name does not change.
 */
export function routedResourcePath(path: string, known: ReadonlySet<string>): string {
  const segs = rawPathSegments(path);
  const first = segs[0];
  if (first === undefined) return path;
  const name = routedFirstResourceName(path, (n) => known.has(n));
  if (name === first) return path;
  return `/${name}${path.slice(1 + first.length)}`;
}
